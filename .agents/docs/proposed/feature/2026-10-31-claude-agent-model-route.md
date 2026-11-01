---
created: 2026-10-31
status: proposed (blocked on Anthropic's approval; nothing is built)
---

# A Claude plan as a model route, through the Claude Agent SDK

A user who pays for Claude Pro or Max should be able to pick a Claude model
for a TeXRA run and have it billed to that plan, the way a ChatGPT or SuperGrok
plan already serves OpenAI and xAI models. This note proposes the shape: a
`claude-agent` route whose binding runs the user's own `claude` program
through the Claude Agent SDK and exposes TeXRA's tools to it, while TeXRA's
run loop stays the only loop and the run history stays the only authority.

OpenCode shipped the same feature on 2026-10-30 (v2.2.3, its PR #58782). The
design below borrows its mechanism and differs where TeXRA's model contract
already has a better slot for a piece.

## Gate: Anthropic's terms

The Agent SDK overview says, as of 2026-10-31:

> Unless previously approved, Anthropic does not allow third party developers
> to offer claude.ai login or rate limits for their products, including agents
> built on the Claude Agent SDK.

OpenCode's maintainer states in PR #58782 that OpenCode obtained that
approval. No public Anthropic statement confirms it, and approval granted to
OpenCode does not extend to TeXRA. In March 2026 OpenCode removed its earlier
Claude OAuth plugin after a legal request (its PR #18186), so the risk is real.

**Phase 0 is the owner asking Anthropic for written approval.** Nothing in
this note is built before that answer. If the answer is no, this note is
deleted and the existing paths stay: an Anthropic API key (a Max or Team plan's
monthly API credits can fund one, `packages/llm/README.md`) and the
`claude_code` delegate tool.

Branding follows the SDK guidelines: the route is shown as **Claude Agent**,
never "Claude Code".

## What TeXRA has today

- **API-key route.** `anthropic-messages` over `packages/llm/src/api/anthropicMessages.ts`.
- **Plan routes for other vendors.** `chatgpt-subscription` and
  `xai-subscription` (`packages/llm/src/oauth/`), where TeXRA holds the OAuth
  token and calls the vendor's HTTP endpoint itself.
- **A delegate tool that already uses the plan.**
  `packages/texra/src/tools/claudeAgent.ts` starts a separate Claude Code
  agent through the Agent SDK. That agent uses Claude Code's own tools, prompt,
  settings and login, including a Pro/Max login, and its result comes back to
  the parent run as a delivery. The SDK is already a dependency of
  `packages/texra`, and the binary lookup (`findClaudeBinaryPath`,
  `packages/texra/src/tools/claudeAgentImport.ts`) already handles packaged
  Electron and VSIX builds.

The gap: the plan can run a sub-agent, but it cannot be the model of a TeXRA
run. A run's persona, tools, approvals, transcript and compaction are
unavailable to it.

## How OpenCode does it

Read at OpenCode `bf544cd`, `packages/core/src/plugin/provider/claude-agent/`
(about 2,400 lines) and `specs/v2/claude-agent-provider.md`.

1. **Claude Code becomes a streaming model.** The provider implements the AI
   SDK `LanguageModelV3` interface. `doStream` feeds a long-lived `query()`
   (streaming input mode, one process per chat) and converts SDK messages to
   stream parts.
2. **The turn waits at the tool boundary.** OpenCode's tools reach Claude
   through one in-process MCP server. Its `tools/call` handler does not run the
   tool. It returns a promise that waits. When Claude's message ends
   (`message_stop`) with a call to an offered tool, `doStream` closes with the
   tool-call parts. OpenCode runs the tools with its own permissions. The next
   `doStream` finds the results in the prompt and resolves the waiting
   promises, and the same Claude turn continues. One Claude turn spans several
   OpenCode steps.
3. **The tool-use ID comes from a hook.** The MCP request does not carry
   Claude's `tool_use_id`, so a `PreToolUse` hook records it in a single slot
   that the next `tools/call` takes. One slot means one call at a time: every
   tool is marked `readOnlyHint: false`, which makes Claude Code serialize
   them. A `PostToolUse` hook returns `updatedMCPToolOutput` to add PDFs and
   images that a plain MCP result cannot carry.
4. **Claude Code is reduced to a model.** The provider sets `tools: []`,
   `allowedTools: ["mcp__opencode__*"]`, `permissionMode: "dontAsk"`,
   `settingSources: []`, `disableAllHooks`, `strictMcpConfig`, `skills: []`
   and `verbatimPrompts`. Environment variables turn off CLAUDE.md files, auto
   memory, auto compaction, tool search and the advisor tool. It also unsets
   `CLAUDE_CODE_SIMPLE`, which would skip the plan login.
5. **The system prompt is Claude Code's preset plus an append.** The append
   names OpenCode, adds the agent's role and adds OpenCode's instructions.
6. **OpenCode's history is the authority.** OpenCode hashes each message as a
   checkpoint. After an edit, undo or model switch, it forks the Claude
   session at the last matching message, or sends what Claude has not seen as
   one `<conversation-checkpoint>` user message.
7. **Credentials are never touched.** The user runs `claude auth login`.
   Billing reads the account type that `claude` reports at startup: a plan
   shows $0, and an API key or cloud account is priced.

Its stated limitations are serial tool calls, no sampling parameters,
Claude Code's base prompt in place of OpenCode's built-in prompts, local
machines only, and no Claude Code-only features (auto mode, memory, cloud
sessions).

## Options

| Option                                           | What it is                                                                             | Verdict                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Hold the plan's OAuth token                   | TeXRA runs the claude.ai OAuth flow and calls `api.anthropic.com` as Claude Code would | Rejected. It impersonates Claude Code, which is exactly what OpenCode removed after the legal request.                                                      |
| B. Delegate the whole run                        | Claude Code runs its own loop with TeXRA's tools over MCP                              | Already exists as the `claude_code` tool. As a route it would make a second loop owner and a second writer of the run history, which the run model forbids. |
| C. A model route that waits at the tool boundary | OpenCode's mechanism, behind TeXRA's `Model` contract                                  | **Proposed.**                                                                                                                                               |

## Design

### Route and binding

- `modelRoute.ts` gains a route kind `claude-agent`. `decideModelRoute`
  chooses it for an Anthropic catalog model when the user has enabled it and
  the host reports `claude` as available. Like the other plan routes, it is
  declinable, so a run can fall back to the user's own key.
- No credential enters TeXRA. `ModelCredential` gains no member. The host
  resolves the executable path (today's `findClaudeBinaryPath`) and passes it
  in `BindSpec`. `packages/llm` stays pure and does not reach into the app.
- The binding starts the process and waits for `initializationResult()` (30 s
  deadline). The account, model list and Claude Code version it reports decide
  the outcome: a missing binary, a missing login or a version that is too old
  is a `ModelError` with the exact command to run. Each case is surfaced
  once, never as an empty model list.

### Protocol

`TurnProtocolSchema` and the `ModelConfiguration` union gain a
`claude-agent` member. Its controls are `maxOutputTokens` (passed through
`CLAUDE_CODE_MAX_OUTPUT_TOKENS`), `effort` (the SDK option, changed on a live
process with `applyFlagSettings`) and summarized thinking. It carries no
temperature or tool choice, the same as `anthropic-messages` under API version
2026-10-21, so a persona loses nothing it has today. `backgroundCapable`
returns `false`.

### The model: one process per binding

A new `claudeAgentModel` in `packages/llm/src/api/` is a **scoped** `Model`,
the same kind as `openaiResponsesWebSocketModel`. `bindModel` acquires it in
the caller's scope, and the run already gives every binding a scope of its own
(`AgentRun.swapModel`). So the process lives exactly as long as the binding:

- A model switch, a manual retry's rebind or a credential renewal closes the
  old scope, which interrupts the turn, drains it and closes the process.
- A run's end closes it the same way.
- A resume is a new activation and so a new process.

No registry, idle timer or handover is needed. OpenCode keeps those because
its AI SDK models are stateless values. TeXRA's binding scope already serves
that purpose.

### A turn

The model keeps, in memory only, the prefix fingerprint
(`api/prefixFingerprint.ts`) and message count of the history its process has
seen, and the tool calls it is waiting on. `streamTurn` compares the request's
messages to that prefix:

1. **Continuing a waiting turn.** The messages are the seen prefix plus the
   calling assistant message plus its complete tool-result group (plus, if the
   user typed while tools ran, one user message). The model resolves each
   waiting call's `Deferred` with its result and reads on. A user message goes
   in as `priority: "next"` input, as in OpenCode.
2. **Extending the conversation.** The seen prefix is a strict prefix. The
   model sends the remainder as one user message.
3. **Anything else.** This covers a first turn, compaction or a history that
   differs. The model starts a fresh Claude session and sends everything as a
   checkpoint user message. Thinking is not replayed.

The stream emits text and reasoning deltas as they arrive. It ends with
`completed` either on the SDK's `result` message or on `message_stop` after a
call to a TeXRA tool. In the second case the result's assistant content holds
the calls as `local-call` parts, and `checkPreparedHistory` already requires
the next request to answer them. Calls to tools TeXRA did not offer get
Claude Code's own "No such tool" error and are not reported, as in OpenCode.

### Tools

- One in-process MCP server named `texra` (`type: "sdk"`). Each TeXRA tool
  definition becomes an MCP tool with `readOnlyHint: false`,
  `anthropic/alwaysLoad` and a high `maxResultSizeChars`, so TeXRA's own
  truncation applies.
- The ID slot from the `PreToolUse` hook forces serial execution. TeXRA
  can still run a message's several calls in parallel on its side, because
  all of them reach the stream before any result is due.
- Rendered PDF pages and images in a tool result go back through
  `PostToolUse` `updatedMCPToolOutput`. That matters more for TeXRA than for
  a coding agent, because reading papers is the main workload.
- Isolation options as in OpenCode §4, with `allowedTools: ["mcp__texra__*"]`.

### System prompt

The first choice is OpenCode's: the `claude_code` preset, with the persona's
`prompt` and TeXRA's instructions appended. This is the largest product
question. TeXRA's bundled personas are writing and research agents, and
Claude Code's base prompt is a coding agent's. The spike tests whether a plain
string `systemPrompt` (which replaces the preset) works under a plan login and
is acceptable under the approval. If not, academic personas run under a
coding prompt, and the route must say so in its description.

### Persistence

**Nothing is persisted in v1.** The Claude session is acceleration over an
exact prefix, never the authority. That is the doctrine
`ContinuationSchema` already states, and the same reason a
connection-scoped Responses anchor is never stored. A new activation pays for
one checkpoint message and a cold prompt cache. Benefits:

- No storage-format change and no new continuation member.
- No session forking (OpenCode's largest module, `claude/sessions.ts`, 467
  lines).
- `persistSession: false`, so TeXRA leaves no transcripts under `~/.claude`.

Resuming through `resume:` with a stored Claude session ID is a later,
measured change.

### Retries, failures and cancellation

- **Retries.** Claude Code retries failed requests itself, and TeXRA's one
  retry loop (`runtime/run/invocation.ts`) must not retry on top of it. The
  spike finds out whether Claude Code's retry count can be set to zero. If it
  can, TeXRA's loop owns retries as everywhere else. If not, the route
  reports failures as final and the note records the exception.
- **Failures.** A failed turn leaves the process in an unknown state, so the
  binding reports `persistentConnection: true`. The existing `rebound` path
  then rebinds before the next attempt, as it does for a dead WebSocket.
  Failures are classified into `ModelError` kinds from the SDK's result
  subtypes and the account's limit messages. A plan-limit message is shown
  once.
- **Cancellation.** Cancellation is fiber interruption. The finalizer calls
  `query.interrupt()` and drains to the `result` message before the next turn
  can start. The SDK's `abortController` option is not passed, so no new
  `AbortController` resident is added.

### Usage and cost

Claude Code reports one response's usage several times while it streams, so
the model keeps the highest count per message ID. A plan login bills $0 under
the new billing route. An API-key or cloud login reported by `claude` is
priced from the catalog, as OpenCode does. Token counts are recorded either
way, so compaction thresholds keep working.

### The Effect boundary

- The SDK's input is a `Queue` exposed as `Stream.toAsyncIterable`, and its
  output is `Stream.fromAsyncIterable`, as `claudeAgent.ts` already does.
- The MCP `tools/call` handler is the one place a foreign callback must
  return a promise that waits on Effect state (the call's `Deferred`). That is
  an SDK boundary in the sense of the root guide. It needs either a runtime
  captured from the binding scope (`FiberSet.makeRuntimePromise`) or a named
  entry in `EFFECT_RUN_ENTRIES`. A reviewer decides which. Hand-rolled
  promise plumbing is out (`CORE_QUALITY_DIRS` covers `packages/llm/src`).
- `@anthropic-ai/claude-agent-sdk` becomes a dependency of `packages/llm`,
  loaded on demand like the other protocol SDKs, at the workspace catalog's
  version. The app's bundling rules for it (`claudeAgentImport.ts`) apply
  unchanged.

## Costs

Copilot was removed (#14296) because its route added a transport only one host
could serve. This route avoids that particular cost: all three hosts run on a
local machine that can spawn `claude`, and nothing crosses the window/service
RPC boundary. It still adds:

- **A fourth protocol in `packages/llm`.** It is a process rather than an HTTP
  wire, with its own failure evidence. Every change to turns or origins must
  handle it.
- **A live process per bound run.** Child runs bind too, so the
  child-run concurrency budget also caps `claude` processes.
- **Serial tool execution** on Claude's side.
- **Claude Code's base prompt** under every persona, unless the spike shows
  otherwise.
- **An estimated 800–1,000 lines** for the model, tool server and route. That
  is OpenCode's 2,400 lines minus session sync, forking, the idle registry and
  the stubs for hosted builds.
- **A dependency on Claude Code's release cadence.** The provider breaks when
  Claude Code changes an option or an environment variable. OpenCode already
  pins a minimum version (2.1.248, for `verbatimPrompts`).

## Not in scope

Claude Code's own tools, skills, hooks, plan mode, memory and subagents;
session forking; persisted continuations; Claude plan usage display
(`/usage`); hosts without a local `claude` (none today).

## Phases

0. **Approval.** The owner asks Anthropic. A refusal deletes this note.
1. **Spike** (throwaway branch, no PR). Measure process start latency. Test a
   custom `systemPrompt` under a plan login, retry control, PDF and image
   input in user messages and tool results, usage reporting and interruption
   draining. Record the results here.
2. **Route and model.** The protocol member, `claudeAgentModel`, the tool
   server and the route decision. Coverage is one E2E journey: a fake
   `claude` that replays a recorded session, as OpenCode's tests do, so the
   real SDK is exercised. It ends in a written file produced by a tool call
   that crossed the waiting boundary.
3. **Settings and docs.** Enable the route in the native settings view (one
   control). Its status shows the account `claude` reports, and the guide
   documents `claude auth login`.

## Open questions

1. Does a plan login accept a non-preset `systemPrompt`, and does the
   approval permit it?
2. Can Claude Code's internal retries be turned off?
3. Helper calls (`helperModel.ts`, for example titles): should they start a
   throwaway process, or decline this route and use another configured model?
4. Should the `claude_code` delegate tool and this route share the binary
   lookup in a host-side module, so the path is resolved once per process?
