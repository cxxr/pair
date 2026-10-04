import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { PairEntry, PairNotebook, PairPendingEdit } from '../types'
import { applyEdit, unifiedDiff } from './diff'
import type { FileDiff } from './diff'

type Decision = 'approve' | 'discuss' | 'skip' | 'split' | 'talk' | 'release'
// A refusal, or leave to run the edit: with a note when the user approved it,
// with none where the review does not apply.
type Verdict = { deny: string } | { note?: string }
type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>
// A held file as it stands (null when it does not exist yet) and as the edit
// would leave it, with the note its review carries.
type Whole = { before: string | null; after: string; note: string }
// What the review draws; `whole` is absent when the edit's target was not found.
type Described = { text: string; note: string; whole?: Whole }
type HeldCall = Pick<PairPendingEdit, 'id' | 'tool' | 'path'> & {
  describe: () => Promise<Described>
}
type GateActions = {
  choose: (id: string, decision: Decision) => void
  viewFile: (id: string) => Promise<void>
  toggleContext: (id: string) => Promise<void>
}
type NotebookRequest = {
  action: 'decided' | 'open' | 'resolve' | 'edit' | 'remove' | 'clear' | 'list'
  id?: number
  text?: string
}

const GATE = 'pair-gate'
const BOOK = 'pair-notebook'
const TICK_MS = 2000
const NARROW_COLUMNS = 80
const BAND_ROWS_PER_KIND = 2
const WIDE_CONTEXT = 20
const WIDE_COLUMNS = 120
// Tried in order: the launcher on PATH, then the one inside the macOS app.
const VS_CODE = ['code', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code']
const SKILL = 'skills/collaborate/SKILL.md'
const modNote = () => [
  'The `pair` mod is on in this session.',
  'Every Edit and Write is held until the user approves it beside its diff.',
  'Before each Edit or Write, call mcp__pair__explain_edit with the file path and one plain-language sentence on what the change does and why.',
  'If the user chooses Discuss, explain your reasoning and wait for their reply; if they choose Skip, drop the edit; if they choose Split, send it again as smaller steps.',
  `Keep each Edit or Write to about ${maxLines} changed lines and one idea, in steps that each leave the code working; a new file may be longer.`,
  'Record what you both decide, and what is still open, with mcp__pair__notebook.',
].join(' ')
const HOLD_FAILED =
  'pair: the review hold failed, so this edit was not applied. Tell the user; they can run /pair off to edit without review.'
const APPROVED_NOTE = 'pair: the user approved this edit in the review.'
// The instructions go to Claude once a session, so these say when they apply.
const OFF_NOTE =
  'pair: the user turned pair mode off. Work as you normally would, without the collaborate instructions or the pair rules, until they turn it on again.'
const ON_NOTE = 'pair: the user turned pair mode on. The collaborate instructions and the pair rules apply.'
// How many changed lines one edit should stay under: the `maxReviewLines` setting.
let maxLines = 40

const isOn = atom({ plugin: 'pair', key: 'isOn' } as const, true)
const notebook = atom({ plugin: 'pair', key: 'notebook' } as const, { nextId: 1, entries: [] })
const pending = atom({ plugin: 'pair', key: 'pending' } as const, [])
const isGateInBand = atom({ plugin: 'pair', key: 'isGateInBand' } as const, false)
const hasSentInstructions = atom({ plugin: 'pair', key: 'hasSentInstructions' } as const, false)
const explanations = atom({ plugin: 'pair', key: 'explanations' } as const, {})
const tick = { plugin: 'pair', key: 'tick' } as const

const stripFrontmatter = (text: string): string =>
  text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '').trim()

// The person's own copy of the skill wins over the one this plugin ships;
// whichever is found is read when the instructions are sent.
const skillPaths = async ($: EngineInterface): Promise<string[]> => [
  `${(await $.env.get('HOME')) ?? ''}/.claude/${SKILL}`,
  `${$.plugin.root}/${SKILL}`,
]

const loadSkill = async ($: EngineInterface): Promise<{ path: string; body: string } | undefined> => {
  for (const path of await skillPaths($)) {
    if (await $.fs.exists(path)) {
      return { path, body: stripFrontmatter(await $.fs.read(path)) }
    }
  }

  return undefined
}

const readOrNull = async ($: EngineInterface, path: string): Promise<string | null> => {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : null
  } catch {
    return null
  }
}

const withNotes = (diff: FileDiff, note: string, isNewFile = false): FileDiff & { note: string } => ({
  ...diff,
  note: [
    `+${diff.added} -${diff.removed} lines.`,
    !isNewFile && diff.added + diff.removed > maxLines
      ? `Over your ${maxLines}-line target: Split sends it back to be broken up.`
      : '',
    note,
    diff.hidden > 0 ? `${diff.hidden} more diff lines not shown.` : '',
  ]
    .filter(part => part !== '')
    .join(' '),
})

const drawn = (whole: Whole, isWide: boolean): Described => ({
  ...withNotes(
    unifiedDiff(whole.before ?? '', whole.after, undefined, isWide ? WIDE_CONTEXT : undefined),
    whole.note,
    whole.before === null,
  ),
  whole,
})

const describeEdit = async (
  $: EngineInterface,
  path: string,
  oldText: string,
  newText: string,
  isReplaceAll: boolean,
): Promise<Described> => {
  const before = await readOrNull($, path)
  const after = before === null ? undefined : applyEdit(before, oldText, newText, isReplaceAll)
  if (before === null || after === undefined) {
    return withNotes(
      unifiedDiff(oldText, newText),
      'The text to replace was not found in the file, so only the replacement is shown.',
    )
  }
  const matches = oldText === '' ? 1 : before.split(oldText).length - 1

  return drawn(
    { before, after, note: isReplaceAll && matches > 1 ? `Replaces all ${matches} matches.` : '' },
    false,
  )
}

const describeWrite = async ($: EngineInterface, path: string, content: string) => {
  const before = await readOrNull($, path)

  return drawn({ before, after: content, note: before === null ? 'New file.' : '' }, false)
}

const ofKind = (book: PairNotebook, kind: PairEntry['kind']) =>
  book.entries.filter(entry => entry.kind === kind)

const formatBook = (book: PairNotebook): string => {
  const section = (title: string, entries: PairEntry[]) =>
    [title, ...(entries.length === 0 ? ['  (none)'] : entries.map(entry => `  #${entry.id} ${entry.text}`))].join('\n')

  return `${section('Decided', ofKind(book, 'decided'))}\n${section('Open questions', ofKind(book, 'open'))}`
}

const changeNotebook = async ($: EngineInterface, request: NotebookRequest): Promise<string> => {
  const { action, id } = request
  const text = request.text?.trim() ?? ''
  if (action === 'list') {
    return formatBook(await read($, notebook))
  }
  if (action === 'clear') {
    return formatBook(await update($, notebook, book => ({ ...book, entries: [] })))
  }
  if (action === 'decided' || action === 'open') {
    if (text === '') {
      return 'pair: an entry needs text.'
    }

    return formatBook(
      await update($, notebook, book => ({
        nextId: book.nextId + 1,
        entries: [...book.entries, { id: book.nextId, kind: action, text }],
      })),
    )
  }

  const target = (await read($, notebook)).entries.find(entry => entry.id === id)
  if (target === undefined) {
    return `pair: no notebook entry #${id ?? '?'}.\n${formatBook(await read($, notebook))}`
  }
  if (action === 'edit' && text === '') {
    return 'pair: an edit needs the new text.'
  }
  const changed: PairEntry | undefined =
    action === 'remove'
      ? undefined
      : action === 'edit'
        ? { ...target, text }
        : { ...target, kind: 'decided', text: text === '' ? target.text : `${target.text} → ${text}` }

  return formatBook(
    await update($, notebook, book => ({
      ...book,
      entries: book.entries.flatMap(entry => (entry.id !== target.id ? [entry] : changed ? [changed] : [])),
    })),
  )
}

const parseNotebookCommand = (args: string): NotebookRequest | undefined => {
  const [word = '', ...rest] = args.trim().split(/\s+/)
  const numbered = { id: Number((rest[0] ?? '').replace(/^#/, '')), text: rest.slice(1).join(' ') }
  switch (word) {
    case 'decided':
    case 'open':
      return { action: word, text: rest.join(' ') }
    case 'resolve':
    case 'edit':
    case 'remove':
      return { action: word, ...numbered }
    case 'clear':
      return { action: 'clear' }
    default:
      return undefined
  }
}

const gateTree = (
  { Box, Text, Button, Code }: Kit,
  head: PairPendingEdit,
  waiting: number,
  hint: string,
  actions: GateActions,
) => (
  <Box flexDirection="column">
    <Box gap={1}>
      <Text bold>{head.tool}</Text>
      <Button key="file" plain label={head.path} onPress={() => actions.viewFile(head.id)} />
    </Box>
    <Text>{head.why}</Text>
    {head.note !== '' && <Text dimColor>{head.note}</Text>}
    {head.diff === '' ? (
      <Text dimColor>No change to the file's text.</Text>
    ) : (
      <Code source={head.diff} format="diff" path={head.path} />
    )}
    <Box gap={3}>
      <Button key="approve" hotkey="1" plain label="Approve" onPress={() => actions.choose(head.id, 'approve')} />
      <Button key="discuss" hotkey="2" plain label="Discuss" onPress={() => actions.choose(head.id, 'discuss')} />
      <Button key="skip" hotkey="3" plain label="Skip" onPress={() => actions.choose(head.id, 'skip')} />
    </Box>
    <Box gap={3}>
      <Button
        key="context"
        hotkey="4"
        plain
        label={head.isWide ? 'Narrow view' : 'Wide view'}
        onPress={() => actions.toggleContext(head.id)}
      />
      <Button key="whole" hotkey="5" plain label="Whole file" onPress={() => actions.viewFile(head.id)} />
      <Button key="split" hotkey="6" plain label="Split" onPress={() => actions.choose(head.id, 'split')} />
    </Box>
    <Text dimColor>
      {hint}
      {waiting > 0 ? ` ${waiting} more edit${waiting === 1 ? '' : 's'} waiting.` : ''}
    </Text>
  </Box>
)

const bandTree = ({ Box, Text }: Kit, book: PairNotebook, columns: number) => {
  const decided = ofKind(book, 'decided')
  const open = ofKind(book, 'open')
  const counts = `Notebook: ${decided.length} decided, ${open.length} open`
  if (columns < NARROW_COLUMNS) {
    return <Text dimColor>{counts} (/notebook)</Text>
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{counts} (/notebook shows all)</Text>
      {decided.slice(-BAND_ROWS_PER_KIND).map(entry => (
        <Text wrap="truncate-end">✓ {entry.text}</Text>
      ))}
      {open.slice(-BAND_ROWS_PER_KIND).map(entry => (
        <Text wrap="truncate-end">? {entry.text}</Text>
      ))}
    </Box>
  )
}

// The wake signal of a hold is the module's own, not `$.state`: a hold is one
// running hook, which a reload ends with the module that ran it.
const decisions = new Map<string, Decision>()
const held = new Set<string>()
const wholes = new Map<string, Whole>()
let waker = new AbortController()

const wake = () => {
  waker.abort()
  waker = new AbortController()
}

const choose = (id: string, decision: Decision) => {
  if (held.has(id) && !decisions.has(id)) {
    decisions.set(id, decision)
    wake()
  }
}

const showGate = async ($: EngineInterface, columns?: number) => {
  const opened = await $.ui.open({
    id: GATE,
    title: 'Pair: review edit',
    focus: true,
    closeOnEscape: true,
    ...(columns === undefined ? {} : { columns }),
  })
  // A pane opened unasked stays undrawn on a narrow terminal: the band
  // above the prompt draws the review instead.
  if (!opened.isPlaced) {
    await $.ui.close({ id: GATE })
  }
  await update($, isGateInBand, () => !opened.isPlaced)
}

// Where the proposed copies VS Code compares are kept: one folder a session,
// one beneath it for each held edit.
const copiesDir = async ($: EngineInterface, id?: string): Promise<string> => {
  const temp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const session = `${temp}/pair-review-${await $.session.id()}`

  return id === undefined ? session : `${session}/${id.replace(/[^\w-]/g, '_')}`
}

const removeCopies = async ($: EngineInterface, id?: string) => {
  const dir = await copiesDir($, id)
  if (await $.fs.exists(dir)) {
    await $.process.run(['rm', '-rf', dir])
  }
}

const viewFile = async ($: EngineInterface, id: string) => {
  const whole = wholes.get(id)
  const entry = (await read($, pending)).find(one => one.id === id)
  if (whole === undefined || entry === undefined) {
    $.ui.toast('pair: no whole-file view for this edit')

    return
  }
  try {
    const dir = await copiesDir($, id)
    const name = entry.path.split('/').at(-1) ?? 'file'
    const copy = (tag: string) => `${dir}/${name.replace(/(\.[^.]*)?$/, `.${tag}$1`)}`
    await $.process.run(['mkdir', '-m', '700', '-p', await copiesDir($)])
    await $.fs.write(copy('proposed'), whole.after)
    if (whole.before === null) {
      await $.fs.write(copy('before'), '')
    }
    const current = whole.before === null ? copy('before') : entry.path
    for (const code of VS_CODE) {
      const ran = await $.process.run([code, '--diff', current, copy('proposed')]).catch(() => undefined)
      if (ran?.exitCode === 0) {
        return
      }
    }
    $.ui.toast('pair: could not start VS Code')
  } catch {
    $.ui.toast('pair: could not prepare the whole-file view')
  }
}

const toggleContext = async ($: EngineInterface, id: string) => {
  const whole = wholes.get(id)
  if (whole === undefined) {
    $.ui.toast('pair: no more context for this edit')

    return
  }
  const queue = await update($, pending, list =>
    list.map(one => {
      if (one.id !== id) {
        return one
      }
      const { text, note } = drawn(whole, !one.isWide)

      return { ...one, isWide: !one.isWide, diff: text, note }
    }),
  )
  if (!(await read($, isGateInBand))) {
    await showGate($, queue.find(one => one.id === id)?.isWide === true ? WIDE_COLUMNS : undefined)
  }
}

const actionsFor = ($: EngineInterface): GateActions => ({
  choose,
  viewFile: id => viewFile($, id),
  toggleContext: id => toggleContext($, id),
})

const review = async (
  $: EngineInterface,
  signal: AbortSignal,
  call: HeldCall,
): Promise<Verdict> => {
  if (!(await read($, isOn)) || (await $.session.surfaces()).length === 0) {
    return {}
  }
  const why = (await read($, explanations))[call.path]
  if (why === undefined) {
    return {
      deny: `pair: the user reviews every edit. First call mcp__pair__explain_edit with file_path "${call.path}" and one plain-language sentence on what this change does and why, then make this same ${call.tool} call again.`,
    }
  }
  await update($, explanations, ({ [call.path]: _used, ...rest }) => rest)

  const { text: diff, note, whole } = await call.describe()
  const entry: PairPendingEdit = { id: call.id, tool: call.tool, path: call.path, why, diff, note, isWide: false }
  held.add(call.id)
  if (whole !== undefined) {
    wholes.set(call.id, whole)
  }
  try {
    const queue = await update($, pending, list => [...list, entry])
    if (queue[0]?.id === call.id) {
      await showGate($)
    }
    // A hook's own wait is cut off after ten seconds and the call then runs
    // unreviewed. Time inside a `$` call is not counted, so the hold waits
    // in the `state.get` hook below, one tick at a time.
    while (!decisions.has(call.id) && !signal.aborted) {
      await $.state.get(tick)
    }
  } finally {
    held.delete(call.id)
    wholes.delete(call.id)
    // A copy that cannot be removed must not undo the user's decision.
    await removeCopies($, call.id).catch(() => undefined)
    const rest = await update($, pending, list => list.filter(one => one.id !== call.id))
    if (rest.length === 0) {
      await $.ui.close({ id: GATE })
    } else {
      await showGate($)
    }
  }

  const decision = decisions.get(call.id)
  decisions.delete(call.id)
  switch (decision) {
    case 'approve':
      return { note: APPROVED_NOTE }
    case 'release':
      return {}
    case 'discuss':
      return {
        deny: `pair: the user chose Discuss on this ${call.tool} to ${call.path}. It was not applied. The user wants to talk about it first: explain your reasoning for this change in plain language, then stop and wait for their reply. Do not retry it or rework it silently.`,
      }
    case 'skip':
      return {
        deny: `pair: the user chose Skip on this ${call.tool} to ${call.path}. It was not applied. Drop this edit and do not retry it.`,
      }
    case 'split':
      return {
        deny: `pair: the user chose Split on this ${call.tool} to ${call.path}. It was not applied. Break this change into smaller steps of about ${maxLines} changed lines, one idea each, each leaving the code working. Say the plan in a sentence or two, then send the first step.`,
      }
    case 'talk':
      return {
        deny: `pair: the user closed the review of this ${call.tool} to ${call.path} to talk about it in the main chat. It was not applied. Stop and wait for their message. Do not retry it or rework it silently.`,
      }
    default:
      return {
        deny: `pair: the turn was interrupted while this ${call.tool} to ${call.path} was held. It was not applied.`,
      }
  }
}

export const register: Register = (on, options) => {
  if (typeof options.maxReviewLines === 'number' && options.maxReviewLines >= 1) {
    maxLines = Math.floor(options.maxReviewLines)
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pair',
      description: 'Turn pairing mode on or off: the edit review and the collaborate instructions',
      argumentHint: '[on|off|status]',
      immediate: true,
    })
    await $.command.register({
      name: 'notebook',
      description: 'Show the shared notebook, or add and edit its entries',
      argumentHint: '[decided|open <text> | resolve|edit <id> <text> | remove <id> | clear]',
      immediate: true,
    })
    await $.tool.register({
      name: 'notebook',
      description:
        'The notebook you share with the user: what the two of you have decided and which questions are still open. Add an entry when you agree on something or a question comes up, and resolve an open question once it is answered. The user sees the notebook above their prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add_decided', 'add_open', 'resolve', 'list'],
            description:
              'add_decided and add_open add `text`; resolve moves open question `id` to Decided, with `text` as the answer; list returns the notebook.',
          },
          text: { type: 'string', description: 'The entry, or the answer to a resolved question.' },
          id: { type: 'integer', description: 'The entry number shown as #id.' },
        },
        required: ['action'],
      },
    })
    await $.tool.register({
      name: 'explain_edit',
      description:
        'Call before each Edit or Write while the pair mod is on: one plain-language sentence on what the change does and why. The user reads it beside the diff when the edit is held for their review.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The file_path the Edit or Write will name.' },
          summary: { type: 'string', description: 'What the change does and why, in plain language.' },
        },
        required: ['file_path', 'summary'],
      },
    })
    // No hold outlives the module that ran it.
    await update($, pending, () => [])
    await $.ui.close({ id: GATE })
    await removeCopies($).catch(() => undefined)

    return next(e)
  })

  on('state.get', { plugin: 'pair', key: 'tick' }, async ($, e, next) => {
    try {
      await $.clock.sleep(TICK_MS, { signal: waker.signal })
    } catch {
      // Woken by a decision.
    }

    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const verdict = await review($, next.signal, {
      id: e.tool_use_id,
      tool: 'Edit',
      path: e.file_path,
      describe: () => describeEdit($, e.file_path, e.old_string, e.new_string, e.replace_all === true),
    })
    if ('deny' in verdict) {
      return { deny: verdict.deny }
    }
    const ran = await next(e)

    return verdict.note === undefined || ran.deny !== undefined
      ? ran
      : { ...ran, context: [...(ran.context ?? []), verdict.note] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: HOLD_FAILED }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const verdict = await review($, next.signal, {
      id: e.tool_use_id,
      tool: 'Write',
      path: e.file_path,
      describe: () => describeWrite($, e.file_path, e.content),
    })
    if ('deny' in verdict) {
      return { deny: verdict.deny }
    }
    const ran = await next(e)

    return verdict.note === undefined || ran.deny !== undefined
      ? ran
      : { ...ran, context: [...(ran.context ?? []), verdict.note] }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: HOLD_FAILED }))

  on('ui.close', { id: GATE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') {
      const [head] = await read($, pending)
      if (head !== undefined) {
        choose(head.id, 'talk')
      }
    }

    return closed
  })

  on('tool.check', { tool: 'mcp__pair__notebook' }, () => ({ decision: 'allow' }))
  on('tool.check', { tool: 'mcp__pair__explain_edit' }, () => ({ decision: 'allow' }))

  on('tool.call', { tool: 'mcp__pair__notebook' }, async ($, e) => {
    const input = e as unknown as { action?: unknown; text?: unknown; id?: unknown }
    const actions = { add_decided: 'decided', add_open: 'open', resolve: 'resolve', list: 'list' } as const
    const action = actions[String(input.action) as keyof typeof actions]
    if (action === undefined) {
      return { result: 'pair: action must be add_decided, add_open, resolve or list.' }
    }

    return {
      result: await changeNotebook($, {
        action,
        id: typeof input.id === 'number' ? input.id : undefined,
        text: typeof input.text === 'string' ? input.text : undefined,
      }),
    }
  })

  on('tool.call', { tool: 'mcp__pair__explain_edit' }, async ($, e) => {
    const input = e as unknown as { file_path?: unknown; summary?: unknown }
    const path = typeof input.file_path === 'string' ? input.file_path : ''
    const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
    if (path === '' || summary === '') {
      return { result: 'pair: explain_edit needs file_path and summary.' }
    }
    await update($, explanations, all => ({ ...all, [path]: summary }))

    return { result: `Recorded. Now make the edit to ${path}; the user will review it.` }
  })

  on('command.run', { command: 'pair' }, async ($, e) => {
    const word = e.args.trim().toLowerCase()
    const skill = await loadSkill($)
    const skillLine =
      skill === undefined
        ? `No collaborate skill found (looked for ${(await skillPaths($)).join(' and ')}), so only the mod's own note goes to Claude.`
        : `The instructions in ${skill.path} go to Claude once a session, with your first prompt.`
    if (word === 'status') {
      return {
        text: (await read($, isOn))
          ? `Pair mode is on. Edit and Write wait for your review. ${skillLine}`
          : 'Pair mode is off.',
      }
    }
    if (word !== '' && word !== 'on' && word !== 'off') {
      return { text: 'Usage: /pair [on|off|status]' }
    }

    const isNowOn = await update($, isOn, was => (word === '' ? !was : word === 'on'))
    if (!isNowOn) {
      for (const id of held) {
        choose(id, 'release')
      }
      $.ui.status(undefined)

      return { text: 'Pair mode is off. Edits run without review.', context: [OFF_NOTE] }
    }

    return { text: `Pair mode is on. Edit and Write wait for your review. ${skillLine}`, context: [ON_NOTE] }
  })

  on('command.run', { command: 'notebook' }, async ($, e) => {
    if (e.args.trim() === '') {
      await $.ui.open({ id: BOOK, title: 'Notebook' })

      return { text: formatBook(await read($, notebook)) }
    }
    const request = parseNotebookCommand(e.args)
    if (request === undefined) {
      return {
        text: 'Usage: /notebook | decided <text> | open <text> | resolve <id> [answer] | edit <id> <text> | remove <id> | clear',
      }
    }

    return { text: await changeNotebook($, request) }
  })

  // A compaction or a /clear takes the instructions out of the conversation,
  // so the next prompt carries them again.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (done.skip === undefined && e.trigger !== 'precompute' && e.agentId === undefined) {
      await update($, hasSentInstructions, () => false)
    }

    return done
  })

  on('session.end', async ($, e, next) => {
    await update($, hasSentInstructions, () => false)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isPersons = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    // Once a session: sent with every prompt, the copies pile up in the conversation.
    if (!isPersons || !(await read($, isOn)) || (await read($, hasSentInstructions))) {
      return next(e)
    }
    const skill = await loadSkill($)
    $.ui.status(skill === undefined ? 'pair: collaborate skill not found (/pair status)' : undefined)
    const instructions = skill === undefined ? modNote() : `${skill.body}\n\n${modNote()}`
    const entered = await next({ ...e, context: [...(e.context ?? []), instructions] })
    if (entered.drop === undefined) {
      await update($, hasSentInstructions, () => true)
    }

    return entered
  })

  on('ui.render', { component: 'Pane', requestId: GATE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const [head, ...rest] = await read($, pending)
    if (head === undefined) {
      return <kit.Text dimColor>No edit is waiting for review.</kit.Text>
    }

    return gateTree(kit, head, rest.length, 'Esc: not applied, talk in the chat.', actionsFor($))
  })

  on('ui.render', { component: 'Pane', requestId: BOOK }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const book = await read($, notebook)
    const section = (title: string, entries: PairEntry[]) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{title}</Text>
        {entries.length === 0 && <Text dimColor>(none)</Text>}
        {entries.map(entry => (
          <Text>
            #{String(entry.id)} {entry.text}
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {section('Decided', ofKind(book, 'decided'))}
        {section('Open questions', ofKind(book, 'open'))}
        <Text dimColor>/notebook decided|open &lt;text&gt;, resolve|edit &lt;id&gt; &lt;text&gt;, remove &lt;id&gt;</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) {
      return next(e)
    }
    const kit = $.ui.resolve(e)
    const [head, ...rest] = await read($, pending)
    if (head !== undefined && (await read($, isGateInBand))) {
      return gateTree(kit, head, rest.length, 'Shown here because the pane does not fit.', actionsFor($))
    }
    const book = await read($, notebook)

    return book.entries.length === 0 ? next(e) : bandTree(kit, book, e.props.bodyColumns)
  })
}
