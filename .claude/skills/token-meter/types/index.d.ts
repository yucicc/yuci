/** The four token counts of a request, as the API reports them. */
export type Counts = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One rate-limit window (the 5-hour or the weekly allowance). */
export type Limit = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

/** The account-side figures, as read when the last turn ended. */
export type Snapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  limits: Limit[]
  usd?: number
  readAt: number
}

/** Everything the meter keeps for one session. */
export type Meter = {
  /** Every request of the session, subagents included. */
  total: Counts
  /** What has been spent since the last main turn ended. */
  pending: Counts
  /** The last finished main turn, with the subagents it ran. */
  last: Counts | null
  /** The model that answered last. */
  model: string | null
  /** How many main turns have ended. */
  turns: number
  snapshot: Snapshot | null
}

declare module 'claude-code' {
  interface PluginState {
    'token-meter': { meter: Shaped<Meter>; isQuiet: boolean }
  }
}
