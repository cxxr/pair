export type PairEntry = { id: number; kind: 'decided' | 'open'; text: string }

export type PairNotebook = { nextId: number; entries: PairEntry[] }

export type PairPendingEdit = {
  id: string
  tool: 'Edit' | 'Write'
  path: string
  why: string
  diff: string
  note: string
  isWide: boolean
}

export type PairChunk = { path: string; diff: string; added: number; removed: number }

// What one Bash command changed, cut into chunks the user steps through.
export type PairCommandReview = {
  id: string
  command: string
  root: string
  before: string
  files: number
  added: number
  removed: number
  chunks: PairChunk[]
  hidden: number
  at: number
  flagged: number[]
}

// Where the files stood when the user took over: a git tree of the whole work
// tree, or outside a repository the text of each file being watched.
export type PairDrive =
  | { kind: 'git'; root: string; tree: string }
  | { kind: 'files'; files: Record<string, string | null> }

// One review as the session summary lists it: what was reviewed, how big, and how it ended.
export type PairLogEntry = { what: string; size: string; outcome: string }

declare module 'claude-code' {
  interface PluginState {
    pair: {
      isOn: boolean
      notebook: PairNotebook
      notebookName: string
      pending: PairPendingEdit[]
      commands: PairCommandReview[]
      log: PairLogEntry[]
      isGateInBand: boolean
      hasSentInstructions: boolean
      drive: PairDrive | null
      touched: string[]
      explanations: Record<string, string>
      tick: number
    }
  }
}
