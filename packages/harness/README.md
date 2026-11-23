<div align="center">

# Worldline

**Kill an agent with `SIGKILL` mid-workflow. Resume without re-running a single finished tool call.**<br />
A durable, forkable agent runtime in Effect 4, backed by SQLite. Powers [TeXRA](https://texra.ai).

[![npm](https://img.shields.io/badge/npm-%40texra--ai%2Fworldline_0.1.0-6F387A?style=flat&logo=npm&logoColor=white)](https://www.npmjs.com/package/@texra-ai/worldline)
[![Effect](https://img.shields.io/badge/Effect-%5E4.1.3-270939?style=flat)](https://effect.website)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B_%7C_24.15%2B-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/Store-SQLite-003B57?style=flat&logo=sqlite&logoColor=white)](#durable-invariants)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-191919?style=flat)](#runtime-reference)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-6F387A?style=flat)](./LICENSE.txt)

[Why Worldline](#why-worldline) · [Quick Start](#quick-start) · [Recipes](#recipes) · [14 Examples](#examples) · [Entry Points](#entry-points) · [Invariants](#durable-invariants) · [Protocol Spec](./docs/spec.md) · [API Reference](./docs/api/index.md)

</div>

---

> **0.x notice:** Versioned independently from TeXRA. Type-checked and tested
> against packed tarballs, but APIs and row versions may change before 1.0 (see
> [Current limits](#current-limits)).

## Why Worldline

Worldline is the embeddable agent runtime driving TeXRA across VS Code, Electron
Desktop, and the terminal.

| Challenge                                     | How Worldline handles it                                                                                                                                                                                     |
| :-------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Crashes waste spend & repeat side effects** | Every turn, tool result, approval, and child run commits to SQLite. A crash-conformance suite slices real stores back to every commit point and verifies 9 invariants ([I1–I9](#durable-invariants)).        |
| **Graph DSLs break on real tasks**            | With `codemode`, agents write plain JavaScript (`Promise.all`, loops, `try`/`catch`) in a QuickJS worker calling `agent()`, `self()`, `program()`, and tools. Calls journal to SQLite and replay on crash.   |
| **Linear chat history blocks exploration**    | Every settled turn records a `forkPoint`. Fork any run into a new branch (`run.fork`), steer live runs (`followUp.send`), or let agents edit their own context (`context`) without losing the transcript.    |
| **Agent loops are hard to test cleanly**      | Native Effect 4: scoped lifetimes, typed tagged errors (`LaunchRefused`, `ToolsRefused`, `ResumeRefused`), zero internal `Effect.runPromise`, and one-line `ModelFetch` swapping for zero-key offline tests. |
| **UI hosts end up rebuilding session state**  | Immutable copy-on-touch `SessionView`, `RunView`, and `TranscriptView` snapshots plus browser-safe `./schemas` and `./transcript` entries, already driving VS Code, Electron, and Ink TUI.                   |

## Quick start

Node.js 22.22.2+ (22.x) or 24.15+. ESM only.

```bash
npm install @texra-ai/worldline @texra-ai/llm effect @effect/platform-node @effect/sql-sqlite-node
```

Run an agent in 25 lines (no agent YAML files; a run is plain data):

```ts
import { Effect, Stream } from 'effect';
import { responseText, Sessions } from '@texra-ai/worldline';
import { nodePlatform } from '@texra-ai/worldline/node';
import { harnessBuiltins } from '@texra-ai/worldline/builtins';

const platform = nodePlatform({ storageDir: './.agent-storage' });

const program = Effect.gen(function* () {
  const session = yield* (yield* Sessions).open(platform.roots);
  const run = yield* session.start({
    label: 'polish',
    system: 'You edit prose for concision. Keep every claim.',
    tools: ['read_file', 'edit_file'],
    instruction: 'Tighten the summary in notes.md.',
    model: 'anthropic/claude-sonnet-5-5',
  });
  yield* Stream.runForEach(run.events.pipe(responseText), (text) =>
    Effect.sync(() => process.stdout.write(text)),
  );
  return yield* run.result;
}).pipe(
  Effect.scoped,
  Effect.provide(
    Sessions.layer({
      platform,
      plugins: harnessBuiltins,
      client: { name: 'Example App', id: 'example-app' },
    }),
  ),
);

const result = await Effect.runPromise(program);
console.log(result.outcome);
```

<details>
<summary>Peer dependency ranges and provider credentials</summary>

`effect`, `@effect/platform-node`, `@effect/sql-sqlite-node`, and
[`@texra-ai/llm`](../llm/README.md) are peer dependencies so the host resolves
one copy of Effect (duplicate copies break `Context.Service`,
`Context.Reference`, and `Stream` identity) and one `ModelError` class. Keep
matching caret ranges:

```jsonc
{
  "dependencies": {
    "@effect/platform-node": "^4.1.3",
    "@effect/sql-sqlite-node": "^4.1.3",
    "@texra-ai/worldline": "^0.1.0",
    "@texra-ai/llm": "^0.1.0",
    "effect": "^4.1.3",
  },
}
```

Provider keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
…). Claude Max/Team ([monthly API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers))
and ChatGPT Pro/Business ([monthly API credits](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions))
plans work with standard API keys once linked to an API org.

</details>

## Recipes

### 1. Typed tools and plugins

Define Effect Schema tools with concurrency (`lane`) and crash-replay (`replay`)
metadata, and package them with optional JS `scriptModules` and named `programs`:

```ts
import { Effect, Schema } from 'effect';
import {
  definePlugin,
  defineTool,
  executed,
  nullishWithDefault,
} from '@texra-ai/worldline/plugins';

const countEquations = defineTool({
  name: 'count_equations',
  description: 'Count display equations in a LaTeX snippet.',
  lane: 'parallel',
  replay: 'safe',
  schema: Schema.Struct({
    tex: Schema.String.annotate({ description: 'LaTeX source snippet.' }),
    includeUnnumbered: nullishWithDefault(Schema.Boolean, true),
  }),
  execute: ({ tex, includeUnnumbered }) =>
    Effect.sync(() => {
      const n = [...tex.matchAll(/\\begin\{(equation|align|gather)\}/g)].length;
      const u = includeUnnumbered
        ? [...tex.matchAll(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\])/g)].length
        : 0;
      return executed(
        JSON.stringify({ numbered: n, unnumbered: u }),
        `${n + u} eqs`,
      );
    }),
});

export const latexPlugin = definePlugin({
  id: 'latex',
  tools: [countEquations],
});
```

Register in `Sessions.layer({ plugins: [...harnessBuiltins, latexPlugin], … })`
or pass per-run via `runTools` on `session.start` and `session.resume`.

### 2. SQLite persistence, branching (`run.fork`), and resume

```ts
const session =
  yield * (yield * Sessions).open(platform.roots, { persistent: true });

// Branch any settled run without touching the original
const { runId: branchId } =
  yield * session.request({ kind: 'run.fork', runId });

// Send a follow-up to the branch (resumes automatically if stopped)
yield *
  session.request({
    kind: 'followUp.send',
    runId: branchId,
    text: 'Replace the sketch with a formal proof.',
  });

// Resume any interrupted run in a later process
const resumed = yield * session.resume(runId, { runTools });
const end = yield * resumed.result;
```

### 3. Multi-agent workflows in plain JavaScript (`codemode`)

With `codemode` and `multiAgent` (both in `harnessBuiltins`), agents run
sandboxed QuickJS scripts with `Promise.all`, structured JSON schemas, plugin
modules, and read-only SQL over `executions`:

```js
const { outline } = await import('builtIn:latex');
const { titles } = await outline(draftTex);
const schema = {
  type: 'object',
  properties: { verdict: { type: 'string' } },
  required: ['verdict'],
};
const [setup, bound] = await Promise.all([
  self('Check the setup.', { schema }),
  self('Check the main bound.', { schema }),
]);
return {
  titles,
  verdicts: [setup.structured.verdict, bound.structured.verdict],
};
```

Every guest call journals in commit order (`script.call`). Kill the process with
`SIGKILL` mid-script and resume replays finished calls without re-running them
([`example/08-crash-and-resume.ts`](./example/08-crash-and-resume.ts)).

### 4. Approvals and offline testing

Approval defaults to `yolo`; narrow per workspace (`Settings.set`), per run
(`approval: 'ask' | 'never'`), or by omitting plugins. Pending approval rows
survive restarts:

```ts
yield* session.attach({
  approve: (req) =>
    Effect.succeed(
      req.payload.kind === 'bash'
        ? { action: 'approve' }
        : { action: 'deny', reason: 'Only shell commands approved.' },
    ),
});
const run = yield* session.start({ ..., approval: 'ask' });
```

For zero-key, deterministic tests, merge a scripted `ModelFetch` beneath
`Sessions.layer`:

```ts
Sessions.layer({ platform, plugins: harnessBuiltins, client }).pipe(
  Layer.provideMerge(Layer.succeed(ModelFetch)(scriptedFetch)),
);
```

## Examples

[`example/`](./example/README.md) packs `@texra-ai/worldline` and
`@texra-ai/llm` into `.tgz` tarballs, installs them into a clean directory,
type-checks with `strict: true` and `skipLibCheck: false`, and runs 14 offline
scenarios (set `TEXRA_EXAMPLE_MODEL=provider/model` for a live model):

```bash
corepack pnpm --filter @texra-ai/worldline run example:packed
```

| #   | Example                                                                        | Demonstrates                                                                              |
| :-- | :----------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| 01  | [`01-llm-turn.ts`](./example/01-llm-turn.ts)                                   | Standalone `@texra-ai/llm`: route, `bindModel`, `prepareTurn`, `streamTurn`, `ModelError` |
| 02  | [`02-session-and-events.ts`](./example/02-session-and-events.ts)               | `Sessions.layer`, `LaunchRefused`, `run.events.pipe(responseText)`, `run.result`          |
| 03  | [`03-custom-tools-and-plugins.ts`](./example/03-custom-tools-and-plugins.ts)   | `defineTool`, `nullishWithDefault`, `definePlugin`, script tool calls                     |
| 04  | [`04-approvals-and-requests.ts`](./example/04-approvals-and-requests.ts)       | `requiresApproval`, `session.attach`, `interactive` waits, `followUp.send`, `run.stop`    |
| 05  | [`05-durable-resume-and-fork.ts`](./example/05-durable-resume-and-fork.ts)     | Persistent SQLite store, `run.fork`, resuming a branch, re-reading prior activations      |
| 06  | [`06-views-and-transcript.ts`](./example/06-views-and-transcript.ts)           | `session.view`, `sessionActivity`, `attentionOf`, `TranscriptRow` formatting              |
| 07  | [`07-programmed-path.ts`](./example/07-programmed-path.ts)                     | Plugin `scriptModules`, `self()` with JSON Schema, read-only SQL over `executions`        |
| 08  | [`08-crash-and-resume.ts`](./example/08-crash-and-resume.ts)                   | Real `SIGKILL` of a child Node process mid-script, cross-process resume, pinned modules   |
| 09  | [`09-goal-strategies.ts`](./example/09-goal-strategies.ts)                     | Multi-round goals (`builtIn:goal`), custom `goal.strategy`, fresh `judge`, `spend_cap`    |
| 10  | [`10-external-plugin.ts`](./example/10-external-plugin.ts)                     | External npm plugin (`acme-notes/`), versioned facts, `pluginUnavailable`, `program()`    |
| 11  | [`11-resume-ownership.ts`](./example/11-resume-ownership.ts)                   | Concurrent resume dedup, reader cancellation vs `session.held`, close vs `run.stop`       |
| 12  | [`12-controls-on-a-resumed-run.ts`](./example/12-controls-on-a-resumed-run.ts) | Queuing `run.model` and `run.compact` across a resume boundary                            |
| 13  | [`13-failed-turn.ts`](./example/13-failed-turn.ts)                             | Provider 400 refusal, `error.kind: 'model'`, preserving queued follow-ups                 |
| 14  | [`14-context-edit.ts`](./example/14-context-edit.ts)                           | Agent self-editing context via `tools.context`, persisting across restart                 |

## Entry points

| Entry                            | Contents                                                                                                                                                                      |
| :------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@texra-ai/worldline`            | Core embedding surface (~50 exports): `Sessions`, `Session`, `Run`, `AgentEvent`, `HostInteractions`, `ModelFetch`, tagged errors. Start here.                                |
| `@texra-ai/worldline/schemas`    | Browser-safe: Effect schemas, read-only `SessionView` / `RunView` / `TranscriptView`, approval policy, error formatters.                                                      |
| `@texra-ai/worldline/transcript` | Browser-safe: `RemoteSessionView` over transport `SessionInputs`, transcript rows and projections.                                                                            |
| `@texra-ai/worldline/builtins`   | Built-in plugins: `harnessBuiltins`, or individually (`codemode`, `fileOps`, `goal`, `memoryWorkflow`, `multiAgent`, `web`).                                                  |
| `@texra-ai/worldline/plugins`    | Authoring: `defineTool`, `definePlugin`, `ToolContext`, `Settings`, `WorkspaceFs`, `Secrets`, `executed`/`errorResult`, `nullishWithDefault`, `ConfigProvider`, `StateStore`. |
| `@texra-ai/worldline/node`       | `nodePlatform(options)`, `setLogSink`, `LogSink`, `effectDiagnosticsLayer`.                                                                                                   |
| `@texra-ai/worldline/host`       | Full host composition (`processLayer`, skills, installed plugins, model options). Used by TeXRA's hosts; no stability promise.                                                |

Full generated declarations and TSDoc: [`docs/api/`](./docs/api/index.md).

## Runtime reference

<details>
<summary><strong>Services, run lifecycle, platform, memory, MCP, and logging</strong></summary>

- **Services:** `Sessions` (`open`, `close`, `list`; build `Sessions.layer`
  once per process, and a second live build opening the same root fails); `Session`
  (`start`, `resume`, `request`, `attach`, `view.current`, `view.changes`);
  `Run` (`runId`, `events`, `result`, `view`). `sessions.close(roots)` returns
  `{ abandoned }`, and releasing `Sessions.layer` closes every open session.
- **Run config (`StartRequestSchema`):** `system` is author-owned Nunjucks
  rendered once at launch with `CWD` (never put end-user text inside `system`;
  workspace paths, git branch, `AGENTS.md`, and `MEMORY.md` are never
  template-rendered). `tools` declares allowed names (`mcp__<server>__*`
  expands an MCP server). `Plugin.programs` registers script modules started by
  name (`@texra-ai/worldline` ships no built-in programs). `agentName`
  (`<plugin>:<name>`) snapshots a Claude Code / Codex plugin agent at call time.
- **Streams, views, and errors:** Multiple `run.events` readers replay from
  activation start; ending a reader does not stop the run. `run.view` yields
  immutable copy-on-touch `SessionView` snapshots through the terminal outcome
  (never mutate via casts). Pre-entry refusals fail `start` with `LaunchRefused`
  (carrying a user `notice`), `ToolsRefused`, or `RunFailure`; in-run failures
  resolve `run.result` to a failed `RunEnd` (`{ outcome, usage?, output, error? }`,
  with `output = { response, files, structured? }` and `runEndErrorMessage` in
  `./schemas`). `resume` fails with `ResumeRefused` (`finished`,
  `unusableCheckpoint`, `earlierBuild`, `pluginUnavailable`, `notResumable`),
  redirects owned children (`run.redirectedFrom`), and returns the live handle
  when already active (`session.run(runId, activation)`).
- **Follow-ups and approvals:** `followUp.send` returns `sent` (delivered next
  request, or end of turn with `holdUntil: 'turn'`) or `queued` (auto-resumes),
  or fails `Unavailable`. Request payload kinds: `bash`, `toolEdit`,
  `planApproval`, proposals, `pluginTrust`, retries, `userQuestion`. Questions
  and post-retry prompts are never auto-answered.
- **Platform, MCP, memory, and logging:** `nodePlatform({ storageDir, settings? })`
  sets up a `v1` layout under `storageDir` (never falling back to a home dir),
  reads stdio MCP `2025-11-25` servers from `<storageDir>/mcp.json`, loads
  `<storageDir>/AGENTS.md` then `<workspace>/AGENTS.md`, reads workspace `.env`
  over `process.env` at launch (stripping provider keys from shell children),
  and enables two writable Markdown memory folders (`<storageDir>/memories` and
  `<workspaceStorage>/memories`, embedding each `MEMORY.md` index up to 16,000
  chars; disable via `MEMORY_ENABLED_SETTING`). Custom settings use
  `settingsCatalog` + `Settings`. Model HTTP transport honors `HTTP_PROXY` /
  `HTTPS_PROXY` / `NO_PROXY` with a 30-minute stream inactivity timeout. Logs
  flow through your Effect `Logger`, or through `effectDiagnosticsLayer` +
  `setLogSink` (redacted unless `{ trusted: true }`, formatted with
  `entryLine`/`entryDetail`).

</details>

## Durable invariants

Full protocol specification: [`docs/spec.md`](./docs/spec.md). A run's next step
comes strictly from committed SQLite rows (live stream chunks are never recovery
input). The crash-conformance suite slices real stores back to every commit
point and verifies:

| ID     | Guarantee                                                                                                                                                                                              |
| :----- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | Recovery reaches the clean run's outcome: committed answers, tool results, owned children, and context edits are preserved.                                                                            |
| **I2** | A tool call finishes once. Committed results are reused and never executed again.                                                                                                                      |
| **I3** | A model invocation has at most one committed response.                                                                                                                                                 |
| **I4** | Approval-gated commands run only after approval. Unfinished commands with unknown outcome retry only after human choice; recovery never assumes absence of a result means no external effect occurred. |
| **I5** | Cleanly ended owned children answer their awaiting call on recovery; relaunching requires a retry decision, and owned children retain terminal rows.                                                   |
| **I6** | Child result delivery commits atomically with the turn that produced it and is consumed once (including detached agents, scripts, and commands).                                                       |
| **I7** | Compaction and fork preserve committed context; forks recover with their registered history.                                                                                                           |
| **I8** | A stopped run's halt and terminal outcome commit together; recovery cannot continue an acknowledged stop.                                                                                              |
| **I9** | Disabling a shell approval bypass is acknowledged only after the policy row is durable.                                                                                                                |

## Storage failures

| ID     | Error / Outcome                                                                                                                                                                                 |
| :----- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** | `DatabaseOpenFailed`: store does not open. Earlier-build stores are refused unchanged; SQLite-damaged stores are moved aside (`storeMovedAside`) and never read again.                          |
| **S2** | `DatabaseStoreNewer`: store written by a newer build is refused whole (nothing read or written beside it).                                                                                      |
| **S3** | `DatabaseReadFailed`: failing read rejects. Runs with undecodable rows (`DatabaseRowCorrupt`, `DatabaseRowEarlier`) list as unreadable and cannot resume; listings/tails skip with one warning. |
| **S4** | `DatabaseWriteFailed`: batch rolls back; inside a run, the run ends regardless of tool/model handling.                                                                                          |
| **S5** | `DatabaseAggregateClosed`: nothing written; the run stops without retry. A store held by another process fails open with `STORE_HELD_MESSAGE`.                                                  |
| **S6** | `RunChanged`: deletion against a superseded lifetime writes nothing. Store-rule violations (e.g. duplicate `run.start`) fail the writer fiber as a defect.                                      |

## Generated files and deletion

Under its storage root, a session owns `<namespace>.project-v1.db` (default
`harness.project-v1.db`; older `<namespace>.db` files stay untouched) and
per-run directories `executions/<runId>/`. Project files are never touched, and
moved-aside corrupt stores (`*.corrupt-<ms>`) are removed only on explicit user
deletion (`deleteStorageInventory` / `texra doctor --prune-storage`).

- `run.delete` commits a `run.removed` marker closing the run and its owned
  descendants before touching disk; collection runs on open and after delete
  (idempotent across processes), removing closed directories, rows, and
  unreferenced blobs, retrying failed removals on the next collection.
- The harness only auto-deletes ended background shells left by earlier
  processes at session open through the same marker.
- Before deleting, the collector resolves the storage root and `executions/`
  (refusing symlinks pointing outside; resolve-then-check).
- `run.files` copies a stopped run's directory into the project or removes it
  without deleting the run.

## Current limits

- **No handler under `ask` denies requests:** Without `session.attach`, `ask`
  denies all requests and fails launches with `requiresApproval` tools
  (`ToolsRefused`). Questions and post-retry prompts deny under any policy when
  unanswered.
- **Single-cycle by default:** Runs end after one cycle unless
  `interactive: true`.
- **0.x store compatibility:** Row schemas are not frozen before 1.0; bumping a
  row version marks affected runs unreadable (S3) and schema-stamp mismatches
  refuse the store whole (S1, S2).

## License

Licensed under the [Apache License, Version 2.0](./LICENSE.txt).
