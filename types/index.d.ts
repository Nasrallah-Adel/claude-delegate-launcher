/** One relay run the mod saw start: running, or finished with its result. */
export type Run = {
  skill: string
  outDir: string
  startedAt: number
  /** `running`, a result.json status (`completed`, `failed`, …), or `no-result`. */
  status: string
  /** The CLI's session id from result.json (threadId / sessionId / conversationId). */
  sessionId: string | null
  touched: number | null
  workdir: string | null
  finishedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'delegate-launcher': {
      /** `*-delegate` skill names found on disk, sorted. */
      found: string[]
      /** The skills that get a button; `null` until the person configures it. */
      enabled: string[] | null
      /** The last runs, newest first. */
      runs: Run[]
      /** The outDir of the run the pane shows. */
      selected: string | null
      /** The selected run's last log lines, summarized. */
      tail: string[]
    }
  }
}
