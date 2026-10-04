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

declare module 'claude-code' {
  interface PluginState {
    pair: {
      isOn: boolean
      notebook: PairNotebook
      pending: PairPendingEdit[]
      isGateInBand: boolean
      hasSentInstructions: boolean
      explanations: Record<string, string>
      tick: number
    }
  }
}
