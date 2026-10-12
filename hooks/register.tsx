/**
 * delegate-launcher: one button per *-delegate skill above the prompt.
 *
 *   delegate [ codex ] [ agy ] [ copilot ] [ ⚙ ] [ runs 1 ]
 *
 * A press puts `/codex-delegate ` in the prompt box (keeping a draft already
 * typed as the task); you write the task and press Enter. `⚙` or
 * `/delegate config` picks which delegates get a button. `/delegate codex
 * <task>` sends a task straight away.
 *
 * When the model runs a delegate's relay.mjs, the mod gives it an --out-dir,
 * follows its live log in the Delegates pane (`runs`, `/delegate watch`), and
 * toasts when result.json lands. A finished run offers Continue (the same CLI
 * session, through the skill) and Copy resume (the CLI's own resume command).
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Run } from '../types'
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
import {
  TAIL_LINES,
  addRun,
  age,
  continueText,
  isRunning,
  liveLogName,
  newRun,
  patchRun,
  resultFields,
  resumeCommand,
  statusMark,
  summarizeEvent,
} from './runs'

const CONFIG_PANE = 'delegate-config'
const RUNS_PANE = 'delegate-runs'
const POLL_MS = 2_000
const RUN_TTL_MS = 3 * 60 * 60 * 1000
const CLEAR_DELAY_MS = 300
const STORE_ENABLED = 'enabled'
const STORE_RUNS = 'runs'

const found = atom({ plugin: 'delegate-launcher', key: 'found' } as const, [])
const enabled = atom({ plugin: 'delegate-launcher', key: 'enabled' } as const, null)
const runs = atom({ plugin: 'delegate-launcher', key: 'runs' } as const, [])
const selected = atom({ plugin: 'delegate-launcher', key: 'selected' } as const, null)
const tail = atom({ plugin: 'delegate-launcher', key: 'tail' } as const, [])

/** The poll timer; a hot reload starts it over and session.start resumes it. */
let timer: { cancel: () => void } | undefined

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function discover($: EngineInterface): Promise<string[]> {
  const home = await $.env.get('HOME')
  if (!home) return []
  const lists = await Promise.all(SKILL_DIRS.map((dir) => $.fs.list(`${home}/${dir}`).catch(() => [])))
  const names = lists.flat().filter((entry) => entry.kind !== 'file').map((entry) => entry.name)
  return collectDelegates(names)
}

async function setEnabled($: EngineInterface, next: string[]): Promise<void> {
  await update($, enabled, () => next)
  await $.store.set(STORE_ENABLED, next)
}

async function setRuns($: EngineInterface, fn: (list: Run[]) => Run[]): Promise<Run[]> {
  await update($, runs, fn)
  const list = await read($, runs)
  await $.store.set(STORE_RUNS, list)
  const running = list.filter(isRunning)
  $.ui.status(running.length === 0 ? undefined : `⇢ ${running.map((r) => shortName(r.skill)).join(', ')} running`)
  return list
}

/** Prefills the prompt box, telling the person when it could not. */
async function fill($: EngineInterface, text: string): Promise<void> {
  const filled = await $.prompt.fill({ text }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) $.ui.toast(`delegate-launcher: could not fill the prompt; type: ${text}`)
}

/** Prefills the prompt box with the skill's command, keeping any draft. */
async function prefill($: EngineInterface, skill: string): Promise<void> {
  const draft = await $.prompt.read()
  await fill($, prefillText(skill, draft.text))
}

/** A command.run hook may not submit (it would wait on itself), so submit once it returns. */
function submitLater($: EngineInterface, text: string): void {
  $.clock.after(0, () => {
    $.prompt.submit({ text, asUser: true }).catch((err) => $.ui.toast(`delegate-launcher: could not send: ${errText(err)}`))
  })
}

function openRuns($: EngineInterface, focus: boolean): void {
  void $.ui.open(focus ? { id: RUNS_PANE, title: 'Delegates', focus: true } : { id: RUNS_PANE, title: 'Delegates' })
}

/** Reads the selected run's last log lines into `tail`. */
async function refreshTail($: EngineInterface): Promise<void> {
  const outDir = await read($, selected)
  const run = (await read($, runs)).find((r) => r.outDir === outDir)
  if (!run) {
    await update($, tail, () => [])
    return
  }
  const path = `${run.outDir}/${liveLogName(run.skill)}`
  if (!(await $.fs.exists(path))) {
    await update($, tail, () => ['(no log yet)'])
    return
  }
  const { stdout } = await $.process.run(['tail', '-n', String(TAIL_LINES * 3), path], { timeoutMs: 5_000 })
  const lines = stdout.split('\n').map(summarizeEvent).filter((l): l is string => l !== undefined)
  await update($, tail, () => lines.slice(-TAIL_LINES))
}

async function select($: EngineInterface, outDir: string): Promise<void> {
  await update($, selected, () => outDir)
  await refreshTail($)
}

/** Closes a run: toast its result (or that it left none) and keep its session id. */
async function settle($: EngineInterface, run: Run, now: number): Promise<void> {
  const path = `${run.outDir}/result.json`
  if (!(await $.fs.exists(path))) {
    if (now - run.startedAt <= RUN_TTL_MS) return
    await setRuns($, (list) => patchRun(list, run.outDir, { status: 'no-result', finishedAt: now }))
    return
  }
  try {
    const result = parseResult(await $.fs.read(path))
    const line = resultLine(run.skill, result)
    await setRuns($, (list) =>
      patchRun(list, run.outDir, { status: result.status, touched: result.touched, finishedAt: now, ...resultFields(result.data) }),
    )
    $.ui.toast(line, { timeoutMs: 10_000 })
    $.ui.log(`delegate-launcher: ${line} (${path})`)
  } catch (err) {
    $.ui.log(`delegate-launcher: could not read ${path}: ${errText(err)}`, { to: 'debug' })
    await setRuns($, (list) => patchRun(list, run.outDir, { status: 'unreadable', finishedAt: now }))
  }
}

async function poll($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  for (const run of (await read($, runs)).filter(isRunning)) await settle($, run, now)
  await refreshTail($)
  if ((await read($, runs)).every((r) => !isRunning(r))) stopPolling()
}

/** A foreground run is over when its call returns: settle it, or say it left nothing. */
async function finishForeground($: EngineInterface, outDir: string): Promise<void> {
  await poll($)
  const run = (await read($, runs)).find((r) => r.outDir === outDir)
  if (!run || !isRunning(run)) return
  const now = await $.clock.now()
  await setRuns($, (list) => patchRun(list, outDir, { status: 'no-result', finishedAt: now }))
  $.ui.toast(`${shortName(run.skill)} relay ended without a result.json — check its output`)
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

async function copyResume($: EngineInterface, run: Run, surface: string | undefined): Promise<void> {
  const command = resumeCommand(run)
  if (!command) return
  const copied = await $.ui.copy(surface ? { text: command, surface: surface as never } : { text: command })
  $.ui.toast(copied.isCopied ? `Copied: ${command}` : `Copy failed; run: ${command}`)
}

/** Discovers delegates, restores the pick and the runs, resumes polling, opens the pane. */
async function boot($: EngineInterface, openPane: boolean): Promise<void> {
  await $.command.register({
    name: 'delegate',
    description: 'Delegate a task: /delegate <codex|agy|…> <task>, /delegate watch, /delegate config, /delegate list',
    argumentHint: '<name> <task> | watch | config | list',
  })
  const skills = await discover($)
  await update($, found, () => skills)
  const stored = await $.store.get(STORE_ENABLED)
  const picked = Array.isArray(stored) ? stored.filter((s): s is string => skills.includes(String(s))) : null
  await update($, enabled, () => picked)
  const saved = await $.store.get(STORE_RUNS)
  if (Array.isArray(saved) && saved.length > 0) {
    const list = await setRuns($, () => saved as Run[])
    await update($, selected, () => list[0]?.outDir ?? null)
    await refreshTail($).catch(() => undefined)
    if (list.some(isRunning)) startPolling($)
  }
  if (picked === null && skills.length > 0) {
    $.ui.toast(`delegate-launcher: found ${skills.length} delegates; press Set up above the prompt or run /delegate config`)
  }
  if (openPane && skills.length > 0) openRuns($, false)
}

export const register: Register = (on, options) => {
  const autoOpen = options.autoOpenPane !== false
  const openOnStart = options.openPaneOnStart !== false

  on('session.start', async ($, e, next) => {
    await boot($, openOnStart)
    return next(e)
  })

  // /clear raises no session.start: start over once the old conversation has ended.
  on('session.end', async ($, e, next) => {
    const ended = await next(e)
    if (e.reason === 'clear') {
      $.clock.after(CLEAR_DELAY_MS, () => {
        boot($, openOnStart).catch((err) => $.ui.log(`delegate-launcher: start after /clear failed: ${errText(err)}`, { to: 'debug' }))
      })
    }
    return ended
  })

  on('command.run', { command: 'delegate' }, async ($, e) => {
    const args = parseDelegateArgs(e.args)
    const skills = await read($, found)
    if (args.kind === 'config') {
      await $.ui.open({ id: CONFIG_PANE, title: 'Delegate buttons', focus: true })
      return { text: 'Pick which delegates get a button.' }
    }
    if (args.kind === 'list') {
      return { text: skills.length === 0 ? 'No *-delegate skills found.' : `Delegates: ${skills.map(shortName).join(', ')}` }
    }
    if (args.kind === 'watch') {
      openRuns($, true)
      return { text: 'Delegates pane opened.' }
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
    const relay = findRelayRun(e.command)
    if (!relay || (relay.outDir !== undefined && !isWatchableDir(relay.outDir))) return next(e)
    let outDir: string
    let command: string
    try {
      const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
      const startedAt = await $.clock.now()
      outDir = relay.outDir ?? `${tmp}/${OUT_ROOT}/${shortName(relay.skill)}-${startedAt}`
      command = relay.outDir ? e.command : withOutDir(e.command, outDir)
      await setRuns($, (list) => addRun(list.filter((r) => r.outDir !== outDir), newRun(relay.skill, outDir, startedAt)))
      await update($, selected, () => outDir)
      await update($, tail, () => ['(starting)'])
    } catch (err) {
      $.ui.log(`delegate-launcher: not watching this relay run: ${errText(err)}`, { to: 'debug' })
      return next(e)
    }
    if (autoOpen) openRuns($, false)
    startPolling($)
    if (e.run_in_background === true) return next({ ...e, command })
    const ran = await next({ ...e, command })
    await finishForeground($, outDir)
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const skills = await read($, found)
    const list = await read($, runs)
    if (skills.length === 0 && list.length === 0) return next(e)
    const picked = await read($, enabled)
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const openConfig = () => void $.ui.open({ id: CONFIG_PANE, title: 'Delegate buttons', focus: true })
    const running = list.filter(isRunning).length
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
          {list.length > 0 && (
            <Button key="runs" label={running > 0 ? `runs ${running}…` : 'runs'} onPress={() => openRuns($, true)} />
          )}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: CONFIG_PANE }, async ($, e) => {
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
          <Button key="done" label="Done" onPress={() => void $.ui.close({ id: CONFIG_PANE })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: RUNS_PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, runs)
    const now = await $.clock.now()
    const chosen = await read($, selected)
    const current = list.find((r) => r.outDir === chosen) ?? list[0]
    const lines = await read($, tail)
    const picked = (await read($, enabled)) ?? (await read($, found))
    const launch = (
      <Box>
        <Text dimColor>new </Text>
        {picked.map((skill) => (
          <Button key={`p-${skill}`} label={shortName(skill)} onPress={() => void prefill($, skill)} />
        ))}
      </Box>
    )
    if (!current) {
      return (
        <Box flexDirection="column">
          {launch}
          <Text dimColor>No delegate runs yet. Press a delegate to write a task for it.</Text>
        </Box>
      )
    }
    const resume = resumeCommand(current)
    return (
      <Box flexDirection="column">
        {launch}
        {list.map((run) => (
          <Button
            key={`r-${run.outDir}`}
            label={`${run === current ? '▸' : ' '} ${statusMark(run)} ${shortName(run.skill)} ${run.status} · ${age((run.finishedAt ?? now) - run.startedAt)}`}
            onPress={() => void select($, run.outDir)}
          />
        ))}
        <Text dimColor>{`── ${shortName(current.skill)} · ${current.outDir}`}</Text>
        {lines.map((line) => (
          <Text>{line}</Text>
        ))}
        {!isRunning(current) && (
          <Box>
            {current.sessionId !== null && (
              <Button key="continue" label="Continue" onPress={() => void fill($, continueText(current))} />
            )}
            {resume !== undefined && (
              <Button key="resume" label="Copy resume" onPress={(press) => void copyResume($, current, press?.surface)} />
            )}
            <Button
              key="clear"
              label="Clear finished"
              onPress={() => void setRuns($, (all) => all.filter(isRunning))}
            />
          </Box>
        )}
      </Box>
    )
  })
}
