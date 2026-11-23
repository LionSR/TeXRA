<div align="center">

# Worldline

Worldline is an embeddable agent runtime built on Effect 4 and SQLite. Write multi-agent workflows in JavaScript, resume a run, or fork it at an earlier turn to try a different approach.

[![npm](https://img.shields.io/npm/v/@texra-ai/worldline?label=%40texra-ai%2Fworldline&color=6F387A&logo=npm&logoColor=white)](https://www.npmjs.com/package/@texra-ai/worldline)
[![Effect](https://img.shields.io/badge/Effect-%5E4.1.3-270939?style=flat)](https://effect.website)
[![Node.js](https://img.shields.io/badge/Node.js-22.22%2B_%7C_24.15%2B-339933?style=flat&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/Store-SQLite-003B57?style=flat&logo=sqlite&logoColor=white)](#durable-invariants)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-191919?style=flat)](#runtime-reference)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-6F387A?style=flat)](./LICENSE.txt)

[Why Worldline](#why-worldline) · [Quick Start](#quick-start) · [At a Glance](#at-a-glance) · [Entry Points](#entry-points-and-examples) · [14 Examples](./example/README.md) · [Invariants](#durable-invariants) · [Spec](./docs/spec.md) · [API](./docs/api/index.md)

</div>

---

> **0.x notice:** Versioned independently from TeXRA. Tested against packed
> tarballs, but APIs and row versions may change before 1.0 ([limits](#current-limits)).

## Why Worldline

Worldline is the embeddable agent runtime powering [TeXRA](https://texra.ai) across VS Code,
Electron Desktop, and the terminal.

| Challenge                                        | How Worldline handles it                                                                                                                                                                                   |
| :----------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Crashes waste spend & duplicate side effects** | Every turn, tool result, approval, and child run commits to SQLite. A crash-conformance suite slices real stores back to every commit point and verifies 9 invariants ([I1–I9](#durable-invariants)).      |
| **Graph DSLs break on real workflows**           | With `codemode`, agents write plain JavaScript (`Promise.all`, loops, `try`/`catch`) in a QuickJS worker calling `agent()`, `self()`, `program()`, and tools. Calls journal to SQLite and replay on crash. |
| **Linear history blocks branching**              | Every settled turn records a `forkPoint`. Fork any run (`run.fork`), steer live runs (`followUp.send`), or let agents rewrite their own context (`context`) without losing the transcript.                 |
| **Agent loops are hard to test cleanly**         | Native Effect 4: scoped lifetimes, typed tagged errors, zero internal `Effect.runPromise`, and one-line `ModelFetch` swapping for zero-key offline tests.                                                  |
| **UI hosts rebuild state from scratch**          | Immutable copy-on-touch `SessionView`, `RunView`, and `TranscriptView` snapshots with browser-safe `./schemas` and `./transcript` entries.                                                                 |

## Quick start

Node.js 22.22.2+ (22.x) or 24.15+, ESM only.

```bash
npm install @texra-ai/worldline @texra-ai/llm effect @effect/platform-node @effect/sql-sqlite-node
```

Run an agent in 25 lines (no agent files; a run is plain data):

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

## At a glance

**Fork and resume across processes** (`persistent: true` writes to SQLite):

```ts
const session =
  yield * (yield * Sessions).open(platform.roots, { persistent: true });
const { runId: branchId } =
  yield * session.request({ kind: 'run.fork', runId });
yield *
  session.request({
    kind: 'followUp.send',
    runId: branchId,
    text: 'Try a formal proof.',
  });
const resumed = yield * session.resume(runId);
```

**Multi-agent workflows in plain JavaScript** (`codemode` QuickJS sandbox,
journaled and crash-replayed; see [`example/08-crash-and-resume.ts`](./example/08-crash-and-resume.ts)):

```js
const [a, b] = await Promise.all([
  self('Check section 1.', { schema: verdictSchema }),
  self('Check section 2.', { schema: verdictSchema }),
]);
return { verdicts: [a.structured.verdict, b.structured.verdict] };
```

**Typed tools, approvals, and zero-key offline tests** (`defineTool`, `session.attach`, `ModelFetch`):

```ts
const echo = defineTool({
  name: 'echo',
  description: 'Return supplied text.',
  lane: 'parallel',
  replay: 'safe',
  schema: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed(text),
});

// Swap the HTTP layer in tests (dummy key satisfies route selection):
process.env.ANTHROPIC_API_KEY ??= 'test-key';
Sessions.layer({ platform, plugins: harnessBuiltins, client }).pipe(
  Layer.provideMerge(Layer.succeed(ModelFetch)(scriptedFetch)),
);
```

## Entry points and examples

| Entry                            | Contents                                                                                                                        |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `@texra-ai/worldline`            | Core surface (~50 exports): `Sessions`, `Session`, `Run`, `AgentEvent`, `HostInteractions`, `ModelFetch`, tagged errors.        |
| `@texra-ai/worldline/schemas`    | Browser-safe: Effect schemas, read-only `SessionView` / `RunView` / `TranscriptView`, approval policy, error formatters.        |
| `@texra-ai/worldline/transcript` | Browser-safe: `RemoteSessionView` over transport `SessionInputs`, transcript rows and projections.                              |
| `@texra-ai/worldline/builtins`   | Built-in plugins: `harnessBuiltins` (`codemode`, `fileOps`, `goal`, `memoryWorkflow`, `multiAgent`, `web`).                     |
| `@texra-ai/worldline/plugins`    | Authoring: `defineTool`, `definePlugin`, `ToolContext`, `Settings`, `WorkspaceFs`, `Secrets`, `executed`, `nullishWithDefault`. |
| `@texra-ai/worldline/node`       | `nodePlatform(options)`, `setLogSink`, `LogSink`, `effectDiagnosticsLayer`.                                                     |
| `@texra-ai/worldline/host`       | Full app host composition (`processLayer`, skills, installed plugins). Consumed by TeXRA; no stability promise.                 |

Explore all **[14 runnable packed-tarball examples](./example/README.md)**
(custom plugins, approvals, `run.fork`, live `SIGKILL` crash recovery,
judge-verified goals, external npm plugins, self-editing context; zero API key
needed):

```bash
corepack pnpm --filter @texra-ai/worldline run example:packed
```

Full API reference: [`docs/api/`](./docs/api/index.md) · Protocol spec: [`docs/spec.md`](./docs/spec.md)

## Durable invariants

A run's next step comes strictly from committed SQLite rows (live stream chunks
are never recovery input). The crash-conformance suite slices real stores back
to every commit point and verifies ([`docs/spec.md`](./docs/spec.md)):

| ID     | Guarantee                                                                                                                   |
| :----- | :-------------------------------------------------------------------------------------------------------------------------- |
| **I1** | Recovery reaches the clean run's outcome: committed answers, tool results, owned children, and context edits are preserved. |
| **I2** | A tool call finishes once; committed results are reused and never re-executed.                                              |
| **I3** | A model invocation has at most one committed response.                                                                      |
| **I4** | Approval-gated commands run only after approval; unfinished commands with unknown outcome retry only after human choice.    |
| **I5** | Cleanly ended owned children answer their awaiting call on recovery; relaunching requires a retry decision.                 |
| **I6** | Child result delivery commits atomically with the turn that produced it and is consumed once.                               |
| **I7** | Compaction and fork preserve committed context; forks recover with their registered history.                                |
| **I8** | A stopped run's halt and terminal outcome commit together; recovery cannot continue an acknowledged stop.                   |
| **I9** | Disabling a shell approval bypass is acknowledged only after the policy row is durable.                                     |

## Storage failures

<details>
<summary><strong>S1–S6 error contract</strong></summary>

- **S1** `DatabaseOpenFailed`: store does not open. Earlier-build stores are refused unchanged; SQLite-damaged stores are moved aside (`storeMovedAside`) and never read again.
- **S2** `DatabaseStoreNewer`: store written by a newer build is refused whole (nothing read or written beside it).
- **S3** `DatabaseReadFailed`: failing read rejects. Undecodable runs (`DatabaseRowCorrupt`, `DatabaseRowEarlier`) list as unreadable and never resume; listings/tails skip with one warning.
- **S4** `DatabaseWriteFailed`: batch rolls back; inside a run, the run ends regardless of tool/model handling.
- **S5** `DatabaseAggregateClosed`: nothing written; the run stops without retry. A store held by another process fails open with `STORE_HELD_MESSAGE`.
- **S6** `RunChanged`: deletion against a superseded lifetime writes nothing. Store-rule violations (duplicate `run.start`) fail the writer fiber as a defect.

</details>

## Generated files and deletion

<details>
<summary><strong>Store layout (`&lt;namespace&gt;.project-v1.db`), `executions/`, and deletion rules</strong></summary>

Under its storage root, a session owns `<namespace>.project-v1.db` (default
`harness.project-v1.db`; older `<namespace>.db` files stay untouched) and
per-run directories `executions/<runId>/`. Project files are never touched;
corrupt stores (`*.corrupt-<ms>`) are removed only on explicit user deletion
(`deleteStorageInventory` / `texra doctor --prune-storage`).

- `run.delete` commits a `run.removed` marker closing the run and its owned
  descendants before touching disk; collection runs on open and after delete
  (idempotent across processes), removing closed directories, rows, and
  unreferenced blobs, retrying failed removals later.
- Only ended background shells left by earlier processes are auto-deleted at
  session open via the same marker.
- Before deleting, the collector resolves the storage root and `executions/`
  (refusing symlinks pointing outside; resolve-then-check).
- `run.files` copies a stopped run's directory into the project or removes it
  without deleting the run.

</details>

## Runtime reference

<details>
<summary><strong>Peer deps, approvals, Nunjucks `system` note, MCP, memory, logging, and limits</strong></summary>

- **Peers & credentials:** Install `effect`, `@effect/platform-node`,
  `@effect/sql-sqlite-node` (`^4.1.3`), and [`@texra-ai/llm`](../llm/README.md)
  (`^0.1.0`) with matching caret ranges so the host resolves one Effect and one
  `ModelError` instance. Keys come from `process.env` / workspace `.env` (Claude
  Max/Team and ChatGPT Pro/Business include monthly API credits).
- **Services & lifecycle:** Build `Sessions.layer` once per process (a second
  live build opening the same root fails). `sessions.close(roots)` returns
  `{ abandoned }`; releasing the layer closes all sessions. `RunEnd` is
  `{ outcome, usage?, output: { response, files, structured? }, error? }`
  (`runEndErrorMessage` formats errors). Pre-entry refusals fail with
  `LaunchRefused`, `ToolsRefused`, or `RunFailure`; `resume` fails with
  `ResumeRefused` (`finished`, `unusableCheckpoint`, `earlierBuild`,
  `pluginUnavailable`, `notResumable`).
- **System prompt (`system`):** Rendered once at launch as author-owned Nunjucks
  with `CWD`; never place end-user text inside `system` (`AGENTS.md`,
  `MEMORY.md`, paths, and git branch are never template-rendered).
- **Approvals:** Default policy is `yolo`; narrow with
  `approval: 'ask' | 'never'` or `Settings.set`. Under `ask`, attach
  `session.attach({ approve })` (requests are durable rows; questions and
  post-retry prompts never auto-answer).
- **Platform (`nodePlatform`):** Reads `<storageDir>/mcp.json` (stdio MCP
  `2025-11-25`), loads `<storageDir>/AGENTS.md` then `<workspace>/AGENTS.md`,
  exposes writable Markdown memory folders (`MEMORY.md`, first 16,000 chars),
  strips provider keys from shell children, honors `HTTP_PROXY` / `HTTPS_PROXY`
  / `NO_PROXY` (30m stream timeout), and logs via your Effect `Logger` or
  `effectDiagnosticsLayer` and `setLogSink`.

</details>

## Current limits

- **No handler under `ask` denies requests** and fails launches with
  `requiresApproval` tools (`ToolsRefused`); questions and post-retry prompts
  deny under any policy when unanswered.
- **Single-cycle by default** unless `interactive: true`.
- **0.x store compatibility:** Row schemas are not frozen before 1.0 (S1–S3).

## License

Licensed under [Apache-2.0](./LICENSE.txt).
