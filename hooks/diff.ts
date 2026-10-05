export type FileDiff = { text: string; hidden: number; added: number; removed: number }

type Op = { kind: ' ' | '-' | '+'; line: string }

const CONTEXT = 3
const LCS_CELLS = 400_000
const MAX_LINE = 300

const toLines = (text: string): string[] => {
  if (text === '') {
    return []
  }
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }

  return lines
}

// Code refuses control characters other than tab and newline.
const printable = (line: string): string => {
  const kept = line.replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, '')

  return kept.length > MAX_LINE ? `${kept.slice(0, MAX_LINE)}…` : kept
}

const changes = (before: string[], after: string[]): Op[] => {
  const ops: Op[] = []
  if (before.length * after.length > LCS_CELLS) {
    for (const line of before) ops.push({ kind: '-', line })
    for (const line of after) ops.push({ kind: '+', line })

    return ops
  }

  const width = after.length + 1
  const common = new Uint32Array((before.length + 1) * width)
  const at = (i: number, j: number) => common[i * width + j] ?? 0
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    const removed = before[i]
    const added = after[j]
    if (removed !== undefined && removed === added) {
      ops.push({ kind: ' ', line: removed })
      i += 1
      j += 1
    } else if (removed !== undefined && (added === undefined || at(i + 1, j) >= at(i, j + 1))) {
      ops.push({ kind: '-', line: removed })
      i += 1
    } else if (added !== undefined) {
      ops.push({ kind: '+', line: added })
      j += 1
    }
  }

  return ops
}

/**
 * Unified-diff hunks from `beforeText` to `afterText` with `context` unchanged
 * lines around each change, cut at whole lines to `budget` characters;
 * `hidden` counts the diff lines left out, `added` and `removed` every line
 * the change adds and removes, shown or not.
 */
export const unifiedDiff = (
  beforeText: string,
  afterText: string,
  budget = 8000,
  context = CONTEXT,
): FileDiff => {
  const before = toLines(beforeText)
  const after = toLines(afterText)

  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head += 1
  }
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }

  const middle = changes(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
  )
  if (middle.length === 0) {
    return { text: '', hidden: 0, added: 0, removed: 0 }
  }

  const lead = before.slice(Math.max(0, head - context), head)
  const trail = before.slice(before.length - tail, before.length - tail + context)
  const ops: Op[] = [
    ...lead.map(line => ({ kind: ' ' as const, line })),
    ...middle,
    ...trail.map(line => ({ kind: ' ' as const, line })),
  ]

  const ranges: [from: number, to: number][] = []
  ops.forEach((op, index) => {
    if (op.kind === ' ') {
      return
    }
    const from = Math.max(0, index - context)
    const to = Math.min(ops.length, index + context + 1)
    const last = ranges.at(-1)
    if (last !== undefined && from <= last[1]) {
      last[1] = to
    } else {
      ranges.push([from, to])
    }
  })

  const rows: string[] = []
  let used = 0
  let hidden = 0
  let cursor = 0
  let oldLine = head - lead.length
  let newLine = head - lead.length
  for (const [from, to] of ranges) {
    for (const op of ops.slice(cursor, from)) {
      oldLine += op.kind === '+' ? 0 : 1
      newLine += op.kind === '-' ? 0 : 1
    }
    cursor = from

    const body: string[] = []
    let olds = 0
    let news = 0
    for (const op of ops.slice(from, to)) {
      const row = `${op.kind}${printable(op.line)}`
      if (used + row.length + 1 > budget) {
        break
      }
      body.push(row)
      used += row.length + 1
      olds += op.kind === '+' ? 0 : 1
      news += op.kind === '-' ? 0 : 1
    }
    hidden += to - from - body.length
    if (body.length === 0) {
      continue
    }

    rows.push(
      `@@ -${olds === 0 ? oldLine : oldLine + 1},${olds} +${news === 0 ? newLine : newLine + 1},${news} @@`,
      ...body,
    )
  }

  return {
    text: rows.join('\n'),
    hidden,
    added: middle.filter(op => op.kind === '+').length,
    removed: middle.filter(op => op.kind === '-').length,
  }
}

export type Chunk = { path: string; diff: string; added: number; removed: number }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * A `git diff` as chunks to review one at a time: each a hunk of one file, cut
 * once it holds `limit` changed lines. Lines that replace removed ones stay
 * with them, up to twice the limit. A file git shows no text for is one chunk
 * with no diff.
 */
export const chunksOf = (patch: string, limit: number): Chunk[] => {
  const chunks: Chunk[] = []
  let path = ''
  let rows: string[] = []
  let isInHunk = false
  let isReplacing = false
  let oldAt = 0
  let newAt = 0
  let olds = 0
  let news = 0
  let added = 0
  let removed = 0
  const flush = () => {
    if (added + removed > 0) {
      const header = `@@ -${olds === 0 ? oldAt : oldAt + 1},${olds} +${news === 0 ? newAt : newAt + 1},${news} @@`
      chunks.push({ path, diff: [header, ...rows].join('\n'), added, removed })
    }
    oldAt += olds
    newAt += news
    rows = []
    olds = 0
    news = 0
    added = 0
    removed = 0
  }

  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line)
    if (line.startsWith('diff --git ')) {
      flush()
      isInHunk = false
      path = line.slice(line.lastIndexOf(' b/') + 3)
    } else if (hunk !== null) {
      flush()
      isInHunk = true
      const [, oldStart = '0', oldCount = '1', newStart = '0', newCount = '1'] = hunk
      oldAt = Number(oldCount) === 0 ? Number(oldStart) : Number(oldStart) - 1
      newAt = Number(newCount) === 0 ? Number(newStart) : Number(newStart) - 1
    } else if (!isInHunk) {
      if (line.startsWith('+++ b/')) {
        path = line.slice(6)
      } else if (line.startsWith('Binary files ')) {
        chunks.push({ path, diff: '', added: 0, removed: 0 })
      }
    } else if (line.startsWith('\\')) {
      rows.push(line)
    } else if (line !== '') {
      const kind = line.charAt(0)
      const changed = added + removed
      if (changed >= limit * 2 || (changed >= limit && !(isReplacing && kind === '+'))) {
        flush()
      }
      isReplacing = kind === '-' || (isReplacing && kind === '+')
      rows.push(`${kind}${printable(line.slice(1))}`)
      olds += kind === '+' ? 0 : 1
      news += kind === '-' ? 0 : 1
      added += kind === '+' ? 1 : 0
      removed += kind === '-' ? 1 : 0
    }
  }
  flush()

  return chunks
}

/**
 * `content` as the Edit tool would leave it, or undefined when `oldText` is
 * not in it.
 */
export const applyEdit = (
  content: string,
  oldText: string,
  newText: string,
  isReplaceAll: boolean,
): string | undefined => {
  if (oldText === '') {
    return newText + content
  }
  const index = content.indexOf(oldText)
  if (index === -1) {
    return undefined
  }

  return isReplaceAll
    ? content.split(oldText).join(newText)
    : content.slice(0, index) + newText + content.slice(index + oldText.length)
}
