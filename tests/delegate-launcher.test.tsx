// delegate-launcher through the engine's kit: discovery, the band and its
// prefill, the config pane, /delegate, and the relay watch with its toast.
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import {
  findRelayRun,
  parseDelegateArgs,
  parseResult,
  prefillText,
  resolveSkill,
  resultLine,
  withOutDir,
} from '../hooks/delegates'
import { age, continueText, newRun, resumeCommand, summarizeEvent } from '../hooks/runs'

const HOME = '/home/me'
const SKILLS = ['codex-delegate', 'agy-delegate', 'code-review', 'copilot-delegate']

type Calls = {
  filled: string[]
  submitted: string[]
  toasts: string[]
  store: Map<string, unknown>
  files: Map<string, string>
  ticks: (() => void)[]
  copied: string[]
  draft: string
}

function fakeEngine(on: On, stored: Record<string, unknown> = {}): Calls {
  const c: Calls = {
    filled: [], submitted: [], toasts: [], store: new Map(Object.entries(stored)),
    files: new Map(), ticks: [], copied: [], draft: '',
  }
  const value = (v: unknown) => ({ value: v }) as never
  on('env.get', ($, e) => value((e as { name: string }).name === 'HOME' ? HOME : '/tmp/t/'))
  on('fs.list', ($, e) =>
    value((e as { path: string }).path === `${HOME}/.claude/skills`
      ? SKILLS.map((name) => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false }))
      : []))
  on('fs.exists', ($, e) => value(c.files.has((e as { path: string }).path)))
  on('fs.read', ($, e) => value(c.files.get((e as { path: string }).path)))
  on('store.get', ($, e) => value(c.store.get((e as { key: string }).key)))
  on('store.set', ($, e) => {
    const { key, value: v } = e as { key: string; value: unknown }
    c.store.set(key, v)
    return value(undefined)
  })
  // one clock.every dispatch per period: the plugin's fn runs when it resolves
  on('clock.every', () => new Promise((resolve) => { c.ticks.push(() => resolve(value(undefined))) }))
  on('clock.after', () => value(undefined))
  let now = 1_000
  on('clock.now', () => value(now++))
  on('session.start', () => ({ cwd: '/repo' }) as never)
  on('command.register', ($, e) => value({ command: (e as { name: string }).name }))
  on('prompt.read', () => value({ text: c.draft, cursor: c.draft.length }))
  on('prompt.fill', ($, e) => { c.filled.push(e.text); return { isFilled: true } as never })
  on('prompt.submit', ($, e) => { c.submitted.push(e.text); return { text: e.text, origin: e.origin } as never })
  on('ui.log', () => value(undefined))
  on('ui.status', () => value(undefined))
  on('ui.open', () => value({ isPlaced: true }))
  on('ui.copy', ($, e) => { c.copied.push((e as { text: string }).text); return value({ isCopied: true }) })
  on('process.run', ($, e) => {
    const argv = (e as { argv: string[] }).argv
    return value({ exitCode: 0, stdout: c.files.get(argv.at(-1) ?? '') ?? '', stderr: '' })
  })
  on('ui.toast', ($, e) => { c.toasts.push((e as { text: string }).text); return value(undefined) })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  return c
}

// the kit runs on a host with timers; the mod environment types none
declare const setTimeout: (fn: () => void, ms: number) => unknown
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 20) })
const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
const props = () =>
  ({ hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { bodyRows: 3, top: 0 }, view: {} }) as never
const band = ($: Engine, surface: 'terminal' | 'desktop') =>
  $.ui.mount({ plugin: 'delegate-launcher', surface, component: 'AbovePrompt', props: props() })

describe('helpers', () => {
  test('prefill keeps a draft and swaps an earlier delegate prefix', () => {
    expect(prefillText('codex-delegate', '')).toBe('/codex-delegate ')
    expect(prefillText('codex-delegate', '  fix the parser ')).toBe('/codex-delegate fix the parser')
    expect(prefillText('agy-delegate', '/codex-delegate fix it')).toBe('/agy-delegate fix it')
  })

  test('resolves short and full names, only among found', () => {
    const found = ['agy-delegate', 'codex-delegate']
    expect(resolveSkill(found, 'Codex')).toBe('codex-delegate')
    expect(resolveSkill(found, 'agy-delegate')).toBe('agy-delegate')
    expect(resolveSkill(found, 'cursor')).toBeUndefined()
  })

  test('parses /delegate arguments', () => {
    expect(parseDelegateArgs('')).toEqual({ kind: 'config' })
    expect(parseDelegateArgs(' list ')).toEqual({ kind: 'list' })
    expect(parseDelegateArgs('codex fix the  bug')).toEqual({ kind: 'pick', name: 'codex', task: 'fix the bug' })
  })

  test('spots relay runs and their out dir, not --help', () => {
    const cmd = 'node "/x/codex-delegate/scripts/relay.mjs" --brief b.txt --cd /repo'
    expect(findRelayRun(cmd)).toEqual({ skill: 'codex-delegate', outDir: undefined })
    expect(findRelayRun(`${cmd} --out-dir '/o d'`)?.outDir).toBe('/o d')
    expect(findRelayRun(`${cmd} --out-dir=/o/x; echo`)?.outDir).toBe('/o/x')
    expect(findRelayRun('node /x/codex-delegate/scripts/relay.mjs --help')).toBeUndefined()
    expect(findRelayRun('ls -la')).toBeUndefined()
    expect(findRelayRun('grep -n x ~/.claude/skills/codex-delegate/scripts/relay.mjs')).toBeUndefined()
    expect(findRelayRun("sed -n 1,9p codex-delegate/scripts/relay.mjs | node -e 'x'")).toBeUndefined()
    expect(findRelayRun('cat b.txt | node /x/agy-delegate/scripts/relay.mjs --cd .')?.skill).toBe('agy-delegate')
  })

  test('inserts --out-dir after the script, before redirects', () => {
    const cmd = 'node "/x/agy-delegate/scripts/relay.mjs" --brief b > log 2>&1'
    expect(withOutDir(cmd, '/tmp/o')).toBe(`node "/x/agy-delegate/scripts/relay.mjs" --out-dir '/tmp/o' --brief b > log 2>&1`)
    expect(() => withOutDir(cmd, "/tmp/it's")).toThrow()
  })

  test('summarizes a result and rejects junk', () => {
    const ok = parseResult('{"status":"completed","touchedFiles":[" M a.ts"," M b.ts"]}')
    expect(resultLine('codex-delegate', ok)).toBe('codex finished: completed, 2 files touched — review the diff')
    expect(resultLine('agy-delegate', parseResult('{"status":"failed","touchedFiles":null}'))).toBe('agy finished: failed')
    expect(() => parseResult('[]')).toThrow()
    expect(() => parseResult('{"x":1}')).toThrow()
  })
})

describe('the band', () => {
  test('before setup it shows one Set up button and toasts once', async ($, on) => {
    const c = fakeEngine(on)
    await start($)
    expect(c.toasts.at(-1)).toContain('found 3 delegates')
    const ui = await band($, 'terminal')
    expect((await ui.findAll({ type: 'Button' })).length).toBe(1)
    expect(await ui.find({ type: 'Button', text: 'Set up' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beneath/ })).toBeDefined()
  })

  test('a delegate button prefills its command, keeping the draft', async ($, on) => {
    const c = fakeEngine(on, { enabled: ['codex-delegate', 'agy-delegate', 'gone-delegate'] })
    await start($)
    for (const surface of ['terminal', 'desktop'] as const) {
      c.filled.length = 0
      const ui = await band($, surface)
      expect((await ui.findAll({ type: 'Button' })).length).toBe(3) // codex, agy, ⚙ (gone filtered)
      c.draft = ''
      await ui.press({ key: 'd-codex-delegate' })
      c.draft = 'add tests for utils'
      await ui.press({ key: 'd-agy-delegate' })
      expect(c.filled).toEqual(['/codex-delegate ', '/agy-delegate add tests for utils'])
      await ui.unmount()
    }
  })
})

describe('the config pane', () => {
  test('toggles persist and show in the band', async ($, on) => {
    const c = fakeEngine(on)
    await start($)
    const pane = await $.ui.mount({ plugin: 'delegate-launcher', surface: 'terminal', component: 'Pane', requestId: 'delegate-config', props: {} as never })
    expect((await pane.findAll({ type: 'Button', text: /\[ \]/ })).length).toBe(3)
    await pane.press({ key: 't-copilot-delegate' })
    expect(c.store.get('enabled')).toEqual(['copilot-delegate'])
    await pane.press({ key: 'all' })
    expect(c.store.get('enabled')).toEqual(['agy-delegate', 'codex-delegate', 'copilot-delegate'])
    const ui = await band($, 'terminal')
    expect((await ui.findAll({ type: 'Button' })).length).toBe(4)
  })
})

describe('/delegate', () => {
  test('sends a task, prefills without one, and names unknowns', async ($, on) => {
    const c = fakeEngine(on)
    await start($)
    const sent = await $.command.run({ command: 'delegate', args: 'codex fix the flaky test' } as never)
    expect(sent.text).toContain('Sent to codex')
    await settle()
    expect(c.submitted.at(-1)).toContain('Use the codex-delegate skill')
    expect(c.submitted.at(-1)).toContain('fix the flaky test')
    await $.command.run({ command: 'delegate', args: 'agy' } as never)
    expect(c.filled.at(-1)).toBe('/agy-delegate ')
    const bad = await $.command.run({ command: 'delegate', args: 'cursor do x' } as never)
    expect(bad.text).toContain('Unknown delegate "cursor"')
  })
})

describe('the relay watch', () => {
  test('a background run: adds --out-dir, then toasts when result.json lands', async ($, on) => {
    const c = fakeEngine(on)
    let ran = ''
    on('tool.call', { tool: 'Bash' }, ($, e) => { ran = e.command; return { result: { stdout: 'ok' } } as never })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'node /h/codex-delegate/scripts/relay.mjs --brief b.txt', description: 'run', run_in_background: true } as never)
    const out = /--out-dir '([^']+)'/.exec(ran)?.[1] ?? ''
    expect(out).toBe('/tmp/t/delegate-launcher/codex-1000')
    expect(c.ticks.length).toBe(1)
    c.files.set(`${out}/result.json`, '{"status":"completed","touchedFiles":[" M a.ts"]}')
    c.ticks[0]?.()
    await settle()
    expect(c.toasts.at(-1)).toBe('codex finished: completed, 1 file touched — review the diff')
    const runs = c.store.get('runs') as { status: string }[]
    expect(runs[0]?.status).toBe('completed')
  })

  test('a foreground run toasts its result, or that it left none', async ($, on) => {
    const c = fakeEngine(on)
    let writes = true
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      const out = /--out-dir '([^']+)'/.exec(e.command)?.[1] ?? ''
      if (writes) c.files.set(`${out}/result.json`, '{"status":"failed","touchedFiles":[]}')
      return { result: { stdout: 'done' } } as never
    })
    await start($)
    const call = { tool: 'Bash', command: 'node /h/agy-delegate/scripts/relay.mjs --brief b', description: 'run' } as never
    await $.tool.call(call)
    expect(c.toasts.at(-1)).toBe('agy finished: failed, 0 files touched')
    writes = false
    await $.tool.call(call)
    expect(c.toasts.at(-1)).toContain('agy relay ended without a result.json')
    expect((c.store.get('runs') as { status: string }[]).map((r) => r.status)).toEqual(['no-result', 'failed'])
  })

  test('an --out-dir it cannot resolve ($VAR, ~) is left alone, unwatched', async ($, on) => {
    const c = fakeEngine(on)
    let ran = ''
    on('tool.call', { tool: 'Bash' }, ($, e) => { ran = e.command; return { result: { stdout: 'ok' } } as never })
    await start($)
    const command = 'node /h/codex-delegate/scripts/relay.mjs --out-dir "$OUT" --brief b'
    await $.tool.call({ tool: 'Bash', command, description: 'run', run_in_background: true } as never)
    expect(ran).toBe(command)
    expect(c.store.get('runs')).toBeUndefined()
  })
})

describe('runs helpers', () => {
  test('summarizes codex, claude and plain log lines', () => {
    expect(summarizeEvent('{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}'))
      .toBe('item.completed: npm test')
    expect(summarizeEvent('{"type":"assistant","message":{"content":[{"type":"text","text":"Editing  src/a.ts"}]}}'))
      .toBe('assistant: Editing src/a.ts')
    expect(summarizeEvent('agy: wrote file x')).toBe('agy: wrote file x')
    expect(summarizeEvent('   ')).toBeUndefined()
    expect(summarizeEvent(`{"type":"t","text":"${'x'.repeat(300)}"}`)?.length).toBe(110)
  })

  test('continue and resume use the session id and workdir', () => {
    const run = { ...newRun('codex-delegate', '/o', 0), status: 'completed', sessionId: 'th_1', workdir: '/repo' }
    expect(continueText(run)).toContain('/codex-delegate Continue')
    expect(continueText(run)).toContain('--session th_1 --cd /repo')
    expect(resumeCommand(run)).toBe("cd '/repo' && codex resume th_1")
    expect(resumeCommand({ ...run, skill: 'kimi-delegate' })).toBeUndefined()
    expect(resumeCommand({ ...run, sessionId: null })).toBeUndefined()
    expect(age(65_000)).toBe('1m')
    expect(age(3_900_000)).toBe('1h 05m')
  })
})

describe('the Delegates pane', () => {
  test('shows the live tail, then Continue and Copy resume once done', async ($, on) => {
    const c = fakeEngine(on)
    let out = ''
    on('tool.call', { tool: 'Bash' }, ($, e) => {
      out = /--out-dir '([^']+)'/.exec(e.command)?.[1] ?? ''
      return { result: { stdout: 'ok' } } as never
    })
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'node /h/codex-delegate/scripts/relay.mjs --brief b', description: 'run', run_in_background: true } as never)
    c.files.set(`${out}/events.jsonl`, '{"type":"item.started","item":{"command":"npm test"}}\n')
    c.ticks[0]?.()
    await settle()
    const mount = () => $.ui.mount({ plugin: 'delegate-launcher', surface: 'terminal', component: 'Pane', requestId: 'delegate-runs', props: {} as never })
    let pane = await mount()
    expect(await pane.find({ type: 'Text', text: /item.started: npm test/ })).toBeDefined()
    expect(await pane.find({ type: 'Button', key: 'continue' })).toBeUndefined()
    await pane.unmount()
    c.files.set(`${out}/result.json`, '{"status":"completed","touchedFiles":[],"threadId":"th_9","workdir":"/repo"}')
    c.ticks[1]?.()
    await settle()
    pane = await mount()
    await pane.press({ key: 'continue' })
    expect(c.filled.at(-1)).toContain('--session th_9 --cd /repo')
    await pane.press({ key: 'resume' })
    expect(c.copied.at(-1)).toBe("cd '/repo' && codex resume th_9")
    await pane.press({ key: 'clear' })
    expect(c.store.get('runs')).toEqual([])
  })

  test('the band shows a runs button once a run exists', async ($, on) => {
    fakeEngine(on, { enabled: ['codex-delegate'], runs: [{ ...newRun('codex-delegate', '/o', 0), status: 'completed' }] })
    await start($)
    const ui = await band($, 'terminal')
    expect(await ui.find({ type: 'Button', key: 'runs' })).toBeDefined()
  })
})
