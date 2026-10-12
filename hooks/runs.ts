/**
 * Pure helpers for the Delegates pane: the run record, a one-line view of a
 * relay event, the follow-up text for Continue, and each CLI's own resume
 * command. Nothing here touches `$`.
 */
import type { Run } from '../types'
import { shortName } from './delegates'

/** Runs kept in the pane, newest first. */
export const MAX_RUNS = 10

/** Event lines shown for the selected run. */
export const TAIL_LINES = 14

const LINE_WIDTH = 110

/** The live log each relay appends to while it runs; agy writes plain text. */
export const liveLogName = (skill: string): string => (shortName(skill) === 'agy' ? 'agy.log' : 'events.jsonl')

export const newRun = (skill: string, outDir: string, startedAt: number): Run => ({
  skill, outDir, startedAt, status: 'running', sessionId: null, touched: null, workdir: null, finishedAt: null,
})

/** Adds a run at the top, keeping the newest MAX_RUNS. */
export const addRun = (runs: readonly Run[], run: Run): Run[] => [run, ...runs].slice(0, MAX_RUNS)

/** Replaces the run with this outDir by `patch`. */
export const patchRun = (runs: readonly Run[], outDir: string, patch: Partial<Run>): Run[] =>
  runs.map((run) => (run.outDir === outDir ? { ...run, ...patch } : run))

export const isRunning = (run: Run): boolean => run.status === 'running'

/** `4m`, `1h 05m`, `12s`. */
export function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function statusMark(run: Run): string {
  if (isRunning(run)) return '…'
  return run.status === 'completed' ? '✓' : '✗'
}

/** The fields of result.json the pane keeps. */
export function resultFields(data: Record<string, unknown>): Pick<Run, 'sessionId' | 'workdir'> {
  const id = [data.threadId, data.sessionId, data.conversationId, data.session].find(
    (v): v is string => typeof v === 'string' && v !== '',
  )
  return { sessionId: id ?? null, workdir: typeof data.workdir === 'string' ? data.workdir : null }
}

const oneLine = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > LINE_WIDTH ? `${flat.slice(0, LINE_WIDTH - 1)}…` : flat
}

const firstText = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(firstText).filter((t): t is string => t !== undefined).join(' ') || undefined
  }
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>
    for (const key of ['text', 'command', 'content', 'name', 'path', 'message']) {
      const found = firstText(o[key])
      if (found) return found
    }
  }
  return undefined
}

/** One relay event as a short line: `type: text`. A non-JSON line is kept as is. */
export function summarizeEvent(line: string): string | undefined {
  const raw = line.trim()
  if (raw === '') return undefined
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return oneLine(raw)
  }
  if (typeof data !== 'object' || data === null) return oneLine(raw)
  const o = data as Record<string, unknown>
  const nested = (k: string) => (typeof o[k] === 'object' && o[k] !== null ? (o[k] as Record<string, unknown>) : {})
  const type = [o.type, o.event, nested('item').type, nested('msg').type, nested('part').type].find(
    (v): v is string => typeof v === 'string',
  )
  const text = firstText(o.item) ?? firstText(o.part) ?? firstText(o.msg) ?? firstText(o.message) ?? firstText(o.text) ?? firstText(o.data)
  if (!type && !text) return undefined
  return oneLine([type, text].filter(Boolean).join(': '))
}

/** What Continue puts in the prompt box: the skill, the session, room for the follow-up. */
export function continueText(run: Run): string {
  const cd = run.workdir ? ` --cd ${run.workdir}` : ''
  return `/${run.skill} Continue the earlier ${shortName(run.skill)} run with relay --session ${run.sessionId}${cd} and send only this follow-up: `
}

const RESUME: Record<string, (id: string) => string> = {
  codex: (id) => `codex resume ${id}`,
  claude: (id) => `claude --resume ${id}`,
  copilot: (id) => `copilot --resume=${id}`,
  opencode: (id) => `opencode --session ${id}`,
  agy: (id) => `agy --conversation ${id}`,
}

/** The CLI's own command to open this session interactively, if known. */
export function resumeCommand(run: Run): string | undefined {
  const make = RESUME[shortName(run.skill)]
  if (!make || !run.sessionId) return undefined
  const cd = run.workdir ? `cd '${run.workdir}' && ` : ''
  return `${cd}${make(run.sessionId)}`
}
