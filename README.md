# Tangent

Claude Code-style `/btw`, `/subtask`, `/fork`, and `/branch` for Paseo agents.

## Install

```sh
paseo plugin add git:nilbus/paseo-tangent
paseo plugin logs tangent     # troubleshooting
```

For local development, clone the repository, run `npm install` for type checking, and use `paseo plugin add <directory>` followed by `paseo plugin reload tangent` after edits.

Requires Paseo 0.13 or later.

## Commands

| Command | What it does | Reports back to the parent? |
|---|---|---|
| `/btw <question>` | Asks a side question in the "By the way" sidebar panel. The thread starts from a copy of the conversation, is told not to use tools, and the main agent never sees it. Follow-ups continue the same thread; **New thread** archives it. Answers time out after 5 minutes. | No |
| `/subtask <task>` | Starts a background child agent with fresh context, on the parent's provider, model, mode, and thinking level. | Yes, once, when its first turn ends, as `<subtask-result>` |
| `/fork [prompt]` | Copies the conversation into a new agent and opens it as a tab in the parent's workspace. With a prompt it forks the whole conversation and sends it, reporting back as `<fork-result>`. Without one it opens a panel listing the prompts in the last 200 entries: picking one forks up to that message, keeps the history, and waits for your first message instead of starting one. | Yes, once, when it answers the prompt you gave it |
| `/branch [prompt]` | Like `/fork`, but never reports back. With no prompt, the branch waits for you. | No |

Reports are sent with `activeTurnBehavior: "steer"`, so a busy parent is steered, not interrupted. Only the reply to the plugin's own prompt is reported; turns you start in the child's tab are not.

## Forking by provider

A **native** fork copies the provider's own session, so the fork keeps tool results, file contents it read, and the prompt cache. A **transcript** fork pastes the visible user and assistant messages (last 200 timeline entries) into a fresh agent. Any native failure falls back to a transcript and logs `native <provider> fork failed`.

| Provider | Paseo id | Fork | How | Tested |
|---|---|---|---|---|
| Claude | `claude` | Native | Copies `~/.claude/projects/<project>/<session>.jsonl` under a new session id, then `paseo import`. Honors `CLAUDE_CONFIG_DIR`. | Yes |
| Codex | `codex` | Native | Starts a short-lived `codex app-server` and calls `thread/fork` (the call Paseo uses for rewind), then `paseo import`. | No |
| OpenCode | `opencode` | Native | Starts a short-lived `opencode serve` on a free port and calls `POST /session/{id}/fork?directory=<cwd>`, then `paseo import`. | No |
| Pi | `pi` | Native | Copies the session JSONL file beside the original with a new `session` header id, then imports it by path. | No |
| Oh My Pi | `omp` | Native | Same as Pi. | No |
| Copilot | `copilot` | Transcript | ACP provider; Paseo exposes no fork or rewind for it. | — |
| Antigravity | `antigravity` | Transcript | Plugin provider with no fork API reachable from another plugin. | — |
| Muse Code | `muse` | Transcript | Its protocol has a fork call, but only through Muse's own provider connection. | — |

### After a native fork

The plugin API cannot import sessions or change settings, so native forks go through the `paseo` CLI:

1. `paseo import <fork> --provider <id> --cwd <cwd>`
2. `paseo agent update <agent> --name <title>`, then `--thinking <parent's level>`
3. `paseo agent mode <agent> <parent's mode>`
4. `paseo agent open <agent>` (desktop only; elsewhere the sidebar panel opens the tab)

Steps 2–4 are best effort. **The parent's model is not carried over** for Claude, Pi, or Oh My Pi, because the CLI cannot set it; Codex receives it in the fork call.

### `/btw` threads

On Claude, a `/btw` thread is a native fork created as a hidden child agent, with editing and shell tools disabled. Other providers cannot resume a forked session in a child agent, so their threads use a transcript.

## Configuration

Set these in the daemon's environment if a binary is not on its `PATH`:

| Variable | Default search |
|---|---|
| `PASEO_CLI` | `/Applications/Paseo.app/Contents/Resources/bin/paseo`, then `paseo` |
| `TANGENT_CODEX_BIN` | `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, then `codex` |
| `TANGENT_OPENCODE_BIN` | `~/.opencode/bin/opencode`, `/opt/homebrew/bin/opencode`, then `opencode` |

## Limitations

- Pending reports live in memory; a daemon restart drops them.
- `/btw` answers appear when complete, not streamed.
- `/fork` and `/branch` open a tab only on Paseo Desktop. Other clients open the sidebar panel, which opens the tab.
- The Claude copy rewrites only `sessionId`; message ids are kept.
- Codex forks assume `thread/fork` persists the thread before the temporary app-server exits.
