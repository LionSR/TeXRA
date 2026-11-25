---
name: coding-agents
description: Hand a self-contained coding task to OpenAI Codex (`codex exec`) or Claude Code (`claude -p`) through `bash`, in a chosen directory, with a chosen model and effort, and continue the same thread later. Use when the user asks for Codex or Claude Code by name, or wants an independent second implementation or review from another coding agent. Needs the CLI installed and signed in.
---

# Codex and Claude Code from the shell

Both are command-line agents the user installs and signs in to themselves. You run one turn as one `bash` command, read what it printed, and check its work as you would a child agent's.

## Before the first call

```bash
command -v codex claude
```

- Sign-in is the CLI's own: `codex login` or `claude login`, which the user runs in a terminal (both are interactive). A command run through `bash` does not see TeXRA's stored API keys, and the provider key variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are removed from its environment, so neither CLI can use them here.
- A turn usually outlasts a foreground call. Run it with `run_in_background: true` and a `timeout` that fits the job (up to 6 hours); the result arrives as a message when it ends, and `executions` reads its output so far. A one-shot run cannot take that message: run in the foreground there (at most 10 minutes).
- Neither CLI can ask the user anything from here: there is no terminal. Choose the permissions up front, and choose the narrowest that does the job. Full access is for when the user's approval policy already lets you run any command.
- Put a long prompt in a file and feed it on standard input; do not paste it into the command line.

## Codex

```bash
codex exec --json --skip-git-repo-check \
  --cd path/to/dir --sandbox workspace-write \
  --config 'approval_policy="never"' \
  --model <model> --config 'model_reasoning_effort="high"' \
  < prompt.md
```

- The prompt is read from standard input.
- `--sandbox` is `read-only`, `workspace-write` (edits inside `--cd` and `--add-dir <dir>`) or `danger-full-access`. `approval_policy="never"` makes Codex fail a step it may not take instead of waiting for an answer nobody can give.
- `--model` and `model_reasoning_effort` are optional; without them Codex uses the user's own `~/.codex/config.toml`. Name a model only when the user names one.
- `--skip-git-repo-check` lets it run outside a git repository.
- `--json` prints one JSON event per line. The first, `{"type":"thread.started","thread_id":"…"}`, names the thread; `item.completed` events with `item.type` `agent_message` carry what Codex said, and `turn.completed` carries its token usage. Keep the `thread_id`.
- Continue a thread by ending the same command with `resume <thread_id>`: the new prompt on standard input is its next turn.

## Claude Code

```bash
claude -p --output-format json \
  --permission-mode acceptEdits \
  --model sonnet --effort high \
  < prompt.md
```

- Run it from the directory it should work in (set the `bash` call's working directory, or `cd` first); `--add-dir <dir>` grants further directories.
- `-p` (`--print`) answers once and exits. `--output-format` is `text`, `json` (one result object at the end, which carries the answer in `result` and the `session_id`) or `stream-json` (one event per line as it works; needs `--verbose`).
- `--permission-mode` is one of `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` and `plan`; `--dangerously-skip-permissions` bypasses every check. `acceptEdits` lets it edit files without asking, and `plan` has it read and answer with a plan. With `-p` nobody can answer a permission prompt, so an action the mode does not allow does not happen.
- `--model` takes an alias (`sonnet`, `opus`) or a full model name and `--effort` one of `low`, `medium`, `high`, `xhigh`, `max`; both are optional.
- Continue a session with `--resume <session_id>` (or `--continue` for the most recent one in that directory); add `--fork-session` to branch from it and leave the original as it was.

## After the turn

Read the changes yourself (`git diff`, the files, the tests) before you rely on them or report them: the other agent's summary is a claim, not a result. Tell the user which agent ran, where, and with what permissions.
