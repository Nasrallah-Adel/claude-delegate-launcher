/**
 * delegate-launcher: one button per *-delegate skill above the prompt.
 *
 *   delegate [ codex ] [ agy ] [ copilot ] [ ⚙ ]
 *
 * A press puts `/codex-delegate ` in the prompt box (keeping a draft already
 * typed as the task); you write the task and press Enter. `⚙` or
 * `/delegate config` picks which delegates get a button. `/delegate codex
 * <task>` sends a task straight away. When the model runs a delegate's
 * relay.mjs, the mod watches its result.json and toasts when it lands.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Watch } from '../types'
import {
  OUT_ROOT,
  SKILL_DIRS,
  collectDelegates,
  delegatePrompt,
  findRelayRun,
  isWatchableDir,
  parseDelegateArgs,
  parseResult,
  prefillText,
  resolveSkill,
  resultLine,
  shortName,
  withOutDir,
} from './delegates'

const PANE = 'delegate-config'
const POLL_MS = 5_000
const WATCH_TTL_MS = 3 * 60 * 60 * 1000
const STORE_ENABLED = 'enabled'
const STORE_WATCHES = 'watches'

const found = atom({ plugin: 'delegate-launcher', key: 'found' } as const, [])
const enabled = atom({ plugin: 'delegate-launcher', key: 'enabled' } as const, null)
const watches = atom({ plugin: 'delegate-launcher', key: 'watches' } as const, [])

/** The poll timer; a hot reload starts it over and session.start resumes it. */
let timer: { cancel: () => void } | undefined

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function discover($: EngineInterface): Promise<string[]> {
  const home = await $.env.get('HOME')
  if (!home) return []
  const lists = await Promise.all(
    SKILL_DIRS.map((dir) =>
      $.fs.list(`${home}/${dir}`).catch(() => []),
    ),
  )
  const names = lists.flat().filter((entry) => entry.kind !== 'file').map((entry) => entry.name)
  return collectDelegates(names)
}

async function setEnabled($: EngineInterface, next: string[]): Promise<void> {
  await update($, enabled, () => next)
  await $.store.set(STORE_ENABLED, next)
}

async function setWatches($: EngineInterface, fn: (list: Watch[]) => Watch[]): Promise<Watch[]> {
  await update($, watches, fn)
  const list = await read($, watches)
  await $.store.set(STORE_WATCHES, list)
  $.ui.status(list.length === 0 ? undefined : `⇢ ${list.map((w) => shortName(w.skill)).join(', ')} running`)
  return list
}

/** Prefills the prompt box with the skill's command, keeping any draft. */
async function prefill($: EngineInterface, skill: string): Promise<void> {
  const draft = await $.prompt.read()
  const filled = await $.prompt.fill({ text: prefillText(skill, draft.text) }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`delegate-launcher: could not fill the prompt; type /${skill} <task>`)
}

/** A command.run hook may not submit (it would wait on itself), so submit once it returns. */
function submitLater($: EngineInterface, text: string): void {
  $.clock.after(0, () => {
    $.prompt.submit({ text, asUser: true }).catch((err) => $.ui.toast(`delegate-launcher: could not send: ${errText(err)}`))
  })
}

async function poll($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const done: Watch[] = []
  for (const watch of await read($, watches)) {
    const path = `${watch.outDir}/result.json`
    if (!(await $.fs.exists(path))) {
      if (now - watch.startedAt > WATCH_TTL_MS) done.push(watch)
      continue
    }
    try {
      const line = resultLine(watch.skill, parseResult(await $.fs.read(path)))
      $.ui.toast(line, { timeoutMs: 10_000 })
      $.ui.log(`delegate-launcher: ${line} (${path})`)
    } catch (err) {
      $.ui.log(`delegate-launcher: could not read ${path}: ${errText(err)}`, { to: 'debug' })
    }
    done.push(watch)
  }
  if (done.length === 0) return
  const left = await setWatches($, (list) => list.filter((w) => !done.some((d) => d.outDir === w.outDir)))
  if (left.length === 0) stopPolling()
}

/** A foreground run is over when its call returns: toast its result, or that it left none. */
async function finishForeground($: EngineInterface, watch: Watch): Promise<void> {
  await poll($)
  const still = (await read($, watches)).some((w) => w.outDir === watch.outDir)
  if (!still) return
  await setWatches($, (list) => list.filter((w) => w.outDir !== watch.outDir))
  $.ui.toast(`${shortName(watch.skill)} relay ended without a result.json — check its output`)
}

function startPolling($: EngineInterface): void {
  timer ??= $.clock.every(POLL_MS, () => {
    poll($).catch((err) => $.ui.log(`delegate-launcher: poll failed: ${errText(err)}`, { to: 'debug' }))
  })
}
function stopPolling(): void {
  timer?.cancel()
  timer = undefined
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'delegate',
      description: 'Delegate a task: /delegate <codex|agy|…> <task>, /delegate config, /delegate list',
      argumentHint: '<name> <task> | config | list',
    })
    const skills = await discover($)
    await update($, found, () => skills)
    const stored = await $.store.get(STORE_ENABLED)
    const picked = Array.isArray(stored) ? stored.filter((s): s is string => skills.includes(String(s))) : null
    await update($, enabled, () => picked)
    const saved = await $.store.get(STORE_WATCHES)
    if (Array.isArray(saved) && saved.length > 0) {
      await setWatches($, () => saved as Watch[])
      startPolling($)
    }
    if (picked === null && skills.length > 0) {
      $.ui.toast(`delegate-launcher: found ${skills.length} delegates; press Set up above the prompt or run /delegate config`)
    }
    return next(e)
  })

  on('command.run', { command: 'delegate' }, async ($, e) => {
    const args = parseDelegateArgs(e.args)
    const skills = await read($, found)
    if (args.kind === 'config') {
      await $.ui.open({ id: PANE, title: 'Delegate buttons', focus: true })
      return { text: 'Pick which delegates get a button.' }
    }
    if (args.kind === 'list') {
      return { text: skills.length === 0 ? 'No *-delegate skills found.' : `Delegates: ${skills.map(shortName).join(', ')}` }
    }
    const skill = resolveSkill(skills, args.name)
    if (!skill) {
      return { text: `Unknown delegate "${args.name}". Installed: ${skills.map(shortName).join(', ') || 'none'}` }
    }
    if (args.task === '') {
      await prefill($, skill)
      return { text: `Write the task for ${shortName(skill)} and press Enter.` }
    }
    submitLater($, delegatePrompt(skill, args.task))
    return { text: `Sent to ${shortName(skill)}.` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const run = findRelayRun(e.command)
    if (!run || (run.outDir !== undefined && !isWatchableDir(run.outDir))) return next(e)
    let watch: Watch
    let command: string
    try {
      const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
      const startedAt = await $.clock.now()
      const outDir = run.outDir ?? `${tmp}/${OUT_ROOT}/${shortName(run.skill)}-${startedAt}`
      command = run.outDir ? e.command : withOutDir(e.command, outDir)
      watch = { skill: run.skill, outDir, startedAt }
      await setWatches($, (list) => [...list, watch])
    } catch (err) {
      $.ui.log(`delegate-launcher: not watching this relay run: ${errText(err)}`, { to: 'debug' })
      return next(e)
    }
    if (e.run_in_background === true) {
      startPolling($)
      return next({ ...e, command })
    }
    const ran = await next({ ...e, command })
    await finishForeground($, watch)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const skills = await read($, found)
    if (skills.length === 0) return next(e)
    const picked = await read($, enabled)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const openConfig = () => void $.ui.open({ id: PANE, title: 'Delegate buttons', focus: true })
    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>delegate </Text>
          {picked === null ? (
            <Button key="setup" label="Set up" onPress={openConfig} />
          ) : (
            picked.map((skill) => (
              <Button key={`d-${skill}`} label={shortName(skill)} onPress={() => void prefill($, skill)} />
            ))
          )}
          {picked !== null && <Button key="config" label="⚙" onPress={openConfig} />}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const skills = await read($, found)
    const picked = (await read($, enabled)) ?? []
    const toggle = (skill: string) =>
      void setEnabled($, picked.includes(skill) ? picked.filter((s) => s !== skill) : [...picked, skill].sort())
    return (
      <Box flexDirection="column">
        {skills.length === 0 && <Text dimColor>No *-delegate skills in ~/.claude/skills or ~/.agents/skills.</Text>}
        {skills.length > 0 && <Text dimColor>Press a delegate to show or hide its button above the prompt.</Text>}
        {skills.map((skill) => (
          <Button
            key={`t-${skill}`}
            label={`${picked.includes(skill) ? '[x]' : '[ ]'} ${shortName(skill)}`}
            onPress={() => toggle(skill)}
          />
        ))}
        <Box>
          <Button key="all" label="All" onPress={() => void setEnabled($, [...skills])} />
          <Button key="none" label="None" onPress={() => void setEnabled($, [])} />
          <Button key="done" label="Done" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
