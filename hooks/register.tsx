import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type {
  PairCommandReview,
  PairDrive,
  PairEntry,
  PairLogEntry,
  PairNotebook,
  PairPendingEdit,
} from '../types'
import { applyEdit, chunksOf, unifiedDiff } from './diff'
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
type Described = { text: string; note: string; added: number; removed: number; whole?: Whole }
type HeldCall = Pick<PairPendingEdit, 'id' | 'tool' | 'path'> & {
  describe: () => Promise<Described>
}
type GateActions = {
  choose: (id: string, decision: Decision) => void
  viewFile: (id: string) => Promise<void>
  toggleContext: (id: string) => Promise<void>
  step: (id: string, isFlagged: boolean) => Promise<void>
  viewChunk: (id: string) => Promise<void>
}
type Changes = { text: string; files: number; added: number; removed: number }
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
const REVIEW_BUDGET = 60_000
const TOUCHED_MAX = 50
const SUBMIT_DELAY_MS = 100
const CHUNKS_MAX = 200
const LOG_MAX = 300
// How a review of an edit ended, as the session summary words it.
const OUTCOMES: Record<Decision | 'none', string> = {
  approve: 'approved',
  discuss: 'sent back to discuss',
  skip: 'skipped',
  split: 'sent back to be split',
  talk: 'review closed to talk in the chat',
  release: 'let through when pair mode was turned off',
  none: 'interrupted before a decision',
}
const SUMMARY_RULES =
  'pair: the user asked for a summary of this session. Write it for someone who was not here: what was decided, what is still open, and what changed, in a form that could be pasted into a pull request description. Use the records below and what you know from the conversation, and say so where the two disagree. Do not change any files.'
const NOT_STORED = 'not stored'
const SESSION_ONLY =
  "This notebook lasts only for this session, because Claude was not started inside a git repository. Start Claude in your project's repository and its notebook is kept from one session to the next."
// Hidden folders, dependencies and caches are never what the user is typing in.
const SKIPPED = ['(', '-name', '.*', '-o', '-name', 'node_modules', '-o', '-name', '__pycache__', ')', '-prune']
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
const DRIVE_NOTE =
  'pair: the user has taken over the keyboard to type changes themselves. Leave the files alone until they run /pair review, which sends you what they typed.'
const REVIEW_RULES =
  'pair: the user took over and typed the changes below themselves, between /pair drive and /pair review. Review them as their pairing partner: say what the change does, point out bugs, risks and anything unclear, and answer the note in their message if there is one. Do not rewrite or revert their work; propose a fix and wait for them to agree. Claude Code may also tell you these files changed on disk: those are the same edits. If an IDE is connected, check its diagnostics for these files.'
// How many changed lines one edit should stay under: the `maxReviewLines` setting.
let maxLines = 40
// The command /pair drive opens files with: the `editor` setting.
let editor = 'code'
// Whether what a Bash command changed is reviewed: the `reviewBash` setting.
let isBashReviewed = true

const isOn = atom({ plugin: 'pair', key: 'isOn' } as const, true)
const notebook = atom({ plugin: 'pair', key: 'notebook' } as const, { nextId: 1, entries: [] })
const notebookName = atom({ plugin: 'pair', key: 'notebookName' } as const, '')
const pending = atom({ plugin: 'pair', key: 'pending' } as const, [])
const commands = atom({ plugin: 'pair', key: 'commands' } as const, [])
const log = atom({ plugin: 'pair', key: 'log' } as const, [])
const isGateInBand = atom({ plugin: 'pair', key: 'isGateInBand' } as const, false)
const hasSentInstructions = atom({ plugin: 'pair', key: 'hasSentInstructions' } as const, false)
const drive = atom({ plugin: 'pair', key: 'drive' } as const, null)
const touched = atom({ plugin: 'pair', key: 'touched' } as const, [])
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

// The name a session's notebook is stored under: the git repository its
// project folder is in, worked out once (a shell `cd` does not move it).
// Undefined outside a repository: a plain folder may hold many projects, and
// one notebook for all of them would mix their decisions.
const notebookKey = async ($: EngineInterface): Promise<string | undefined> => {
  let name = await read($, notebookName)
  if (name === '') {
    const top = (await run($, ['git', 'rev-parse', '--show-toplevel'], await $.session.root()))?.trim()
    name = top === undefined || top === '' ? NOT_STORED : `notebook:${top}`
    const settled = name
    await update($, notebookName, () => settled)
  }

  return name === NOT_STORED ? undefined : name
}

// What the store holds under that name, when it has the shape of a notebook.
const asNotebook = (saved: unknown): PairNotebook | undefined => {
  const book = saved as Partial<PairNotebook> | null | undefined
  if (typeof book?.nextId !== 'number' || !Array.isArray(book.entries)) {
    return undefined
  }
  const isSound = book.entries.every(
    (entry: Partial<PairEntry> | null) =>
      typeof entry?.id === 'number' &&
      typeof entry.text === 'string' &&
      (entry.kind === 'decided' || entry.kind === 'open'),
  )

  return isSound ? { nextId: book.nextId, entries: book.entries } : undefined
}

// The project's notebook as stored, shown in this session too: another session
// in the same project may have changed it since this one last looked.
const refreshNotebook = async ($: EngineInterface): Promise<PairNotebook> => {
  const key = await notebookKey($)
  const mine = await read($, notebook)
  const saved = key === undefined ? undefined : asNotebook(await $.store.get(key))
  if (key === undefined || saved === undefined) {
    if (key !== undefined && mine.entries.length > 0) {
      await $.store.set(key, mine)
    }

    return mine
  }
  if (JSON.stringify(saved) !== JSON.stringify(mine)) {
    await update($, notebook, () => saved)
  }

  return saved
}

// Changes the notebook starting from what is stored now, not from this
// session's copy, so two sessions adding entries keep each other's.
const amendNotebook = async ($: EngineInterface, change: (book: PairNotebook) => PairNotebook) => {
  const amended = change(await refreshNotebook($))
  const key = await notebookKey($)
  if (key !== undefined) {
    await $.store.set(key, amended)
  }

  return update($, notebook, () => amended)
}

const changeNotebook = async ($: EngineInterface, request: NotebookRequest): Promise<string> => {
  const { action, id } = request
  const text = request.text?.trim() ?? ''
  if (action === 'list') {
    return formatBook(await refreshNotebook($))
  }
  if (action === 'clear') {
    return formatBook(await amendNotebook($, book => ({ ...book, entries: [] })))
  }
  if (action === 'decided' || action === 'open') {
    if (text === '') {
      return 'An entry needs text.'
    }

    return formatBook(
      await amendNotebook($, book => ({
        nextId: book.nextId + 1,
        entries: [...book.entries, { id: book.nextId, kind: action, text }],
      })),
    )
  }

  const stored = await refreshNotebook($)
  const target = stored.entries.find(entry => entry.id === id)
  if (target === undefined) {
    return `No notebook entry #${id ?? '?'}.\n${formatBook(stored)}`
  }
  if (action === 'edit' && text === '') {
    return 'An edit needs the new text.'
  }
  const changed: PairEntry | undefined =
    action === 'remove'
      ? undefined
      : action === 'edit'
        ? { ...target, text }
        : { ...target, kind: 'decided', text: text === '' ? target.text : `${target.text} → ${text}` }

  return formatBook(
    await amendNotebook($, book => ({
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

const commandTree = (
  { Box, Text, Button, Code }: Kit,
  head: PairCommandReview,
  waiting: number,
  hint: string,
  actions: GateActions,
) => {
  const chunk = head.chunks[head.at]
  const notes = [
    head.flagged.length > 0 ? `${head.flagged.length} marked to discuss.` : '',
    head.hidden > 0 ? `${head.hidden} more changes are not shown here.` : '',
    waiting > 0 ? `${waiting} more waiting.` : '',
  ].filter(part => part !== '')

  return (
    <Box flexDirection="column">
      <Text bold>{`Bash changed ${head.files} file${head.files === 1 ? '' : 's'}, +${head.added} -${head.removed} lines`}</Text>
      <Text dimColor wrap="truncate-end">{`$ ${head.command}`}</Text>
      {chunk !== undefined && (
        <Box gap={1}>
          <Text>{`Change ${head.at + 1} of ${head.chunks.length}:`}</Text>
          <Button key="file" plain label={chunk.path} onPress={() => actions.viewChunk(head.id)} />
          <Text dimColor>{`+${chunk.added} -${chunk.removed}`}</Text>
        </Box>
      )}
      {chunk === undefined ? (
        <Text dimColor>No more changes.</Text>
      ) : chunk.diff === '' ? (
        <Text dimColor>This file is not text, so there is no diff to show.</Text>
      ) : (
        <Code source={chunk.diff} format="diff" path={chunk.path} />
      )}
      <Box gap={3}>
        <Button key="next" hotkey="1" plain label="Next" onPress={() => actions.step(head.id, false)} />
        <Button key="flag" hotkey="2" plain label="Discuss" onPress={() => actions.step(head.id, true)} />
        <Button key="rest" hotkey="3" plain label="Accept the rest" onPress={() => actions.choose(head.id, 'approve')} />
      </Box>
      <Box gap={3}>
        <Button key="whole" hotkey="5" plain label="Whole file" onPress={() => actions.viewChunk(head.id)} />
      </Box>
      <Text dimColor>{[hint, ...notes].join(' ')}</Text>
    </Box>
  )
}

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
// The chunks of a command's changes the user marked to discuss, by command.
const flags = new Map<string, number[]>()
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
    title: 'Pair: review',
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
    $.ui.toast('No whole-file view for this edit')

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
    if (!(await compare($, whole.before === null ? copy('before') : entry.path, copy('proposed')))) {
      $.ui.toast('Could not start VS Code')
    }
  } catch {
    $.ui.toast('Could not prepare the whole-file view')
  }
}

const toggleContext = async ($: EngineInterface, id: string) => {
  const whole = wholes.get(id)
  if (whole === undefined) {
    $.ui.toast('No wide view for this edit')

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
  step: (id, isFlagged) => stepChunk($, id, isFlagged),
  viewChunk: id => viewChunk($, id),
})

const run = async ($: EngineInterface, argv: string[], cwd?: string): Promise<string | undefined> => {
  try {
    const ran = await $.process.run(argv, cwd === undefined ? undefined : { cwd })

    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}

// The work tree under `root` as a git tree, untracked files included, built in
// a throwaway index so the repository's own index and files stay untouched.
// VS Code's side-by-side comparison of two files; false when it would not start.
const compare = async ($: EngineInterface, left: string, right: string): Promise<boolean> => {
  for (const code of VS_CODE) {
    if ((await run($, [code, '--diff', left, right])) !== undefined) {
      return true
    }
  }

  return false
}

const gitTree = async ($: EngineInterface, root: string, name = 'drive'): Promise<string | undefined> => {
  const dir = await copiesDir($)
  const index = `${dir}/${name.replace(/[^\w-]/g, '_')}-index`
  const inIndex = (...git: string[]) => run($, ['env', `GIT_INDEX_FILE=${index}`, 'git', ...git], root)
  await run($, ['mkdir', '-m', '700', '-p', dir])
  const own = (await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-path', 'index'], root))?.trim()
  if (own !== undefined && own !== '') {
    // Starting from the repository's index, only changed files are hashed again.
    await run($, ['cp', own, index])
  }
  const tree = (await inIndex('add', '-A')) === undefined ? undefined : (await inIndex('write-tree'))?.trim()
  await run($, ['rm', '-f', index])

  return tree === '' ? undefined : tree
}

const openEditor = async ($: EngineInterface, paths: string[]): Promise<boolean> => {
  for (const command of editor === 'code' ? VS_CODE : [editor]) {
    if ((await run($, [command, ...paths])) !== undefined) {
      return true
    }
  }

  return false
}

const found = async ($: EngineInterface, folder: string, depth: number, ...tests: string[]) =>
  (
    await run($, [
      'find', folder, '-mindepth', '1', '-maxdepth', String(depth),
      ...SKIPPED, '-o', '-type', 'f', ...tests, '-print',
    ])
  )
    ?.split('\n')
    .filter(path => path !== '')

// A file as the user named it: `@` from the file picker and `~` are accepted,
// and a name that is not at that place is looked for under the session's folder.
const resolvePath = async (
  $: EngineInterface,
  word: string,
  cwd: string,
): Promise<string | { problem: string }> => {
  const typed = word.replace(/^@/, '')
  if (typed === '~' || typed.startsWith('~/')) {
    return `${(await $.env.get('HOME')) ?? ''}${typed.slice(1)}`
  }
  const direct = typed.startsWith('/') ? typed : `${cwd}/${typed}`
  if (typed.startsWith('/') || (await $.fs.exists(direct))) {
    return direct
  }
  // Near the top first: a deep search of a very large folder takes seconds.
  const near = (await found($, cwd, 4, '-path', `*/${typed}`)) ?? []
  const matches = near.length > 0 ? near : ((await found($, cwd, 8, '-path', `*/${typed}`)) ?? [])
  if (matches.length > 1) {
    return {
      problem: `Several files match ${typed}: ${matches.slice(0, 8).join(', ')}. Name one with more of its path.`,
    }
  }

  return matches[0] ?? direct
}

const tally = (patch: string) => {
  const rows = patch.split('\n')

  return {
    files: rows.filter(row => row.startsWith('diff --git ')).length,
    added: rows.filter(row => row.startsWith('+') && !row.startsWith('+++')).length,
    removed: rows.filter(row => row.startsWith('-') && !row.startsWith('---')).length,
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

const startDrive = async ($: EngineInterface, args: string) => {
  const cwd = await $.session.cwd()
  const named: string[] = []
  for (const word of args.split(/\s+/).filter(typed => typed !== '')) {
    const path = await resolvePath($, word, cwd)
    if (typeof path !== 'string') {
      return { text: path.problem }
    }
    named.push(path)
  }
  // The repository is the one the named files are in; git covers the drive
  // only when it holds all of them.
  const first = named[0]
  const base = first === undefined ? cwd : first.slice(0, first.lastIndexOf('/')) || '/'
  const top = (await run($, ['git', 'rev-parse', '--show-toplevel'], base))?.trim() || undefined
  const root = named.every(path => path.startsWith(`${top}/`)) ? top : undefined
  const tree = root === undefined ? undefined : await gitTree($, root)
  let started: PairDrive
  if (root !== undefined && tree !== undefined) {
    started = { kind: 'git', root, tree }
  } else {
    const paths = [...new Set([...named, ...(await read($, touched))])]
    if (paths.length === 0) {
      return {
        text: 'This folder is not a git repository, so name the files you are taking over: /pair drive <file> ...',
      }
    }
    const files: Record<string, string | null> = {}
    for (const path of paths) {
      files[path] = await readOrNull($, path)
    }
    started = { kind: 'files', files }
  }
  await update($, drive, () => started)
  $.ui.status('pair: you are driving; /pair review hands back')
  const scope =
    started.kind === 'git'
      ? `every change under ${started.root}`
      : `changes to ${Object.keys(started.files).join(', ')}`
  const isOpen = await openEditor($, named.length > 0 ? named : [root ?? cwd])

  return {
    text: `You are driving: ${scope} will be in the review. ${isOpen ? '' : `Could not start ${editor}, so open the files yourself. `}Run /pair review [note] to hand back.`,
    context: [DRIVE_NOTE],
  }
}

const driveChanges = async ($: EngineInterface, started: PairDrive): Promise<Changes | undefined> => {
  if (started.kind === 'git') {
    const tree = await gitTree($, started.root)
    const text =
      tree === undefined
        ? undefined
        : await run($, ['git', 'diff', '--no-color', '--no-ext-diff', started.tree, tree], started.root)
    if (text === undefined) {
      return undefined
    }

    return { text, ...tally(text) }
  }

  const changes: Changes = { text: '', files: 0, added: 0, removed: 0 }
  for (const [path, before] of Object.entries(started.files)) {
    const after = await readOrNull($, path)
    if (after === before) {
      continue
    }
    const diff = unifiedDiff(before ?? '', after ?? '', REVIEW_BUDGET)
    changes.text += `--- ${before === null ? '/dev/null' : path}\n+++ ${after === null ? '/dev/null' : path}\n${diff.text}\n`
    changes.files += 1
    changes.added += diff.added
    changes.removed += diff.removed
  }

  return changes
}

// Notes one review for the session summary.
const record = ($: EngineInterface, entry: PairLogEntry) =>
  update($, log, list => [...list, entry].slice(-LOG_MAX))

// A prompt in the user's name, sent just after the command that asked for it:
// a command may not submit one itself. What Claude needs with it travels as
// that command's hidden note, which the prompt's turn reads.
const submitSoon = ($: EngineInterface, text: string, failure: string) => {
  $.clock.after(SUBMIT_DELAY_MS, () => {
    void $.prompt.submit({ text, asUser: true }).catch(() => {
      $.ui.toast(failure)
    })
  })
}

const requestSummary = async ($: EngineInterface, note: string) => {
  const reviews = await read($, log)
  const records = [
    SUMMARY_RULES,
    `Notebook\n${formatBook(await refreshNotebook($))}`,
    reviews.length === 0
      ? 'No reviews were recorded this session.'
      : [
          'Reviews this session, oldest first',
          ...reviews.map(one => `- ${one.what}${one.size === '' ? '' : ` (${one.size})`}: ${one.outcome}`),
        ].join('\n'),
  ].join('\n\n')
  submitSoon(
    $,
    `Write a summary of this session.${note === '' ? '' : ` ${note}`}`,
    'Could not ask for the summary. Send any prompt and Claude will have the records.',
  )

  return { text: 'Asked Claude for a summary of this session.', context: [records] }
}

const requestReview = async ($: EngineInterface, note: string) => {
  const started = await read($, drive)
  if (started === null) {
    return { text: 'Nothing to review yet. Run /pair drive, type your changes, then /pair review.' }
  }
  const changes = await driveChanges($, started)
  if (changes === undefined) {
    return { text: 'Git could not show what changed, so nothing was sent. You are still driving.' }
  }
  if (changes.files === 0) {
    return { text: 'Nothing has changed since /pair drive. Save your files, then run /pair review again.' }
  }
  await update($, drive, () => null)
  $.ui.status(undefined)
  const size = `${changes.files} file${changes.files === 1 ? '' : 's'}, +${changes.added} -${changes.removed} lines`
  const typed = [
    REVIEW_RULES,
    changes.text.length > REVIEW_BUDGET ? `The diff is cut at ${REVIEW_BUDGET} characters; read the files for the rest.` : '',
    changes.text.slice(0, REVIEW_BUDGET),
  ]
    .filter(part => part !== '')
    .join('\n\n')
  await record($, {
    what: `You typed ${plural(changes.files, 'file')}`,
    size: `+${changes.added} -${changes.removed}`,
    outcome: 'sent to Claude for review',
  })
  submitSoon(
    $,
    `Review the changes I just typed myself (${size}).${note === '' ? '' : ` ${note}`}`,
    'Could not start the review. Send any prompt and Claude will see your changes.',
  )

  return { text: `Sent ${size} to Claude for review.`, context: [typed] }
}

// The pane shows whatever is still held, and closes when nothing is.
const settleGate = async ($: EngineInterface) => {
  if (held.size === 0) {
    await $.ui.close({ id: GATE })
  } else {
    await showGate($)
  }
}

// Where a Bash command is about to run: the repository and its work tree now.
// A command that opens with `cd <folder>` is taken to run in that folder.
const beforeCommand = async ($: EngineInterface, id: string, command: string) => {
  if (!isBashReviewed || !(await read($, isOn)) || (await $.session.surfaces()).length === 0) {
    return undefined
  }
  const cwd = await $.session.cwd()
  const moved = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(command)
  const target = moved?.[1] ?? moved?.[2] ?? moved?.[3]
  const base = target === undefined ? cwd : target.startsWith('/') ? target : `${cwd}/${target}`
  const root = (await run($, ['git', 'rev-parse', '--show-toplevel'], base))?.trim() || undefined
  const tree = root === undefined ? undefined : await gitTree($, root, id)

  return root === undefined || tree === undefined ? undefined : { root, tree }
}

const stepChunk = async ($: EngineInterface, id: string, isFlagged: boolean) => {
  const list = await update($, commands, all =>
    all.map(one =>
      one.id !== id ? one : { ...one, at: one.at + 1, flagged: isFlagged ? [...one.flagged, one.at] : one.flagged },
    ),
  )
  const mine = list.find(one => one.id === id)
  if (mine === undefined) {
    return
  }
  if (isFlagged) {
    flags.get(id)?.push(mine.at - 1)
  }
  if (mine.at >= mine.chunks.length) {
    choose(id, 'approve')
  }
}

const viewChunk = async ($: EngineInterface, id: string) => {
  const entry = (await read($, commands)).find(one => one.id === id)
  const chunk = entry?.chunks[entry.at]
  if (entry === undefined || chunk === undefined) {
    return
  }
  try {
    const dir = await copiesDir($, id)
    const name = chunk.path.split('/').at(-1) ?? 'file'
    const copy = (tag: string) => `${dir}/${name.replace(/(\.[^.]*)?$/, `.${tag}$1`)}`
    const current = `${entry.root}/${chunk.path}`
    const isThere = await $.fs.exists(current)
    await run($, ['mkdir', '-m', '700', '-p', await copiesDir($)])
    await $.fs.write(copy('before'), (await run($, ['git', 'show', `${entry.before}:${chunk.path}`], entry.root)) ?? '')
    if (!isThere) {
      await $.fs.write(copy('after'), '')
    }
    if (!(await compare($, copy('before'), isThere ? current : copy('after')))) {
      $.ui.toast('Could not start VS Code')
    }
  } catch {
    $.ui.toast('Could not prepare the whole-file view')
  }
}

// Walks the user through what a finished Bash command changed, holding its
// result meanwhile; resolves the note Claude reads with that result.
const reviewCommand = async (
  $: EngineInterface,
  signal: AbortSignal,
  id: string,
  command: string,
  watch: { root: string; tree: string },
): Promise<string | undefined> => {
  const after = await gitTree($, watch.root, id)
  const patch =
    after === undefined || after === watch.tree
      ? undefined
      : await run($, ['git', 'diff', '--no-color', '--no-ext-diff', watch.tree, after], watch.root)
  const chunks = patch === undefined ? [] : chunksOf(patch, maxLines)
  if (patch === undefined || chunks.length === 0) {
    return undefined
  }
  const entry: PairCommandReview = {
    id,
    command: (command.split('\n')[0] ?? '').slice(0, 200),
    root: watch.root,
    before: watch.tree,
    ...tally(patch),
    chunks: chunks.slice(0, CHUNKS_MAX),
    hidden: Math.max(0, chunks.length - CHUNKS_MAX),
    at: 0,
    flagged: [],
  }
  held.add(id)
  flags.set(id, [])
  try {
    await update($, commands, list => [...list, entry])
    await showGate($)
    while (!decisions.has(id) && !signal.aborted) {
      await $.state.get(tick)
    }
  } finally {
    held.delete(id)
    await removeCopies($, id).catch(() => undefined)
    await update($, commands, list => list.filter(one => one.id !== id))
    await settleGate($)
  }

  const decision = decisions.get(id)
  decisions.delete(id)
  const flagged = (flags.get(id) ?? []).flatMap(index => entry.chunks[index] ?? [])
  flags.delete(id)
  const size = `${plural(entry.files, 'file')}, +${entry.added} -${entry.removed} lines`
  await record($, {
    what: `Bash \`${entry.command}\``,
    size,
    outcome:
      decision === 'talk'
        ? OUTCOMES.talk
        : decision !== 'approve'
          ? 'review not finished'
          : flagged.length === 0
            ? 'reviewed'
            : `reviewed, ${flagged.length} marked to discuss`,
  })
  if (decision === 'talk') {
    return `pair: the user closed the review of what this command changed (${size}) to talk about it in the main chat. Stop and wait for their message. Do not change or undo those changes yet.`
  }
  if (decision !== 'approve') {
    return undefined
  }
  if (flagged.length === 0) {
    return `pair: the user reviewed what this command changed (${size}).`
  }

  return [
    `pair: the user reviewed what this command changed (${size}) and wants to discuss the ${plural(flagged.length, 'change')} below before you go on. Explain each in plain language, then stop and wait for their reply. Do not change or undo them yet.`,
    ...flagged.map(chunk => `${chunk.path}\n${chunk.diff}`),
  ].join('\n\n')
}

const review = async (
  $: EngineInterface,
  signal: AbortSignal,
  call: HeldCall,
): Promise<Verdict> => {
  await update($, touched, list => (list.includes(call.path) ? list : [...list, call.path].slice(-TOUCHED_MAX)))
  if ((await $.session.surfaces()).length === 0) {
    return {}
  }
  if (!(await read($, isOn))) {
    await record($, { what: `${call.tool} ${call.path}`, size: '', outcome: 'not reviewed, pair mode was off' })

    return {}
  }
  const why = (await read($, explanations))[call.path]
  if (why === undefined) {
    return {
      deny: `pair: the user reviews every edit. First call mcp__pair__explain_edit with file_path "${call.path}" and one plain-language sentence on what this change does and why, then make this same ${call.tool} call again.`,
    }
  }
  await update($, explanations, ({ [call.path]: _used, ...rest }) => rest)

  const { text: diff, note, whole, added, removed } = await call.describe()
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
    await update($, pending, list => list.filter(one => one.id !== call.id))
    await settleGate($)
  }

  const decision = decisions.get(call.id)
  decisions.delete(call.id)
  await record($, {
    what: `${call.tool} ${call.path}`,
    size: `+${added} -${removed}`,
    outcome: OUTCOMES[decision ?? 'none'],
  })
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

const helpText = (isPairOn: boolean, skillPath: string | undefined): string =>
  [
    `Pair programming with Claude. Pair mode is ${isPairOn ? 'on' : 'off'}.`,
    '',
    'Mode',
    '  /pair                  turn pair mode on or off',
    '  /pair on | off         set it',
    '  /pair status           say which it is and which skill file is in use',
    '  /pair help             show this',
    '  /pair summary [note]   have Claude write up the session: decided, still open, and what changed',
    '',
    'When Claude edits (pair mode on)',
    '  Every Edit and Write waits for you in a review showing its reason, size and diff.',
    '  1  Approve             run the edit as written',
    '  2  Discuss             refuse it; Claude explains its reasoning and waits for you',
    '  3  Skip                refuse it; Claude drops it',
    '  4  Wide view           more lines around each change and a wider pane; press again to go back',
    '  5  Whole file          compare the whole file side by side in VS Code',
    '  6  Split               refuse it; Claude sends it again as smaller steps',
    '  Esc                    refuse it; Claude waits for you in the chat',
    '  The keys work while the review has the keyboard. Otherwise click a button, or press ctrl+x tab first.',
    '',
    'When a command changes files (pair mode on, git repositories only)',
    '  After a Bash command changes files, its result waits while you step through what it changed.',
    '  1  Next                this change is fine; show the next one',
    '  2  Discuss             mark this change; Claude explains the marked ones when you finish',
    '  3  Accept the rest     stop stepping and let Claude go on',
    '  5  Whole file          compare the whole file, before and after, in VS Code',
    '  Esc                    stop here; Claude waits for you in the chat',
    '',
    'When you edit',
    `  /pair drive [files]    take over: your files are noted and your editor (${editor}) opens`,
    '  /pair review [note]    hand back: Claude reviews what you changed, with your note',
    '  A file can be a path, a name on its own, start with ~, or come from the @ file picker.',
    '  With no files: everything in the git repository, or outside one the files Claude has edited.',
    '',
    'Notebook',
    '  /notebook                         show it in a pane',
    '  /notebook decided <text>          add a decision',
    '  /notebook open <text>             add an open question',
    '  /notebook resolve <id> [answer]   move a question to Decided',
    '  /notebook edit <id> <text>        change an entry',
    '  /notebook remove <id>             delete an entry',
    '  /notebook clear                   delete every entry',
    '  Kept between sessions, and shared by sessions in the same project, when Claude is started inside a git repository.',
    '  Started anywhere else, the notebook lasts for that session only.',
    '',
    'Instructions',
    '  The collaborate skill goes to Claude once a session, and again after a compaction or /clear.',
    `  In use: ${skillPath ?? 'none found'}`,
    '  To send it again yourself, run the skill: /collaborate, or /pair:collaborate for the bundled copy.',
    '',
    'Settings, changed in /config',
    `  Review size target     ${maxLines} changed lines (maxReviewLines)`,
    `  Editor command         ${editor} (editor)`,
    `  Review command changes ${isBashReviewed ? 'on' : 'off'} (reviewBash)`,
    '',
    'Only Edit and Write are held. Bash and other tools can still change files.',
  ].join('\n')

export const register: Register = (on, options) => {
  if (typeof options.maxReviewLines === 'number' && options.maxReviewLines >= 1) {
    maxLines = Math.floor(options.maxReviewLines)
  }
  if (typeof options.editor === 'string' && options.editor.trim() !== '') {
    editor = options.editor.trim()
  }
  if (typeof options.reviewBash === 'boolean') {
    isBashReviewed = options.reviewBash
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pair',
      description: 'Turn pairing mode on or off, or take over the typing and have Claude review it',
      argumentHint: '[on|off|status|help | drive [files] | review [note] | summary [note]]',
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
    await update($, commands, () => [])
    await $.ui.close({ id: GATE })
    await refreshNotebook($).catch(() => undefined)
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

  // A Bash command's changes are on disk before anyone sees them, so they are
  // not held: its result is, while the user steps through what it changed.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const watch = e.run_in_background === true ? undefined : await beforeCommand($, e.tool_use_id, e.command)
    const ran = await next(e)
    if (watch === undefined || ran.deny !== undefined) {
      return ran
    }
    const note = await reviewCommand($, next.signal, e.tool_use_id, e.command, watch).catch(() => undefined)

    return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
  })

  on('ui.close', { id: GATE }, async ($, e, next) => {
    const closed = await next(e)
    if (e.origin.kind === 'person') {
      const shown = (await read($, pending))[0] ?? (await read($, commands))[0]
      if (shown !== undefined) {
        choose(shown.id, 'talk')
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
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    if (verb.toLowerCase() === 'summary') {
      return requestSummary($, e.args.trim().slice(verb.length).trim())
    }
    if (verb.toLowerCase() === 'help') {
      return { text: helpText(await read($, isOn), (await loadSkill($))?.path) }
    }
    if (verb.toLowerCase() === 'drive') {
      return startDrive($, rest.join(' '))
    }
    if (verb.toLowerCase() === 'review') {
      return requestReview($, e.args.trim().slice(verb.length).trim())
    }
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
      return {
        text: 'Usage: /pair [on|off|status|help] | drive [files] | review [note] | summary [note]. /pair help explains each.',
      }
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
      const book = formatBook(await refreshNotebook($))

      return { text: (await notebookKey($)) === undefined ? `${book}\n\n${SESSION_ONLY}` : book }
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
    await update($, log, () => [])

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isPersons = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isPersons || !(await read($, isOn))) {
      return next(e)
    }
    // Another session in the same project may have changed the notebook.
    const book = await refreshNotebook($).catch(() => undefined)
    // Once a session: sent with every prompt, the copies pile up in the conversation.
    if (await read($, hasSentInstructions)) {
      return next(e)
    }
    const skill = await loadSkill($)
    $.ui.status(skill === undefined ? 'pair: collaborate skill not found (/pair status)' : undefined)
    const isKept = (await notebookKey($).catch(() => undefined)) !== undefined
    if (!isKept) {
      $.ui.toast('The notebook is for this session only. Start Claude inside a git repository to keep it between sessions.')
    }
    const carried =
      !isKept || book === undefined || book.entries.length === 0
        ? ''
        : `\n\nThe notebook you share with the user, kept from earlier sessions in this project:\n${formatBook(book)}`
    const instructions = `${skill === undefined ? modNote() : `${skill.body}\n\n${modNote()}`}${carried}`
    const entered = await next({ ...e, context: [...(e.context ?? []), instructions] })
    if (entered.drop === undefined) {
      await update($, hasSentInstructions, () => true)
    }

    return entered
  })

  on('ui.render', { component: 'Pane', requestId: GATE }, async ($, e) => {
    const kit = $.ui.resolve(e)
    const [head, ...rest] = await read($, pending)
    const [changed, ...more] = await read($, commands)
    if (head !== undefined) {
      return gateTree(kit, head, rest.length, 'Esc: not applied, talk in the chat.', actionsFor($))
    }
    if (changed !== undefined) {
      return commandTree(kit, changed, more.length, 'Esc: stop here and talk in the chat.', actionsFor($))
    }

    return <kit.Text dimColor>Nothing is waiting for review.</kit.Text>
  })

  on('ui.render', { component: 'Pane', requestId: BOOK }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const book = await read($, notebook)
    const isSessionOnly = (await read($, notebookName)) === NOT_STORED
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
        {isSessionOnly && <Text dimColor>{SESSION_ONLY}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isOn))) {
      return next(e)
    }
    const kit = $.ui.resolve(e)
    const [head, ...rest] = await read($, pending)
    const [changed, ...more] = await read($, commands)
    const isInBand = await read($, isGateInBand)
    if (head !== undefined && isInBand) {
      return gateTree(kit, head, rest.length, 'Shown here because the pane does not fit.', actionsFor($))
    }
    if (changed !== undefined && isInBand) {
      return commandTree(kit, changed, more.length, 'Shown here because the pane does not fit.', actionsFor($))
    }
    const book = await read($, notebook)

    return book.entries.length === 0 ? next(e) : bandTree(kit, book, e.props.bodyColumns)
  })
}
