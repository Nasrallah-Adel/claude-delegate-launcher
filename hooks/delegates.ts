/**
 * Pure helpers for delegate-launcher: naming, the text a button or /delegate
 * puts in front of the model, spotting a relay.mjs run in a Bash command, and
 * reading its result.json. Nothing here touches `$`.
 */

/** Where skills live, relative to $HOME. */
export const SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const

/** Out dirs for runs the mod watches, under $TMPDIR. */
export const OUT_ROOT = 'delegate-launcher'

const DELEGATE_NAME = /^[a-z0-9][a-z0-9-]*-delegate$/
const RELAY = /([A-Za-z0-9_.-]+-delegate)\/scripts\/relay\.mjs(["']?)/
const OUT_DIR = /--out-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/
const HELP = /(^|\s)(--help|-h)(\s|$)/
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/
const SLASH_PREFIX = /^\/[a-z0-9-]+-delegate\s*/

export const isDelegateName = (name: string): boolean => DELEGATE_NAME.test(name)

/** `codex-delegate` → `codex`. */
export const shortName = (skill: string): string => skill.replace(/-delegate$/, '')

/** Unique, sorted delegate skill names from several directory listings. */
export function collectDelegates(names: readonly string[]): string[] {
  return [...new Set(names.filter(isDelegateName))].sort()
}

/** `codex` or `codex-delegate` → the found skill, if any. */
export function resolveSkill(found: readonly string[], word: string): string | undefined {
  const w = word.trim().toLowerCase()
  if (w === '') return undefined
  return found.find((skill) => skill === w || shortName(skill) === w)
}

/**
 * What a button puts in the prompt box: the skill's slash command, keeping
 * any draft already typed as the task (and swapping a previous delegate's
 * prefix rather than stacking two).
 */
export function prefillText(skill: string, draft: string): string {
  const task = draft.replace(SLASH_PREFIX, '').trim()
  return task === '' ? `/${skill} ` : `/${skill} ${task}`
}

/** What /delegate submits for the model. */
export const delegatePrompt = (skill: string, task: string): string =>
  `Use the ${skill} skill to delegate this task, then review and land the result: ${task.trim()}`

export type DelegateArgs =
  | { kind: 'config' }
  | { kind: 'list' }
  | { kind: 'pick'; name: string; task: string }

/** `/delegate`, `/delegate config`, `/delegate list`, `/delegate codex fix x`. */
export function parseDelegateArgs(args: string): DelegateArgs {
  const text = args.trim()
  if (text === '' || text === 'config') return { kind: 'config' }
  if (text === 'list') return { kind: 'list' }
  const [name, ...rest] = text.split(/\s+/)
  return { kind: 'pick', name: name ?? '', task: rest.join(' ') }
}

export type RelayRun = { skill: string; outDir?: string }

/** The delegate a Bash command runs relay.mjs for, and its --out-dir if given. */
export function findRelayRun(command: string): RelayRun | undefined {
  const match = RELAY.exec(command)
  if (!match || HELP.test(command)) return undefined
  const out = OUT_DIR.exec(command)
  const outDir = out ? out[1] ?? out[2] ?? out[3] : undefined
  return match[1] ? { skill: match[1], outDir } : undefined
}

/** Whether the mod can find result.json under `dir` as typed (no `$VAR`, `~`, or relative path). */
export const isWatchableDir = (dir: string): boolean => dir.startsWith('/') && SAFE_PATH.test(dir)

/** The command with `--out-dir '<dir>'` right after the first relay.mjs. */
export function withOutDir(command: string, dir: string): string {
  if (!SAFE_PATH.test(dir)) throw new Error(`unsafe out dir: ${dir}`)
  return command.replace(RELAY, (whole) => `${whole} --out-dir '${dir}'`)
}

export type RelayResult = { status: string; touched: number | null }

/** Reads the fields the toast needs; rejects anything not a relay result. */
export function parseResult(text: string): RelayResult {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null) throw new Error('result.json is not an object')
  const { status, touchedFiles } = data as { status?: unknown; touchedFiles?: unknown }
  if (typeof status !== 'string') throw new Error('result.json has no status')
  return { status, touched: Array.isArray(touchedFiles) ? touchedFiles.length : null }
}

/** `codex finished: completed, 3 files touched — review the diff`. */
export function resultLine(skill: string, result: RelayResult): string {
  const files =
    result.touched === null ? '' : `, ${result.touched} file${result.touched === 1 ? '' : 's'} touched`
  const tail = result.status === 'completed' ? ' — review the diff' : ''
  return `${shortName(skill)} finished: ${result.status}${files}${tail}`
}
