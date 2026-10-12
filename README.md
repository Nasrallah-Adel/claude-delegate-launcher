# delegate-launcher

A Claude Code mod for the [**delegate-skills**](https://github.com/amElnagdy/delegate-skills) package by
[@amElnagdy](https://github.com/amElnagdy): one button per installed `*-delegate` skill above the prompt,
so handing a task to Codex, Antigravity, Copilot, OpenCode or another Claude Code session is one click away.

```
delegate [ agy ] [ codex ] [ copilot ] [ ⚙ ]
```

The skills do the real work: write the brief, dispatch it through `relay.mjs`, review the diff and land it.
This mod is only the launcher and the "it finished" signal. It never runs a relay itself and never commits.

## What it does

| Piece | Behaviour |
| --- | --- |
| **Setup** | Finds the `*-delegate` skills in `~/.claude/skills` and `~/.agents/skills`. Until you pick, the band shows one **Set up** button; it, `⚙`, or `/delegate config` opens a pane where you tick which delegates get a button (All / None / Done). The pick is kept across sessions. |
| **Buttons** | A press puts `/codex-delegate ` in the prompt box. You write the task and press Enter. A draft you already typed becomes the task; pressing another delegate swaps the prefix. |
| **`/delegate`** | `/delegate codex <task>` sends the task at once. `/delegate agy` (no task) fills the box. `/delegate list` names what is installed. |
| **Done toast** | When the model runs a delegate's `relay.mjs`, the mod gives the run an `--out-dir` (unless it has one), shows `⇢ codex running` in the status line, and toasts when `result.json` lands: `codex finished: completed, 3 files touched — review the diff`. A run that ends without a `result.json` says so. |

## Install

First install the delegate skills you want (see the [delegate-skills README](https://github.com/amElnagdy/delegate-skills#install)):

```
npx skills add amElnagdy/delegate-skills
```

Then the mod:

```
/plugin install delegate-launcher --marketplace Nasrallah-Adel/claude-delegate-launcher
```

Or clone it into `~/.claude/skills/delegate-launcher` and run `/reload-plugins`.

## Limits

- An `--out-dir` written as `$VAR`, `~/…` or a relative path is not tracked (the mod cannot resolve it).
- A background run that never writes `result.json` drops off the status line after 3 hours.
- With two sessions open, both may toast for the same run.
- Fleet lanes from `delegate-setup` (`--lane feature`) are not shown as buttons yet.

## Develop

```
claude plugin validate .
claude plugin test .
```

## Credits

[delegate-skills](https://github.com/amElnagdy/delegate-skills) (MIT) by @amElnagdy provides the
`*-delegate` skills, their relays and the `delegate-relay.result.v1` contract this mod reads.

## License

MIT
