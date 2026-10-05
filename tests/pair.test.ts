import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { applyEdit, chunksOf, unifiedDiff } from '../hooks/diff'

const HOME = '/home/dev'
const SKILL_PATH = `${HOME}/.claude/skills/collaborate/SKILL.md`
const SKILL_TEXT = '---\nname: collaborate\ndescription: Pair up.\n---\n\n# Collaborate\n\nYou and the user are peers.\n'
const FILE = '/work/a.ts'
const GATE = 'pair-gate'
const VS_CODE_APP = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
const PANE = {
  title: 'Pair: review edit',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const
const band = (bodyColumns: number) => ({
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
})

// The engine beneath the mod: files, a terminal, and tools and programs that
// record what ran. `code` on PATH fails, so the launcher inside the app is used.
const world = (
  on: On,
  initial: Record<string, string>,
  isPanePlaced = true,
  programs?: (argv: readonly string[]) => { exitCode?: number; stdout?: string } | undefined,
) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME, TMPDIR: '/tmp/t/' })
  const files = { ...initial }
  const ran: Record<string, unknown>[] = []
  const prompts: { text: string; context?: readonly string[] }[] = []
  const commands: (readonly string[])[] = []
  const opened: { columns?: number }[] = []
  const asked: string[] = []
  on('fs.exists', (_$, e) => {
    asked.push(e.path)

    return { value: e.path in files || Object.keys(files).some(path => path.startsWith(`${e.path}/`)) }
  })
  on('fs.read', (_$, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path] = e.text

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    commands.push(e.argv)
    const [program, , target = ''] = e.argv
    if (program === 'rm') {
      for (const path of Object.keys(files).filter(path => path.startsWith(`${target}/`))) {
        delete files[path]
      }
    }

    const answer = programs?.(e.argv)

    return {
      value: {
        exitCode: answer?.exitCode ?? (program === 'code' ? 127 : 0),
        stdout: answer?.stdout ?? '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('session.id', () => ({ value: 'sess' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('ui.open', (_$, e) => {
    opened.push({ columns: e.columns })

    return { value: isPanePlaced ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', (_$, e) => {
    ran.push({ ...e })

    return { result: 'ran' as never }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push({ text: e.text, context: e.context })

    return { text: e.text, context: e.context }
  })

  return { clock, ran, prompts, files, commands, opened, asked }
}

const explain = ($: Engine, path: string, summary: string) =>
  $.tool.call({ tool: 'mcp__pair__explain_edit', file_path: path, summary } as never)

const notebookTool = ($: Engine, input: Record<string, unknown>) =>
  $.tool.call({ tool: 'mcp__pair__notebook', ...input } as never)

const command = ($: Engine, name: string, args = '') =>
  $.command.run({
    command: name,
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

const submit = ($: Engine, text: string, kind: 'composer' | 'task-notification' = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind } })

// Where the mod looks for the skill it ships, read off what `/pair status` asks for.
const shippedSkillPath = async ($: Engine, asked: string[]) => {
  await command($, 'pair', 'status')

  return asked.find(path => path.endsWith('/skills/collaborate/SKILL.md') && !path.startsWith(HOME)) ?? ''
}

const gatePane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'pair', surface, component: 'Pane', requestId: GATE, props: PANE })

const heldEdit = async ($: Engine, clock: ReturnType<typeof mock.clock>) => {
  await explain($, FILE, 'Renames a to count so the loop reads clearly.')
  const call = $.tool.call({
    tool: 'Edit',
    file_path: FILE,
    old_string: 'const a = 1',
    new_string: 'const count = 1',
  })
  let outcome: unknown = 'held'
  void call.then(settled => {
    outcome = settled
  })
  await clock.settle()

  return { call, outcome: () => outcome }
}

const SOURCE = { [FILE]: 'import x from "x"\nconst a = 1\nconst b = 2\n' }

describe('edit gate', () => {
  test('holds an edit and shows its path, the reason and the diff on each surface', async ($, on) => {
    const { clock, ran } = world(on, SOURCE)
    const { outcome } = await heldEdit($, clock)

    expect(outcome()).toBe('held')
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(0)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await gatePane($, surface)
      expect((await ui.find({ type: 'Button', key: 'file' }))?.text).toBe(FILE)
      expect(await ui.find({ type: 'Text', text: /Renames a to count/ })).toBeDefined()
      const code = await ui.find({ type: 'Code' })
      expect(code?.props.format).toBe('diff')
      expect(code?.text).toContain('@@ -1,3 +1,3 @@')
      expect(code?.text).toContain('-const a = 1')
      expect(code?.text).toContain('+const count = 1')
      const buttons = await ui.findAll({ type: 'Button' })
      expect(buttons.map(button => [button.props.hotkey, button.props.label])).toEqual([
        [undefined, FILE],
        ['1', 'Approve'],
        ['2', 'Discuss'],
        ['3', 'Skip'],
        ['4', 'Wide view'],
        ['5', 'Whole file'],
        ['6', 'Split'],
      ])
      await ui.unmount()
    }

    const ui = await gatePane($)
    await ui.press({ key: 'skip' })
  })

  test('Approve runs the edit as written', async ($, on) => {
    const { clock, ran } = world(on, SOURCE)
    const { call } = await heldEdit($, clock)

    const ui = await gatePane($)
    await ui.press({ key: 'approve' })

    expect(await call).toMatchObject({
      result: 'ran',
      context: ['pair: the user approved this edit in the review.'],
    })
    expect(ran.filter(e => e.tool === 'Edit')).toMatchObject([
      { file_path: FILE, old_string: 'const a = 1', new_string: 'const count = 1' },
    ])
  })

  test('Discuss refuses the edit and tells Claude to explain and wait', async ($, on) => {
    const { clock, ran } = world(on, SOURCE)
    const { call } = await heldEdit($, clock)

    const ui = await gatePane($)
    await ui.press({ key: 'discuss' })

    const answer = await call
    expect(answer.deny).toMatch(/chose Discuss/)
    expect(answer.deny).toMatch(/wait for their reply/)
    expect(answer.deny).toMatch(/Do not retry it or rework it silently/)
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(0)
  })

  test('Skip refuses the edit and tells Claude to drop it', async ($, on) => {
    const { clock, ran } = world(on, SOURCE)
    const { call } = await heldEdit($, clock)

    const ui = await gatePane($)
    await ui.press({ key: 'skip' })

    expect((await call).deny).toMatch(/chose Skip.*Drop this edit/)
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(0)
  })

  test('a hold outlasts the ten-second hook budget without letting the edit through', { timeoutMs: 30_000 }, async ($, on) => {
    const { clock, ran } = world(on, SOURCE)
    const startedAt = Date.now()
    const { call, outcome } = await heldEdit($, clock)

    while (Date.now() - startedAt < 11_500) {
      await clock.advance(500)
    }

    expect(outcome()).toBe('held')
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(0)
    const ui = await gatePane($)
    await ui.press({ key: 'approve' })
    expect(await call).toMatchObject({ result: 'ran' })
  })

  test('an edit with no explanation is refused until Claude gives one', async ($, on) => {
    const { ran } = world(on, SOURCE)

    const answer = await $.tool.call({
      tool: 'Edit',
      file_path: FILE,
      old_string: 'const a = 1',
      new_string: 'const count = 1',
    })

    expect(answer.deny).toMatch(/mcp__pair__explain_edit/)
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(0)
  })

  test('a Write is diffed against the file as it stands', async ($, on) => {
    const { clock } = world(on, SOURCE)
    await explain($, FILE, 'Drops the unused b.')
    await explain($, '/work/new.ts', 'Adds the new helper file.')
    const overwrite = $.tool.call({ tool: 'Write', file_path: FILE, content: 'import x from "x"\nconst a = 1\n' })
    await clock.settle()

    const ui = await gatePane($)
    expect((await ui.find({ type: 'Code' }))?.text).toBe('@@ -1,3 +1,2 @@\n import x from "x"\n const a = 1\n-const b = 2')
    await ui.press({ key: 'approve' })
    await overwrite

    const create = $.tool.call({ tool: 'Write', file_path: '/work/new.ts', content: 'export const n = 1\n' })
    await clock.settle()
    await ui.redraw()
    expect((await ui.find({ type: 'Code' }))?.text).toBe('@@ -0,0 +1,1 @@\n+export const n = 1')
    expect(await ui.find({ type: 'Text', text: 'New file.' })).toBeDefined()
    await ui.press({ key: 'skip' })
    expect((await create).deny).toMatch(/chose Skip/)
  })

  test('the review draws above the prompt when the pane does not fit', async ($, on) => {
    const { clock, ran } = world(on, SOURCE, false)
    const { call } = await heldEdit($, clock)

    const ui = await $.ui.mount({ plugin: 'pair', surface: 'terminal', component: 'AbovePrompt', props: band(70) })
    expect((await ui.find({ type: 'Button', key: 'file' }))?.text).toBe(FILE)
    expect((await ui.find({ type: 'Code' }))?.text).toContain('+const count = 1')
    await ui.press({ key: 'approve' })

    expect(await call).toMatchObject({ result: 'ran' })
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(1)
  })

  test('two held edits are reviewed one after the other', async ($, on) => {
    const { clock, ran } = world(on, { ...SOURCE, '/work/b.ts': 'let b = 1\n' })
    const first = await heldEdit($, clock)
    await explain($, '/work/b.ts', 'Makes b a constant.')
    const second = $.tool.call({ tool: 'Edit', file_path: '/work/b.ts', old_string: 'let', new_string: 'const' })
    await clock.settle()

    const ui = await gatePane($)
    expect(await ui.find({ type: 'Text', text: /1 more edit waiting/ })).toBeDefined()
    await ui.press({ key: 'skip' })
    expect((await first.call).deny).toMatch(/chose Skip/)

    await ui.redraw()
    expect(await ui.find({ type: 'Button', text: '/work/b.ts' })).toBeDefined()
    await ui.press({ key: 'approve' })
    expect(await second).toMatchObject({ result: 'ran' })
    expect(ran.filter(e => e.tool === 'Edit')).toMatchObject([{ file_path: '/work/b.ts' }])
  })

  test('reads and other tools are not held', async ($, on) => {
    const { ran } = world(on, SOURCE)

    expect(await $.tool.call({ tool: 'Read', file_path: FILE })).toMatchObject({ result: 'ran' })
    expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toMatchObject({ result: 'ran' })
    expect(ran.map(e => e.tool)).toEqual(['Read', 'Bash'])
  })

  test('Whole file opens a VS Code comparison and leaves the edit held', async ($, on) => {
    const { clock, ran, files, commands } = world(on, SOURCE)
    const { call, outcome } = await heldEdit($, clock)

    const ui = await gatePane($)
    await ui.press({ key: 'whole' })

    const proposed = Object.keys(files).find(path => path.endsWith('/a.proposed.ts')) ?? ''
    expect(proposed).toStartWith('/tmp/t/pair-review-sess/')
    expect(files[proposed]).toBe('import x from "x"\nconst count = 1\nconst b = 2\n')
    expect(commands).toContainEqual(['mkdir', '-m', '700', '-p', '/tmp/t/pair-review-sess'])
    expect(commands.at(-1)).toEqual([VS_CODE_APP, '--diff', FILE, proposed])
    expect(outcome()).toBe('held')
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(0)

    await ui.press({ key: 'skip' })
    await call
    expect(files[proposed]).toBeUndefined()
  })

  test('the path opens the same view, with an empty file beside a new one', async ($, on) => {
    const { clock, files, commands } = world(on, {})
    await explain($, '/work/new.ts', 'Adds the new helper file.')
    const create = $.tool.call({ tool: 'Write', file_path: '/work/new.ts', content: 'export const n = 1\n' })
    await clock.settle()

    const ui = await gatePane($)
    await ui.press({ key: 'file' })

    const [, , before = '', proposed = ''] = commands.at(-1) ?? []
    expect(before).toEndWith('/new.before.ts')
    expect(proposed).toEndWith('/new.proposed.ts')
    expect(files[before]).toBe('')
    expect(files[proposed]).toBe('export const n = 1\n')
    await ui.press({ key: 'skip' })
    await create
  })

  test('Wide view shows more lines around the change and asks for a wider pane', async ($, on) => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
    const { clock, opened } = world(on, { [FILE]: `${lines.join('\n')}\n` })
    await explain($, FILE, 'Rewords line 20.')
    const call = $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'line 20\n', new_string: 'twenty\n' })
    await clock.settle()

    const ui = await gatePane($)
    expect((await ui.find({ type: 'Code' }))?.text).toStartWith('@@ -17,7 +17,7 @@')
    await ui.press({ key: 'context' })

    expect((await ui.find({ type: 'Code' }))?.text).toStartWith('@@ -1,40 +1,40 @@')
    expect((await ui.find({ key: 'context' }))?.props.label).toBe('Narrow view')
    expect(opened.at(-1)).toEqual({ columns: 120 })

    await ui.press({ key: 'context' })
    expect((await ui.find({ type: 'Code' }))?.text).toStartWith('@@ -17,7 +17,7 @@')
    expect(opened.at(-1)).toEqual({ columns: undefined })
    await ui.press({ key: 'skip' })
    await call
  })

  test('the review says how big the edit is and stays quiet under the target', async ($, on) => {
    const { clock } = world(on, SOURCE)
    await heldEdit($, clock)

    const ui = await gatePane($)
    expect(await ui.find({ type: 'Text', text: '+1 -1 lines.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Over your/ })).toBeUndefined()
    await ui.press({ key: 'skip' })
  })

  test('an edit over the configured target is flagged, and Claude is told the target', { options: { maxReviewLines: 1 } }, async ($, on) => {
    const { clock, prompts } = world(on, SOURCE)
    await heldEdit($, clock)

    const ui = await gatePane($)
    expect(await ui.find({ type: 'Text', text: /\+1 -1 lines\. Over your 1-line target/ })).toBeDefined()
    await ui.press({ key: 'skip' })

    await submit($, 'hello')
    expect(prompts.at(-1)?.context?.[0]).toContain('about 1 changed lines')
  })

  test('Split refuses the edit and asks for smaller steps', async ($, on) => {
    const { clock, ran } = world(on, SOURCE)
    const { call } = await heldEdit($, clock)

    const ui = await gatePane($)
    await ui.press({ key: 'split' })

    const answer = await call
    expect(answer.deny).toMatch(/chose Split/)
    expect(answer.deny).toMatch(/smaller steps of about 40 changed lines/)
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(0)
  })
})

describe('/pair', () => {
  test('off lets edits through and sends no instructions; on restores both', async ($, on) => {
    const { clock, ran, prompts } = world(on, { ...SOURCE, [SKILL_PATH]: SKILL_TEXT })

    const off = await command($, 'pair', 'off')
    expect(off.text).toMatch(/Pair mode is off/)
    expect(off.context?.[0]).toMatch(/turned pair mode off/)
    expect(
      await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'const a = 1', new_string: 'const count = 1' }),
    ).toMatchObject({ result: 'ran' })
    await submit($, 'hello')
    expect(prompts.at(-1)).toEqual({ text: 'hello', context: undefined })

    const back = await command($, 'pair')
    expect(back.text).toMatch(/Pair mode is on/)
    expect(back.context?.[0]).toMatch(/turned pair mode on/)
    const { outcome } = await heldEdit($, clock)
    expect(outcome()).toBe('held')
    expect(ran.filter(e => e.tool === 'Edit')).toHaveLength(1)
    await (await gatePane($)).press({ key: 'skip' })
    await submit($, 'again')
    expect(prompts.at(-1)?.context?.[0]).toStartWith('# Collaborate')
  })

  test('turning it off releases an edit that is being held', async ($, on) => {
    const { clock } = world(on, SOURCE)
    const { call } = await heldEdit($, clock)

    await command($, 'pair', 'off')

    const answer = await call
    expect(answer).toMatchObject({ result: 'ran' })
    expect(answer.context).toBeUndefined()
  })

  test('the first prompt of a session carries the skill body, and later ones carry nothing', async ($, on) => {
    const { prompts } = world(on, { [SKILL_PATH]: SKILL_TEXT })

    await submit($, 'add a cache')
    const [first] = prompts.at(-1)?.context ?? []
    expect(prompts.at(-1)?.text).toBe('add a cache')
    expect(first).toStartWith('# Collaborate\n\nYou and the user are peers.')
    expect(first).not.toContain('description: Pair up.')
    expect(first).toContain('mcp__pair__explain_edit')

    await submit($, 'and a test')
    expect(prompts.at(-1)).toEqual({ text: 'and a test', context: undefined })
  })

  test('after a compaction the next prompt carries the instructions again', async ($, on) => {
    const messages = [{ role: 'user' as const, text: 'a summary', toolUses: [] }]
    on('session.compact', () => ({ messages }))
    const { prompts } = world(on, { [SKILL_PATH]: SKILL_TEXT })
    const carried = async (text: string) => {
      await submit($, text)

      return prompts.at(-1)?.context !== undefined
    }

    expect(await carried('first')).toBe(true)
    expect(await carried('second')).toBe(false)

    await $.session.compact({ trigger: 'precompute', messages })
    expect(await carried('after a precompute')).toBe(false)

    await $.session.compact({ trigger: 'auto', messages })
    expect(await carried('after a compaction')).toBe(true)
    expect(await carried('and the one after')).toBe(false)
  })

  test('after a /clear the next prompt carries the instructions again', async ($, on) => {
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
    const { prompts } = world(on, { [SKILL_PATH]: SKILL_TEXT })

    await submit($, 'first')
    await submit($, 'second')
    expect(prompts.at(-1)?.context).toBeUndefined()

    await $.session.end({ reason: 'clear', sessionId: 'sess', resume: { id: 'sess' } })
    await submit($, 'after a clear')
    expect(prompts.at(-1)?.context?.[0]).toStartWith('# Collaborate')
  })

  test('a prompt the person did not type is left alone', async ($, on) => {
    const { prompts } = world(on, { [SKILL_PATH]: SKILL_TEXT })

    await submit($, 'task finished', 'task-notification')

    expect(prompts.at(-1)?.context).toBeUndefined()
  })

  test('the skill the plugin ships is used when the person has none of their own', async ($, on) => {
    const { prompts, files, asked } = world(on, {})
    const shipped = await shippedSkillPath($, asked)
    expect(shipped).not.toBe('')

    files[shipped] = SKILL_TEXT
    await submit($, 'hello')
    expect(prompts.at(-1)?.context?.[0]).toStartWith('# Collaborate')
  })

  test("the person's own copy of the skill wins over the shipped one", async ($, on) => {
    const { prompts, files, asked } = world(on, {})
    files[await shippedSkillPath($, asked)] = SKILL_TEXT
    files[SKILL_PATH] = '---\nname: collaborate\n---\nMy own rules.\n'

    await submit($, 'hello')
    expect(prompts.at(-1)?.context?.[0]).toStartWith('My own rules.')
  })

  test('with no skill file the prompt still carries the mod note', async ($, on) => {
    const { prompts } = world(on, {})

    await submit($, 'hello')

    expect(prompts.at(-1)?.context).toHaveLength(1)
    expect(prompts.at(-1)?.context?.[0]).toStartWith('The `pair` mod is on')
  })
})

const PATCH = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  '+extra',
  ' three',
  'diff --git a/b.ts b/b.ts',
  'new file mode 100644',
  'index 000..333',
  '--- /dev/null',
  '+++ b/b.ts',
  '@@ -0,0 +1 @@',
  '+new',
  '',
].join('\n')

// A repository at /repo whose work tree differs at every snapshot, unless quiet.
const repository = (isQuiet = false) => {
  let trees = 0

  return (argv: readonly string[]) => {
    const line = argv.join(' ')
    if (line === 'git rev-parse --show-toplevel') {
      return { stdout: '/repo\n' }
    }
    if (line.endsWith(' git write-tree')) {
      trees += isQuiet ? 0 : 1

      return { stdout: `tree${trees}\n` }
    }

    return line.startsWith('git diff ') ? { stdout: PATCH } : undefined
  }
}

const heldCommand = async ($: Engine, clock: ReturnType<typeof mock.clock>) => {
  const call = $.tool.call({ tool: 'Bash', command: 'make fmt' })
  let outcome: unknown = 'held'
  void call.then(settled => {
    outcome = settled
  })
  await clock.settle()

  return { call, outcome: () => outcome }
}

describe('what a command changed', () => {
  test('its result waits while the changes are stepped through, and Claude is told which to discuss', async ($, on) => {
    const { clock } = world(on, {}, true, repository())
    const { call, outcome } = await heldCommand($, clock)

    expect(outcome()).toBe('held')
    const ui = await gatePane($)
    expect(await ui.find({ type: 'Text', text: 'Bash changed 2 files, +3 -1 lines' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$ make fmt' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Change 1 of 2:' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toBe('@@ -1,3 +1,4 @@\n one\n-two\n+TWO\n+extra\n three')

    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: 'Change 2 of 2:' })).toBeDefined()
    expect((await ui.find({ type: 'Code' }))?.text).toBe('@@ -0,0 +1,1 @@\n+new')
    expect(outcome()).toBe('held')

    await ui.press({ key: 'flag' })
    const answer = await call
    expect(answer).toMatchObject({ result: 'ran' })
    const [note = ''] = answer.context ?? []
    expect(note).toContain('wants to discuss the 1 change below')
    expect(note).toContain('b.ts\n@@ -0,0 +1,1 @@\n+new')
    expect(note).not.toContain('+TWO')
  })

  test('Accept the rest lets Claude go on with a short note', async ($, on) => {
    const { clock } = world(on, {}, true, repository())
    const { call } = await heldCommand($, clock)

    await (await gatePane($)).press({ key: 'rest' })

    expect((await call).context).toEqual(['pair: the user reviewed what this command changed (2 files, +3 -1 lines).'])
  })

  test('Whole file compares the file before the command with the file now', async ($, on) => {
    const { clock, commands } = world(on, { '/repo/a.ts': 'one\nTWO\nextra\nthree\n' }, true, repository())
    const { call } = await heldCommand($, clock)

    const ui = await gatePane($)
    await ui.press({ key: 'whole' })
    expect(commands).toContainEqual(['git', 'show', 'tree1:a.ts'])
    const [program, flag, before, now] = commands.at(-1) ?? []
    expect([program, flag, now]).toEqual([VS_CODE_APP, '--diff', '/repo/a.ts'])
    expect(before).toEndWith('/a.before.ts')

    await ui.press({ key: 'rest' })
    await call
  })

  test('a command that changed nothing is not reviewed', async ($, on) => {
    const { opened } = world(on, {}, true, repository(true))

    const answer = await $.tool.call({ tool: 'Bash', command: 'ls' })

    expect(answer).toMatchObject({ result: 'ran' })
    expect(answer.context).toBeUndefined()
    expect(opened).toHaveLength(0)
  })

  test('with pair mode off no snapshot is taken', async ($, on) => {
    const { commands } = world(on, {}, true, repository())
    await command($, 'pair', 'off')

    await $.tool.call({ tool: 'Bash', command: 'make fmt' })

    expect(commands.filter(argv => argv.includes('git'))).toHaveLength(0)
  })

  test('with the setting off no snapshot is taken', { options: { reviewBash: false } }, async ($, on) => {
    const { commands } = world(on, {}, true, repository())

    await $.tool.call({ tool: 'Bash', command: 'make fmt' })

    expect(commands.filter(argv => argv.includes('git'))).toHaveLength(0)
  })
})

describe('/pair help', () => {
  test('lists every command and button, and the settings as they are', { options: { maxReviewLines: 12, editor: 'zed' } }, async ($, on) => {
    world(on, { [SKILL_PATH]: SKILL_TEXT })

    const { text = '' } = await command($, 'pair', 'help')

    expect(text).toStartWith('Pair programming with Claude. Pair mode is on.')
    for (const line of [
      '/pair on | off',
      '/pair status',
      '1  Approve',
      '2  Discuss',
      '3  Skip',
      '4  Wide view',
      '5  Whole file',
      '6  Split',
      'Esc',
      '/pair drive [files]    take over: your files are noted and your editor (zed) opens',
      '/pair review [note]',
      '/notebook resolve <id> [answer]',
      `In use: ${SKILL_PATH}`,
      'Review size target     12 changed lines (maxReviewLines)',
      'Editor command         zed (editor)',
    ]) {
      expect(text).toContain(line)
    }

    await command($, 'pair', 'off')
    expect((await command($, 'pair', 'help')).text).toContain('Pair mode is off.')
    expect((await command($, 'pair', 'nonsense')).text).toContain('/pair help explains each.')
  })
})

describe('taking over', () => {
  test('drive opens the editor, and review sends Claude what was typed with the note', async ($, on) => {
    const { clock, files, commands, prompts } = world(on, SOURCE)

    const started = await command($, 'pair', 'drive a.ts')
    expect(started.text).toMatch(/You are driving: changes to \/work\/a\.ts/)
    expect(started.context?.[0]).toMatch(/taken over the keyboard/)
    expect(commands.at(-1)).toEqual([VS_CODE_APP, FILE])

    files[FILE] = 'import x from "x"\nconst count = 1\nconst b = 2\n'
    const sent = await command($, 'pair', 'review I renamed a. Is count clear enough?')
    expect(prompts).toHaveLength(0)
    await clock.advance(100)

    expect(sent.text).toBe('Sent 1 file, +1 -1 lines to Claude for review.')
    expect(prompts.at(-1)?.text).toBe(
      'Review the changes I just typed myself (1 file, +1 -1 lines). I renamed a. Is count clear enough?',
    )
    const [changes] = sent.context ?? []
    expect(changes).toStartWith('pair: the user took over and typed the changes below themselves')
    expect(changes).toContain(`--- ${FILE}\n+++ ${FILE}\n@@ -1,3 +1,3 @@`)
    expect(changes).toContain('+const count = 1')

    expect((await command($, 'pair', 'review')).text).toStartWith('Nothing to review yet.')
  })

  test('review with nothing changed keeps you driving', async ($, on) => {
    const { files } = world(on, SOURCE)
    await command($, 'pair', 'drive a.ts')

    expect((await command($, 'pair', 'review')).text).toStartWith('Nothing has changed since /pair drive.')
    files[FILE] = 'changed\n'
    expect((await command($, 'pair', 'review')).text).toMatch(/^Sent 1 file/)
  })

  test('outside a repository it watches the files Claude edited, and asks for names when there are none', async ($, on) => {
    const { files } = world(on, { '/elsewhere/z.ts': 'let z = 1\n' })

    expect((await command($, 'pair', 'drive')).text).toStartWith('This folder is not a git repository, so name the files')
    await command($, 'pair', 'off')
    await $.tool.call({ tool: 'Edit', file_path: '/elsewhere/z.ts', old_string: 'let', new_string: 'const' })
    expect((await command($, 'pair', 'drive')).text).toMatch(/changes to \/elsewhere\/z\.ts/)

    files['/elsewhere/z.ts'] = 'const z = 1\n'
    const sent = await command($, 'pair', 'review')
    expect(sent.text).toMatch(/^Sent 1 file/)
    expect(sent.context?.[0]).toContain('+++ /elsewhere/z.ts')
  })

  test('a file can be named by its name alone, with ~, or through the @ file picker', async ($, on) => {
    const nested = { ...SOURCE, '/work/src/deep/b.ts': 'let b = 1\n', '/work/x/c.ts': '1\n', '/work/y/c.ts': '2\n' }
    world(on, nested, true, argv =>
      argv[0] === 'find' && argv.includes('-path')
        ? { stdout: Object.keys(nested).filter(path => path.endsWith(String(argv[argv.indexOf('-path') + 1]).slice(1))).join('\n') }
        : undefined,
    )
    const driving = async (args: string) => (await command($, 'pair', `drive ${args}`)).text

    expect(await driving('b.ts')).toMatch(/changes to \/work\/src\/deep\/b\.ts/)
    expect(await driving('deep/b.ts')).toMatch(/changes to \/work\/src\/deep\/b\.ts/)
    expect(await driving('@a.ts')).toMatch(/changes to \/work\/a\.ts/)
    expect(await driving('~/notes.md')).toMatch(/changes to \/home\/dev\/notes\.md/)
    expect(await driving('c.ts')).toStartWith('Several files match c.ts: /work/x/c.ts, /work/y/c.ts.')
  })

  test('in a git repository the whole work tree is compared, through a throwaway index', async ($, on) => {
    let trees = 0
    const { clock, commands, prompts } = world(on, {}, true, argv => {
      const line = argv.join(' ')
      if (line === 'git rev-parse --show-toplevel') {
        return { stdout: '/repo\n' }
      }
      if (line.endsWith(' git write-tree')) {
        trees += 1

        return { stdout: `tree${trees}\n` }
      }
      if (line.startsWith('git diff ')) {
        return { stdout: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n' }
      }

      return undefined
    })

    expect((await command($, 'pair', 'drive /elsewhere/b.ts')).text).toMatch(/changes to \/elsewhere\/b\.ts/)
    expect((await command($, 'pair', 'drive')).text).toMatch(/every change under \/repo/)
    expect(commands).toContainEqual(['env', 'GIT_INDEX_FILE=/tmp/t/pair-review-sess/drive-index', 'git', 'add', '-A'])
    expect(commands.at(-1)).toEqual([VS_CODE_APP, '/repo'])

    const sent = await command($, 'pair', 'review')
    await clock.advance(100)
    expect(commands).toContainEqual(['git', 'diff', '--no-color', '--no-ext-diff', 'tree1', 'tree2'])
    expect(prompts.at(-1)?.text).toBe('Review the changes I just typed myself (1 file, +1 -1 lines).')
    expect(sent.context?.[0]).toContain('+new')
  })
})

describe('notebook', () => {
  test('Claude adds and resolves entries; the person adds, edits and removes them', async ($, on) => {
    world(on, {})

    await notebookTool($, { action: 'add_decided', text: 'Use SQLite' })
    await notebookTool($, { action: 'add_open', text: 'Cache where?' })
    const resolved = await notebookTool($, { action: 'resolve', id: 2, text: 'in memory' })
    expect(resolved.result).toBe('Decided\n  #1 Use SQLite\n  #2 Cache where? → in memory\nOpen questions\n  (none)')

    await command($, 'notebook', 'open Which port?')
    await command($, 'notebook', 'edit 1 Use Postgres')
    const listed = await command($, 'notebook', 'remove #2')
    expect(listed.text).toBe('Decided\n  #1 Use Postgres\nOpen questions\n  #3 Which port?')
    expect((await command($, 'notebook', 'resolve 9')).text).toStartWith('No notebook entry #9.')
  })

  test('the band is one line when narrow and lists entries when wide', async ($, on) => {
    world(on, {})
    await notebookTool($, { action: 'add_decided', text: 'Use SQLite' })
    await notebookTool($, { action: 'add_open', text: 'Cache where?' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const narrow = await $.ui.mount({ plugin: 'pair', surface, component: 'AbovePrompt', props: band(60) })
      expect(await narrow.findAll({ type: 'Text' })).toHaveLength(1)
      expect(await narrow.find({ text: /1 decided, 1 open/ })).toBeDefined()
      await narrow.unmount()

      const wide = await $.ui.mount({ plugin: 'pair', surface, component: 'AbovePrompt', props: band(120) })
      expect(await wide.find({ type: 'Text', text: /Use SQLite/ })).toBeDefined()
      expect(await wide.find({ type: 'Text', text: /Cache where\?/ })).toBeDefined()
      await wide.unmount()
    }
  })

  test('/notebook shows the full list in a pane', async ($, on) => {
    world(on, {})
    await command($, 'notebook', 'decided Use SQLite')
    await command($, 'notebook')

    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({
        plugin: 'pair',
        surface,
        component: 'Pane',
        requestId: 'pair-notebook',
        props: { ...PANE, title: 'Notebook' },
      })
      expect(await ui.find({ type: 'Text', text: /#1 Use SQLite/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Open questions' })).toBeDefined()
      await ui.unmount()
    }
  })
})

describe('diff', () => {
  test('separate changes become separate hunks with their own line numbers', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    const after = before.map(line => (line === 'line 2' ? 'second' : line === 'line 18' ? 'eighteenth' : line))

    expect(unifiedDiff(before.join('\n'), after.join('\n')).text).toBe(
      [
        '@@ -1,5 +1,5 @@',
        ' line 1',
        '-line 2',
        '+second',
        ' line 3',
        ' line 4',
        ' line 5',
        '@@ -15,6 +15,6 @@',
        ' line 15',
        ' line 16',
        ' line 17',
        '-line 18',
        '+eighteenth',
        ' line 19',
        ' line 20',
      ].join('\n'),
    )
  })

  test('a long diff is cut at a whole line and says how much is hidden', () => {
    const after = Array.from({ length: 50 }, (_, index) => `row ${index}`).join('\n')

    const cut = unifiedDiff('', after, 60)

    expect(cut.text.split('\n')[0]).toMatch(/^@@ -0,0 \+1,(\d+) @@$/)
    expect(cut.text.split('\n').length - 1 + cut.hidden).toBe(50)
    expect(cut.text.length).toBeLessThanOrEqual(80)
  })

  test('a long change in a git diff is cut into chunks, each with its own line numbers', () => {
    const added = Array.from({ length: 10 }, (_, index) => `+line ${index + 1}`)
    const patch = ['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1,2 +1,12 @@', ' top', ...added, ' bottom', ''].join('\n')

    const chunks = chunksOf(patch, 2)

    expect(chunks.map(chunk => chunk.diff.split('\n')[0])).toEqual([
      '@@ -1,1 +1,3 @@',
      '@@ -1,0 +4,2 @@',
      '@@ -1,0 +6,2 @@',
      '@@ -1,0 +8,2 @@',
      '@@ -1,0 +10,2 @@',
    ])
    expect(chunks.every(chunk => chunk.path === 'x.txt' && chunk.added === 2 && chunk.removed === 0)).toBe(true)
  })

  test('lines that replace removed ones stay in the same chunk', () => {
    const patch = ['diff --git a/x.txt b/x.txt', '--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@', '-a', '-b', '-c', '+A', '+B', '+C', ''].join('\n')

    expect(chunksOf(patch, 3).map(chunk => [chunk.added, chunk.removed])).toEqual([[3, 3]])
  })

  test('a file git shows no text for is one chunk with no diff', () => {
    const patch = 'diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n'

    expect(chunksOf(patch, 40)).toEqual([{ path: 'i.png', diff: '', added: 0, removed: 0 }])
  })

  test('an edit applies as the Edit tool applies it', () => {
    expect(applyEdit('a $1 a', 'a', '$&', false)).toBe('$& $1 a')
    expect(applyEdit('a b a', 'a', 'c', true)).toBe('c b c')
    expect(applyEdit('a b', 'z', 'c', false)).toBeUndefined()
  })
})
