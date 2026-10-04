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

// Where the files stood when the user took over: a git tree of the whole work
// tree, or outside a repository the text of each file being watched.
export type PairDrive =
  | { kind: 'git'; root: string; tree: string }
  | { kind: 'files'; files: Record<string, string | null> }

declare module 'claude-code' {
  interface PluginState {
    pair: {
      isOn: boolean
      notebook: PairNotebook
      pending: PairPendingEdit[]
      isGateInBand: boolean
      hasSentInstructions: boolean
      drive: PairDrive | null
      touched: string[]
      explanations: Record<string, string>
      tick: number
    }
  }
}
