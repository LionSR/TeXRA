# Code plugins v1: Claude Code hooks, out of process

Status: proposed (implemented in the same PR)

Decision: an installed Claude Code or Codex plugin that ships hooks
(`hooks/hooks.json`, or the manifest's `hooks` field) can be enabled. Its
command hooks run as child processes speaking the Claude Code hooks protocol
unchanged: JSON on stdin, JSON or plain text on stdout, and the exit code.
There is no TeXRA hook format. A plugin with LSP servers (`.lsp.json`, the
manifest's `lspServers`) stays refused.

This revises one point of the core-concepts note
(`2026-09-26-core-concepts.md`, Trust): that note has code plugins speak a
typed Effect RPC schema. The owner ruled that we consume the Claude Code
layout as it is, so for v1 the boundary is the hooks protocol, typed at our
edge by Zod. The other Trust and Plugin rulings hold: third-party code never
loads in process, trust is keyed on a content digest, approvals are decided
in core and recorded, and changes land at step boundaries.

## What is deleted

- The "code plugins are not supported yet" refusal for hooks, in
  `pluginTrust.ts`, `texra plugin`, and the Skills settings tab. The refusal
  now names only LSP servers.
- `hooks` leaves `CODE_COMPONENTS` in `pluginManifest.ts`; the list keeps
  LSP servers.

## Events

The protocol module (`src/common/plugins/hookProtocol.ts`) holds each
event's stdin input and stdout output schema, and parses hook output once.
The `hooks.json` configuration, its matchers and the tool-name mapping are
in `src/common/plugins/hookConfig.ts`.

| Event              | Where it fires in TeXRA                                         | What it may do in v1                  |
| ------------------ | --------------------------------------------------------------- | ------------------------------------- |
| `SessionStart`     | a root run's opening, `source: "startup"`                       | add context to the first user message |
| `UserPromptSubmit` | a root run's opening and each user follow-up that starts a turn | add context beside the prompt         |
| `PreToolUse`       | before a call's approval and body                               | deny with a reason, or add context    |
| `PostToolUse`      | after a call that executed without error                        | add feedback beside the tool result   |
| `Stop`             | a root run's completed turn                                     | notification only                     |
| `SubagentStop`     | a child run's completed turn                                    | notification only                     |

`PreToolUse` never approves. `allow` is read as "no objection", and so are
`ask` and `defer`: the run's approval policy decides as it would without the
hook. `deny`, the deprecated `decision: "block"`, and exit code 2 deny the
call. The model reads the reason as the call's error result. When several
hooks answer, one deny is enough.

Context (`additionalContext`, and plain stdout on `SessionStart` and
`UserPromptSubmit`) reaches the model as a text part labelled with the event
and the plugin. For tool events it is placed after the tool result, and for
prompt events after the prompt. A `PostToolUse` `decision: "block"` adds its
`reason` beside the result. Exit 2 on `PostToolUse` shows stderr to the
model, as the reference says.

Fields that v1 parses but does not act on are recorded as ignored and logged
as a warning: `updatedInput`, `updatedToolOutput`, `continue: false`,
blocking a prompt, blocking a stop, and `initialUserMessage`. `systemMessage`
is logged for the user. Every other event name in the reference is parsed and
ignored. Handler types other than `command` (`http`, `mcp_tool`, `prompt`,
`agent`) are also ignored, and so are `async` hooks and `shell: "powershell"`.
`texra plugin show <name>` lists all of these as unsupported.

Matchers follow the reference: `*`, an empty string, or no matcher matches
everything. A string of letters, digits, `_`, `-`, spaces, `,` and `|` is an
exact list. Anything else is an unanchored JavaScript regular expression.
TeXRA's own tool names are offered as the Claude Code names where one
exists: `bash` becomes `Bash`, `read_file` becomes `Read`, `write_file`
becomes `Write`, `edit_file` becomes `Edit`, and likewise `Glob`, `Grep`,
`WebFetch` and `WebSearch`. The matcher is tested against both names, so
`Bash` and `bash` both match. `tool_name` carries the Claude Code name. The
`if` field is not evaluated. The hook then runs for every call its matcher
matches, which the reference allows when it cannot tell what a command runs.

Malformed output is never a silent default. Stdout that starts with `{` and
ends with `}` is parsed as JSON, and invalid JSON or a schema mismatch is a
warning with no effect. On `SessionStart` and `UserPromptSubmit`, other
stdout is plain-text context. Exit 0 is success. Exit 2 blocks where the
event can block in v1 (only `PreToolUse`) and is otherwise recorded as
"blocking not supported in v1". Other non-zero codes warn with the first
line of stderr, unless the JSON is valid, in which case the JSON decides.

## Process lifecycle

A hook runs through Effect's `ChildProcess` in its own scope, inside the
run loop's fiber for the step, so interrupting the step closes it. Shell
form (no `args`) runs `sh -c <command>`, and the shell expands the
placeholders (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`,
`${CLAUDE_PLUGIN_DATA}`) from the environment, where they are exported.
Exec form runs `command` with `args` and no shell, with the placeholders
substituted as plain strings. The child is spawned detached, in its own
process group.

- The timeout is the handler's `timeout`, or the reference default (600 s,
  and 30 s on `UserPromptSubmit`).
- On a timeout, an interrupt, or scope close, the whole process group gets
  SIGTERM, then SIGKILL two seconds later. A grandchild the script started
  dies with it.
- The spawner also signals the group after a normal exit, so a background
  child left behind by a finished hook does not outlive it.
- Matching hooks for one event run concurrently, as in the reference.
- Output is capped at 10,000 characters per stream (the reference's cap for
  context).

## Environment and capabilities

- `cwd` is the workspace root. A run with no workspace runs no hooks and
  warns.
- The environment is built from scratch, never extended from the process:
  - `PATH` and `HOME` from the process;
  - `CLAUDE_PROJECT_DIR`, the workspace root;
  - `CLAUDE_PLUGIN_ROOT`, the plugin directory;
  - `CLAUDE_PLUGIN_DATA`, `<global storage>/plugin-data/<plugin>`, created
    on first use.
- No API key, no `NODE_OPTIONS`, and no other process variable reaches a
  hook.
- A Claude Code plugin declares no environment for hooks. The
  `CLAUDE_PLUGIN_OPTION_*` values come from `userConfig`, which TeXRA does
  not read, so v1 sets none.
- The capability a hook has is what its process can do as the user in the
  workspace. The trust prompt says so.

## Trust coverage

Enabling a hooks plugin goes through the trust flow that exists today. The
digest already hashes every file in the plugin. Two additions:

- **Referenced files are resolved.** For each command hook, every path the
  command names is resolved after the placeholders are expanded. That covers
  the exec-form `command` and `args`, and the shell-split tokens of the
  shell form. Resolution follows symlinks.
  - A path inside the plugin is covered by the digest.
  - A path that leaves the plugin, directly or through a symlink, is listed
    in the trust prompt with its resolved path. Its content hash joins the
    digest, so editing it asks for trust again.
  - A bare command name (`node`, `python3`) is resolved on `PATH`. It is
    listed and pinned by path, size and date, as MCP server commands are.
  - A path under `${CLAUDE_PROJECT_DIR}`, or a relative path, is a
    workspace file. The prompt names it as not covered by trust.
- **The prompt lists the hooks.** It shows each supported hook as its
  event, matcher and command, then the unsupported entries.

## Registry and step

A hook is a contribution of its installed plugin, read with the plugin at
each step (`LiveTools.pinSwitched` already reads and pins the installed
plugins). The step's `StepTools` carries the hooks of the plugins that step
accepted. A tool call runs the hooks of the step that offered it. A turn's
prompt and stop hooks run under the run's current step. So enabling or
disabling a hooks plugin takes effect at the next step, as a tool switch
does.

## Recorded rows

Each hook invocation writes one `hook.outcome` row on the run's ledger,
through the run's one writer (`RunLedger.appendBatch`). The row carries:

- `point`: the event plus its site: `SessionStart`, `UserPromptSubmit:open`,
  `UserPromptSubmit:<follow-up id>`, `PreToolUse:<call id>`,
  `PostToolUse:<call id>`, `Stop:<turn>`;
- `event`, `plugin` and `hook`: the handler's position in the plugin's
  configuration;
- `durationMs`;
- `status`: `ok`, `blocked` (exit 2), `failed` (other non-zero), `timeout`,
  `malformed`, or `unstartable`;
- `exitCode`;
- the effect: `deny` reason, `context` text, and what was `ignored`;
- the first 2,000 characters of stderr, on failure only.

The run fold keeps the outcomes by point. Before running the hooks of a
point, the loop reads that map. A point already recorded is not run again:
its recorded effect is used. The rows of one point commit in one batch, so a
point is recorded in full or not at all.

- `SessionStart` and the opening's `UserPromptSubmit` commit in the opening
  batch.
- A follow-up's `UserPromptSubmit` commits in the batch that consumes the
  follow-up.
- `PreToolUse` commits before the call runs.
- `PostToolUse` commits with the call's `tool.result`.
- `Stop` and `SubagentStop` commit before the turn's `waiting` position.

`SESSION_EVENT_FORMAT` moves from 42 to 43 for the new arm. 1.0 is a clean
state, so there is no migration.

## Refused or deferred in v1

- LSP servers.
- Every event other than the six above.
- The `http`, `mcp_tool`, `prompt` and `agent` handler types.
- `async` and `asyncRewake` hooks.
- PowerShell hooks.
- Input rewriting (`updatedInput`), output rewriting
  (`updatedToolOutput`), prompt blocking, and stop blocking.
- `SessionStart` with `source: "resume"`. The opening context is already
  in the recorded history.
- `transcript_path`: TeXRA keeps no transcript file, so the field is not
  sent.
- `CLAUDE_PLUGIN_OPTION_*`.
- Workflow agents (round mode), which offer no tools and take no prompt
  turns.
