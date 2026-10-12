/** One relay run being watched for its result.json. */
export type Watch = { skill: string; outDir: string; startedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'delegate-launcher': {
      /** `*-delegate` skill names found on disk, sorted. */
      found: string[]
      /** The skills that get a button; `null` until the person configures it. */
      enabled: string[] | null
      /** Relay runs still running. */
      watches: Watch[]
    }
  }
}
