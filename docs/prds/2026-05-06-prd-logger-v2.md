---
created: 2026-05-06
updated: 2026-05-10
---

# PRD: Logger v2 — structured records, host sinks, decoupled progress schema

**Status:** Draft (v2 — round-2 revisions landed in §15; 2026-05-08)
**Owner:** TBD
**Date:** 2026-05-05
**Branch:** `claude/refactor-texra-cli-tOC5U`
**Companions:** [`2026-05-06-prd-runcontext-refactor.md`](./2026-05-06-prd-runcontext-refactor.md), [`2026-05-04-prd-cli-app.md`](./2026-05-04-prd-cli-app.md), [`2026-05-02-prd-electron-app.md`](./2026-05-02-prd-electron-app.md)

> **Canonical status:** §15 is the current design when it differs from earlier sections. In particular, `Logger.swapSink()`
> replaces `BootstrapLogger.flushTo()`, and logs + progress share NDJSON transport without sharing one schema.

## 1. Summary

Today's logger (`src/logger/logUtils.ts`) is a serviceable VS Code-shaped string sink. It is also wrong for the CLI in three concrete ways (enumerated in §4) — module-level state that collides under concurrency, a second ALS scope that shadows the runtime host's scope, and a per-line config lookup that's silently ignored during boot — plus one duplication issue with the round-1 CLI NDJSON pipeline. This PRD specifies a host-neutral structured logger that:

- Emits **`LogRecord`s** (timestamp + level + message + structured fields + group stack), not pre-formatted strings.
- Routes every record through a per-host **`LogSink`** (extension → `vscode.OutputChannel`, desktop → `electron-log`, CLI text → stderr, CLI JSON → stdout NDJSON, CLI MCP → MCP `notifications/progress`, tests → in-memory).
- Lives on **`RunContext`** (per `2026-05-06-prd-runcontext-refactor.md`) — one logger per run, no module globals, no second ALS scope.
- Shares the **same NDJSON transport** as the CLI progress stream while keeping `LogRecordSchema` and
  `ProgressEventSchema` versioned independently (per §15.1).
- Starts on an immediate stderr sink, then uses **`Logger.swapSink()`** to hand off to the resolved host sink without
  reordering boot-time records (per §15.2).

The total kernel work is ~430 LOC new + ~130 LOC modified + ~5 LOC deleted. None of it gates a v1 CLI deliverable except the structured CLI renderer (which today's logger cannot produce).

## 2. Goals

- Replace `LogBackend` (`src/platform/interfaces/log.ts`) with a `LogSink` that consumes `LogRecord` objects rather than formatted strings.
- Share the round-1 CLI §11.2 NDJSON transport with the progress stream without forcing log/progress schema lockstep.
- Move group context off its own ALS (`src/logger/logUtils.ts:10` `contextStorage`) onto a per-`Logger` stack accessible via `withGroup`/`group`.
- Eliminate `outputChannelFactory` (line 21) and the `channels` Map (line 19) as module-level state — every host installs one `LogSink` per run via `RunContext.log`.
- Provide a boot-time sink handoff (`Logger.swapSink()`) so log lines emitted before `initPlatform()` returns stay
  ordered and structured.
- Maintain backward compatibility: `src/logger/logUtils.ts`'s public functions (`debug`, `info`, `warn`, `error`, `runWithGroupContext`, `setOutputChannelFactory`) keep working for one release, deprecated, routing to the new logger.

## 3. Non-goals

- **Not** a logging-framework selection — no `pino`, no `winston`. The interface is small; the impl per host is small. We do not adopt a third-party framework's opinions.
- **Not** a redaction subsystem. The `2026-05-04-prd-cli-app.md` round-1 §16 risk row mentions secret-redaction in the `consoleLog` adapter; that's a sink-level concern, sized separately, and not in scope here.
- **Not** a tracing system. Spans, trace IDs, and OpenTelemetry exporter wiring are future work. `LogRecord.fields` is open, so adding `traceId` later is non-breaking.
- **Not** a per-line filter language. Filtering by level / channel / agent is a sink concern — implemented in the host's sink, not in the kernel.
- **Not** a UI surface for browsing logs. The extension's existing OutputChannel pickers and the desktop's `electron-log` UI don't change.

## 4. Background — what's wrong with today's logger

`src/logger/logUtils.ts` is the canonical kernel logger today. Three concrete defects:

### 4.1 Module-level state collides under concurrency

`outputChannelFactory` (line 21) and the `channels` Map (line 19) are module-level. The general concurrency case for retiring this kind of binding is in `2026-05-06-prd-runcontext-refactor.md` §4.5 (and `setOutputChannelFactory` is one of the 19 setter pairs in that PRD's §4.2 table). Logger-specific consequence: the `setOutputChannelFactory(null)` reset in test teardown calls `dispose?.()` on every cached channel and disposes channels for _other_ concurrent runs — visible today only as occasional vitest flakes; visible always in an MCP-server or re-entrant-SDK process.

### 4.2 Two ALS scopes that shadow each other

Group context lives in its own ALS (`contextStorage`, line 10). `runtimeHostScope` (`AgentRuntimeHost.ts:12`) is the runtime context. A sub-agent emits a log line and passes through both scopes; the two are kept in sync by convention. It works today but it's fragile — every new background timer or `then()` boundary risks losing one scope but not the other.

### 4.3 Per-line config lookup

`writeLine` (line 79) calls `getConfig('texra.logger.debugMode', false)` _on every line_. In the extension that's a wrapped `vscode.workspace.getConfiguration` lookup — fast but not free. In the CLI before `initPlatform()` returns it goes through `tryPlatform()` and silently uses the default. Today's behavior is "config debug toggle is silently ignored during boot" — observed when debugging agent-directory bootstrap issues.

### 4.4 Non-bug observation: two parallel pipelines

The CLI's round-1 §11.2 NDJSON event stream is a _separate_ code path from the logger. Two formats, one schema is fine; two formats, two code paths is duplication that will bit-rot. Logger v2 unifies them.

## 5. Shape

**Locality rule (structural, not stylistic).** The `Logger`/`LogRecord`/`LogSink` interfaces and the bootstrap queue (§5.3) live in core with **zero heavy dependencies** — no `fs`, `vscode`, `electron-log`, `axios`, `picocolors`. Concrete sinks live in their host packages (`packages/{extension,desktop,cli}/sinks/*.ts`) and are imported only at the composition root (`extension.ts`, `cli/bin/texra.ts`, `desktop/main.ts`). This prevents import cycles and lets any deep module call `ctx.log.error(...)` without dragging host machinery into its dependency closure. CC's `utils/log.ts` (362 LOC, no fs/axios) vs. `utils/errorLogSink.ts` (235 LOC, all the heavy I/O) is the canonical shape; the split docstring at `errorLogSink.ts:9-10` calls out the import-cycle motivation explicitly. Enforce via an ESLint rule (no `vscode`/`electron-log`/`axios`/`fs` imports under `core/runtime/logger.ts` and its siblings).

### 5.1 The `Logger` interface

Lives on `RunContext` (per `2026-05-06-prd-runcontext-refactor.md` §5). One `Logger` per run, plus a module-level bootstrap queue (§5.3) for the pre-`initPlatform()` window.

```ts
// packages/core/src/runtime/logger.ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  /** Stream lineage. Auto-injected by RunContext.log; usable by hosts for prefix. */
  readonly streamId?: StreamTabId;
  readonly runId?: RunId;
  readonly groupId?: string;
  /** Free-form structured data; the host decides whether to render it. */
  readonly [k: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;

  /** Push a group; returned function pops it. Replaces logUtils' ALS. */
  group(label: string): () => void;
  /** Wrap an async fn in a group; returns its result. */
  withGroup<T>(label: string, fn: () => Promise<T> | T): Promise<T>;

  /** Per-domain child — adds a static field to every emission. Cheap. */
  child(fields: LogFields): Logger;
  /** Swap to a new sink after boot; awaits the previous sink's flush/close hooks. */
  swapSink(next: LogSink): Promise<void>;
}
```

### 5.2 The `LogRecord` and `LogSink`

```ts
export interface LogRecord {
  ts: string; // ISO-8601 with millis
  level: LogLevel;
  message: string;
  fields: LogFields;
  groups: readonly string[]; // current group stack at emit time
}

export interface LogSink {
  write(record: LogRecord): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}
```

`LogSink` is a host port — installed once per `RunContext` (or once per host, if the host wants a process-shared sink). It accepts structured records; formatting is its job.

### 5.3 Bootstrap queue (no class)

A module-level queue + idempotent `attachSink()` function. ~50 LOC. No `BootstrapLogger`-implementing wrapper class — the queue _is_ the bootstrap behavior.

```ts
// packages/core/src/runtime/logger.ts
const bootstrapQueue: LogRecord[] = [];
let bootstrapSink: LogSink | null = null;

function emit(record: LogRecord): void {
  if (bootstrapSink === null) {
    bootstrapQueue.push(record);
    return;
  }
  bootstrapSink.write(record);
}

/** Idempotent. Safe to call from preAction hook + main setup() without coordination. */
export function attachSink(sink: LogSink): void {
  if (bootstrapSink !== null) return;
  bootstrapSink = sink;
  for (const r of bootstrapQueue) sink.write(r);
  bootstrapQueue.length = 0;
}
```

The CLI's `bin/texra.ts` calls `attachSink(stderrSink)` (or whichever sink the resolved mode picks) right after `initPlatform()` returns. Records emitted before that call buffer in `bootstrapQueue`; records emitted after passthrough directly. Idempotency mirrors CC's `attachErrorLogSink` (`utils/log.ts:109-134`) — multiple call sites can attach without coordination.

`Logger.swapSink()` per §15.2 keeps its existing role for _runtime_ sink replacement (theme picker preview, log-file rotation), distinct from boot handoff.

## 6. Schema unification with progress events

The round-1 CLI PRD §11.2 specs an NDJSON event stream (`{ts, event, streamId, …}`). Logger v2's `LogRecord` becomes the `event: "log"` variant of that union:

```ts
// packages/core/src/shared/schemas/runStream.ts (new)
import { z } from 'zod';

export const LogRecordSchema = z.object({
  event: z.literal('log'),
  ts: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  fields: z.record(z.unknown()),
  groups: z.array(z.string()).readonly(),
});

// ProgressEventSchema is the existing union from @eventBus/ProgressEventContract
// (event: "setActiveStream" | "setTaskState" | … )

export const RunStreamEventSchema = z.discriminatedUnion('event', [
  LogRecordSchema,
  ...progressEventVariants,
]);
```

Implications:

- The CLI's `--output-format ndjson` writes one `RunStreamEvent` per line. Consumers filter `event === 'log'` for logs and `event !== 'log'` for progress.
- The session JSONL format (per `2026-05-04-prd-cli-app.md` §27) uses the same schema. A run's transcript is byte-equivalent to its NDJSON output (modulo synthetic `session_start` / `session_end` markers).
- A schema bump in either pipeline is a schema bump in the other. `@texra/shared/schemas` versioning gates both.

## 7. Per-host sinks

Each host installs the sinks it wants. The mapping:

| Host | Sink | Rendering |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Extension | `VscodeOutputChannelSink` | Formatted string per line, written to one `vscode.OutputChannel` per agent (today's behavior). |
| Desktop | `ElectronLogSink` | Wraps `electron-log` (per `2026-05-02-prd-electron-app.md` §6.4); same channel-per-agent shape. |
| CLI headless (`--print` or non-TTY) | `StderrTextSink` | picocolors-formatted; respects `--quiet` / `--verbose` / `NO_COLOR`; copies to `--log-file` if passed. |
| CLI JSON (`--output-format json     | ndjson`) | `NdjsonStdoutSink` | One `RunStreamEvent` per line on stdout; schema-validated. |
| CLI MCP server (`texra mcp serve`) | `McpProgressSink` | Converts each record to an MCP `notifications/progress` payload; respects the client's progress-update opt-in. |
| Tests | `MemorySink` | Pushes records into an array; auto-installed via `withRunContext()` in `vitest.setup.ts`. |

Per-host sinks live in their respective host packages (`packages/{extension,desktop,cli}/`); only the interface lives in `core/hosts/logSink.ts`.

## 8. Migration path

### 8.1 The shim

Today's `src/logger/logUtils.ts` exports `debug(channel, message, options)` etc. — channel-first signatures used at ~40 import sites. Logger v2's call site is `ctx.log.info(message, fields)` — channel becomes a field on the per-`child()` logger.

The shim keeps the old signatures working:

```ts
// src/logger/logUtils.ts (after migration)
export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  const ctx = tryUseRunContext();
  const logger = ctx
    ? ctx.log.child({ channel, isAgent: options.isAgent ?? false })
    : bootstrapLogger.child({ channel, isAgent: options.isAgent ?? false });
  logger.info(message, options.data ? { data: options.data } : undefined);
}
```

Same shape for `debug`, `warn`, `error`. No call site changes for one release; `@deprecated` annotations point to the new path.

### 8.2 `runWithGroupContext` migration

The current `runWithGroupContext()` is mechanically replaced:

```ts
// before
await runWithGroupContext(channel, groupId, isAgent, async () => {
  logger.info(channel, 'doing thing');
});

// after
await ctx.log.child({ channel }).withGroup(groupId, () => {
  ctx.log.info('doing thing');
});
```

Both forms run for one release. The `contextStorage` ALS in `logUtils.ts:10` is deleted at the end of the migration.

### 8.3 Boot-time logging

The CLI emits ~3–5 log lines before `initPlatform()` returns:

1. Config-layer load: "loaded config from `~/.config/texra/config.yaml` + `.texra/config.yaml`".
2. Secret resolution: "using keyring backend `secret-service`".
3. Agent-directory bootstrap: "synced 47 bundled agents".
4. Workspace resolution: "resolved cwd to /home/user/proj".
5. Mode selection: "selected `headless` (CI=true)".

Today these go through `console.info`. After this PRD: the CLI's `bin/texra.ts` constructs `bootstrapLogger = new BootstrapLogger()` immediately and threads it through every pre-`initPlatform()` call. After `initPlatform()` returns and the host's sink is installed, `bootstrapLogger.flushTo(sink)` drains the buffer.

## 9. Phases

### Phase 0 — Interface + bootstrap (~1 week)

- Add `core/runtime/logger.ts` with `Logger`, `LogRecord`, `LogSink`, `BootstrapLogger`.
- Add `core/shared/schemas/runStream.ts` with `LogRecordSchema` + the `RunStreamEventSchema` union. Move existing progress-event Zod schemas alongside.
- `Logger` is a field on `RunContext` (per `2026-05-06-prd-runcontext-refactor.md`); add it to `buildRunContext()`.
- The default sink during this phase is `consoleLog`-shaped: `class LegacyConsoleSink implements LogSink { write(r) { console[r.level](formatLikeBefore(r)); } }`. Keeps existing behavior.
- **Exit criteria:** `ctx.log.info('hi', { foo: 'bar' })` from inside `executeAgent()` produces the same console output the old logger did, plus the structured `{ foo: 'bar' }` payload visible to a `MemorySink` in tests.

### Phase 1 — Per-host sinks, except MCP (~1 week)

- `VscodeOutputChannelSink` in `packages/extension/`.
- `ElectronLogSink` in `packages/desktop/`.
- `StderrTextSink` and `NdjsonStdoutSink` in `packages/cli/`.
- `MemorySink` in `core/runtime/testing.ts`.
- Each host's bootstrap flow: construct `BootstrapLogger`, run pre-`initPlatform` work, install host-specific sink, `bootstrap.flushTo(sink)`.
- **Exit criteria:** Three hosts produce their existing log output through Logger v2. `texra run polish --output-format ndjson` writes `event: "log"` records to stdout, validated against the schema.

### Phase 2 — Schema unification with progress (~0.5 weeks)

- Migrate the round-1 §11.2 progress NDJSON renderer to use `RunStreamEventSchema` directly. Delete the duplicated formatting logic in `cli/src/runtime/progressSink/json.ts`.
- The progress sink and the log sink converge — both write `RunStreamEvent`s to the same NDJSON pipe. Order is preserved.
- **Exit criteria:** the integration test `texra run polish --output-format ndjson | tail -1 | jq .event === "session_end"` passes; `cat <session>.jsonl | jq -c 'select(.event == "log")' | wc -l` equals the count of log records emitted during the run.

### Phase 3 — `runWithGroupContext` retirement + `contextStorage` ALS deletion (~0.5 weeks)

- Convert ~10 reader sites of `runWithGroupContext` to `ctx.log.withGroup`.
- Delete `contextStorage` from `src/logger/logUtils.ts:10` and `runWithGroupContext` itself.
- **Exit criteria:** `git grep "runWithGroupContext\|contextStorage" packages/core/` returns zero hits.

### Phase 4 — `outputChannelFactory` + module-level state retirement (~0.5 weeks)

- Delete `outputChannelFactory`, `channels`, `mainOutputChannel`, `setOutputChannelFactory` from `logUtils.ts`. The extension's old call site (`packages/extension/src/extension.ts`) instead installs `VscodeOutputChannelSink` via `Platform.log`.
- The `LogBackend` interface in `core/platform/interfaces/log.ts` is renamed to `LogSink` and moved to `core/hosts/logSink.ts` to live alongside the other host ports.
- **Exit criteria:** `git grep "outputChannelFactory\|setOutputChannelFactory" packages/` returns zero hits. Phase aligns with `2026-05-06-prd-runcontext-refactor.md` Phase 2 (singleton retirement); the two should land in the same release.

### Phase 5 — `McpProgressSink` (lands when `texra mcp serve` ships, post-v1.x — see §15.5) (~0.3 weeks)

- `McpProgressSink` in `packages/cli/src/mcp/sinks/`.
- Wires into the per-`tools/call` `RunContext` in the MCP server (per `2026-05-04-prd-cli-app.md` §24.6).
- **Exit criteria:** an MCP client running `tools/call` with `progressToken` set receives `notifications/progress` for each log + progress event in the run.

### Aggregate timeline

| Phase     | Scope                                                            | Net LOC           | Engineering weeks |
| --------- | ---------------------------------------------------------------- | ----------------- | ----------------- |
| 0         | Interface + bootstrap + legacy sink                              | +200 / -10        | 1                 |
| 1         | Per-host sinks (extension, desktop, CLI text, CLI ndjson, tests) | +250 / -50        | 1                 |
| 2         | Schema unification with progress                                 | +30 / -80         | 0.5               |
| 3         | Group ALS retirement                                             | +20 / -60         | 0.5               |
| 4         | `outputChannelFactory` retirement                                | +20 / -90         | 0.5               |
| 5         | MCP sink                                                         | +80               | 0.3               |
| **Total** |                                                                  | **+~600 / -~290** | **~3.8**          |

Net code: **~+310 LOC** (the new structured pipeline is bigger than the string-based one it replaces, but the 5 host sinks together are smaller than today's extension-only output-channel logic plus the JSON-renderer duplication).

## 10. Compatibility

- Existing `src/logger/logUtils.ts` exports stay for one release as `@deprecated` shims that route to the new logger. Deletion in v1.x.
- Existing `LogBackend` interface stays for one release, renamed to `LogSink` with a re-export. Deletion in v1.x.
- Existing `texra.logger.debugMode` config key stays. The new pipeline reads it at sink construction (via `ConfigProvider.watch()`), not on every line.

## 11. Risks & mitigations

| Risk                                                                          | Likelihood | Impact | Mitigation                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 sinks render differently from the old logger and surface a regression | Medium     | Low    | Snapshot tests in `packages/extension/`, `packages/desktop/`, `packages/cli/` capture the rendered output for representative records. CI gate.                                     |
| Schema unification breaks downstream NDJSON consumers (e.g., `texra-action`)  | Low        | High   | `RunStreamEventSchema` is a strict superset of today's `ProgressEventSchema`. Breaking changes bump `@texra/shared/schemas` major. Documented in the round-1 §11.2 schema doc.     |
| `BootstrapLogger`'s buffer grows unbounded when boot fails                    | Low        | Low    | Cap at 1,000 records; warn on overflow. Boot is normally <10 records.                                                                                                              |
| `LogFields` is open-ended; consumers serialize non-JSON-safe values           | Medium     | Medium | Sink-level guard: `JSON.stringify(record)` is exception-caught; on failure, the sink writes a degraded `{level: 'error', message: 'log serialization failed', error: ...}` record. |
| Concurrent runs in one process produce interleaved output on `StderrTextSink` | Medium     | Low    | Each record carries `streamId`/`runId` in fields; `StderrTextSink` renders a `[stream-N]` prefix when more than one run is active.                                                 |
| Extension's existing OutputChannel API doesn't accept structured fields       | Low        | Low    | `VscodeOutputChannelSink` flattens `fields` to `key=value` suffixes — same shape today's logger emits when `texra.logger.debugMode = true`.                                        |

## 12. Success criteria

- After Phase 4, `git grep "AsyncLocalStorage" packages/core/src/logger/` returns zero hits. (The remaining ALS in the kernel is `runContextScope`.)
- After Phase 4, `packages/core/src/logger/logUtils.ts` is gone or reduced to a re-export shim.
- A `texra run` and the same `texra-action` workflow against the same `--output-format ndjson` produce byte-equivalent output streams.
- The kernel's existing `npm run typecheck` and the test suite pass on every phase merge.
- An MCP client receives `notifications/progress` for every log emitted inside a `tools/call` (Phase 5 integration test).
- Boot-time log lines from `texra` show up _with_ their structured fields in the final rendered output, not before init drops them.

## 13. Decisions

- **`LogSink.write` is sync; sinks that need async batching wrap their own queue and flush via `flush?()`.** Every kernel emit site assumes sync.
- **The extension's per-agent OutputChannel pattern is preserved** — implemented as a `VscodeOutputChannelSink` configuration option, not a kernel-level concept. Other hosts opt out.

## 14. Open questions

- **Should `BootstrapLogger` be exposed as a public API for SDK consumers?** Some users may want to capture pre-init logs from `runAgent()`. Lean: yes; export from `@texra/cli/sdk` once the SDK lands.
- **Schema versioning policy: per-record `schemaVersion` field, or repo-version pinning?** Per-record is robust to in-flight upgrades but bloats every line by ~20 bytes. Lean: repo-version pinning; consumers verify `@texra/shared/schemas` major matches.
- **Do we need a `trace` level below `debug`?** Today's vocabulary stops at `debug`. OTel uses `trace`. Lean: not yet — add when a consumer asks.

## 15. Tech stack one-liner

```
LogRecord (structured) + LogSink (host port) + BootstrapLogger (pre-init buffer)
- one Logger per RunContext, no module-level state, no second ALS scope
- per-host sinks: VscodeOutputChannel, electron-log, stderr text, NDJSON stdout, MCP progress, in-memory tests
- LogRecord is event: "log" in the unified RunStreamEvent schema (shared with progress NDJSON)
- Phased migration with deprecated shims for one release; net ~+310 LOC across the kernel
```

The logger gets honest about being structured. The CLI's two output pipelines become one. The kernel loses its second ALS scope and its last module-level state in `src/logger/`. That's the whole story.

---

## 15. Round 2 revisions (2026-05-08)

User-feedback review after round 1 surfaces three places the design is tighter than it needs to be and one place it is too loose. The structured-record + per-host-sink + per-`RunContext` core stays — it correctly retires today's three concrete defects (§4). The four deltas:

### 15.1 Cut: schema unification with progress events (was §6)

**Problem.** Round 1 §6 makes `LogRecord` an `event: "log"` variant of the `RunStreamEvent` union. Every schema change in either pipeline ripples to the other. Logger fields churn often (new structured keys, new sinks, new levels); progress events are stable (driven by webview consumers and `texra-action`). Coupling slow-changing infra to fast-changing infra is the wrong direction — the _logger_ will be the one churning, and consumers of the _progress_ schema will pay for it.

**Resolution.** Share the _transport_, not the _schema_. Both pipelines write NDJSON to the same stdout in `--output-format ndjson` mode, but `LogRecordSchema` and `ProgressEventSchema` are versioned independently. A new top-level `kind: "log" | "progress"` literal is added to both schemas alongside the existing per-event `event` field (which `ProgressEventSchema` already carries; for `LogRecordSchema` `event` collapses to the literal `"log"`). Consumers filter by `kind` first — cheaper than a flat discriminated union over ~20 progress event names + 1 log event, and lets a consumer that only cares about progress skip the entire `LogRecord` Zod parse.

**LOC delta.** Phase 2 (was 0.5 weeks, +30/-80) is removed. The progress NDJSON renderer keeps its own schema; the log NDJSON sink keeps its own. Net: -30 LOC versus round 1's +30/-80, plus 0.5 weeks saved.

### 15.2 Replace: `BootstrapLogger.flushTo` with `Logger.swapSink` (was §5.3)

**Problem.** Round 1 buffers pre-`initPlatform()` records, then drains them through the host-resolved sink. Boot lines like "loaded config from …" can appear _after_ "starting agent" in the user's terminal because they were buffered until the sink resolved. Confusing for users debugging boot-time issues — exactly the case where ordering matters most.

**Resolution.** Pick a default `StderrTextSink` _immediately_ at process start (no config dependency — `picocolors` auto-disables on `!isTTY`), and _swap_ to a richer sink (NDJSON, Ink, MCP) only when the mode is resolved. The swap awaits the previous sink's `flush?()` and `close?()` so no records are dropped at the boundary.

```ts
// packages/cli/src/runtime/initLogger.ts
const initialSink = new StderrTextSink({
  colors: process.stderr.isTTY && !process.env.NO_COLOR,
});
const logger = new Logger(initialSink);
// run config load, secret resolution, agent-directory bootstrap (all log to stderr) …
// after mode resolves:
await logger.swapSink(resolveSink(mode)); // awaits previous flush + close
```

**Interface delta (extends §5.1 / §5.2).** `Logger` gains:

```ts
swapSink(next: LogSink): Promise<void>;
```

`LogSink` gains an optional `close?()` for sinks that hold resources (file handles, MCP transports, queued stdout writes). Sinks without resources omit it. `swapSink`'s contract: `await previous.flush?(); await previous.close?(); /* install next */`.

**LOC delta.** `BootstrapLogger` class collapses to the `Logger.swapSink()` method (~30 LOC instead of ~80). The 1,000-record overflow cap from §11 becomes unnecessary — there is no buffer to overflow.

### 15.3 Replace: `Logger.child({ channel })` shim pattern (was §8.1)

**Problem.** Round 1's shim has every legacy `info(channel, msg)` call wrap as `bootstrapLogger.child({ channel })`. ~40 call sites; any one that forgets `.child()` loses channel attribution silently. A lint rule catches it but it is friction every time a new module logs.

**Resolution.** Derive `channel` from `RunContext.streamId` + agent metadata that is already on the context. Call sites stop passing channel.

```ts
// src/logger/logUtils.ts (after migration)
export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  const ctx = tryUseRunContext();
  // channel argument ignored — kept for source compatibility,
  // deprecation warning emitted once per module
  (ctx?.log ?? bootstrapLogger).info(
    message,
    options.data ? { data: options.data } : undefined,
  );
}
```

`channel` is no longer a logical concept; the structured `streamId` + agent name in `LogRecord.fields` is what hosts render. The extension's `VscodeOutputChannelSink` maps `streamId` → channel-per-agent (current behavior preserved); CLI sinks render `[stream-N]` prefix when more than one run is active.

**LOC delta.** Shim drops from ~120 modified call sites to ~5 (just the deprecation-warning bookkeeping). Phase 3 stays at 0.5 weeks but with much less mechanical churn. Knock-on: Phase 4 (§15.6) drops from §9's 0.5w to 0.3w because the channel-derivation work that originally lived there is paid for here.

### 15.4 Tighten: `LogSink.write` is sync; slow sinks queue internally (was §13 open question)

**Problem.** Round 1 §13 left this open. Sync simplifies kernel call sites but means a slow sink (NDJSON serialization with deep object traversal, MCP `notifications/progress` over a slow stdio transport) blocks the agent loop.

**Resolution.** Keep `write` sync at the interface — every kernel call site stays cheap. Slow sinks (`NdjsonStdoutSink`, `McpProgressSink`) maintain an internal queue + `setImmediate` flush so a million-token tool result does not stall agent execution. `flush?()` is invoked at every group pop (the closure returned by `Logger.group()` and the tail of `Logger.withGroup()`) so a sink can finalize a stanza of records together, and at process shutdown / `swapSink` (per §15.2). The example handles `process.stdout` backpressure (the `false` return + `'drain'` event per Node streams docs) and uses an index head rather than `Array.shift()` to avoid O(n²) behavior under heavy logging:

```ts
// packages/cli/src/render/sinks/NdjsonStdoutSink.ts
class NdjsonStdoutSink implements LogSink {
  private queue: LogRecord[] = [];
  private head = 0;
  private draining = false;
  private idle = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  write(r: LogRecord): void {
    this.queue.push(r);
    if (!this.draining) {
      this.draining = true;
      this.idle = new Promise<void>((resolve) => {
        this.resolveIdle = resolve;
      });
      setImmediate(() => this.drain());
    }
  }

  async flush(): Promise<void> {
    if (this.draining) await this.idle;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private drain(): void {
    while (this.head < this.queue.length) {
      const line = JSON.stringify(this.queue[this.head++]) + '\n';
      const ok = process.stdout.write(line);
      if (!ok) {
        // backpressure: re-enter drain after the kernel buffer empties.
        // Stay 'draining' so flush() keeps awaiting `idle` — we only
        // resolve it once the queue is genuinely empty (below).
        process.stdout.once('drain', () => setImmediate(() => this.drain()));
        return;
      }
    }
    this.queue.length = 0;
    this.head = 0;
    this.draining = false;
    // Null before calling so a re-entrant write() inside resolve() sees
    // a fresh idle promise on its next turn, not the one we're resolving.
    const resolve = this.resolveIdle;
    this.resolveIdle = null;
    resolve?.();
  }
}
```

The single `idle` promise resolves only when the queue is genuinely empty — that is, only at the bottom of `drain()` after every record has crossed `process.stdout.write()`. Backpressure re-enters `drain()` via `'drain'` + `setImmediate` without touching `idle`, so `flush()` (which awaits `idle`) keeps waiting until the final write lands. This avoids the race in earlier drafts where a `'drain'`-event handler resolved the wait promise before the next `drain()` cycle ran.

**LOC delta.** ~50 LOC added to the two slow sinks; interface gains optional `close?()` per §15.2.

### 15.5 Defer: Phase 5 (`McpProgressSink`) is out of the v1.x roadmap

**Problem.** Round 1 Phase 5 lands `McpProgressSink` for `texra mcp serve`. Per [`2026-05-04-prd-cli-app.md`](./2026-05-04-prd-cli-app.md) round 4 §34.6, `texra mcp serve` itself is **not part of the v1.x roadmap** (user direction reinforced 2026-05-09: "Don't do MCP yet").

**Resolution.** Phase 5 stays in the plan as a future deliverable that lands alongside `texra mcp serve` whenever that ships. The CLI v1.x logger pipeline never instantiates `McpProgressSink` — the only sinks v1.x needs are `StderrTextSink` (headless + interactive log lines), `NdjsonStdoutSink` (for `--output-format ndjson`), `InkLogSink` (for routing log records into the `<StreamPane />` component), and `MemorySink` (tests).

### 15.6 Trimmed phase plan

| Phase                 | Scope (revised)                                                                                                                                         | Weeks           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 0                     | Interface (`Logger.swapSink`, `LogSink.close?()` per §15.2) + immediate stderr default + legacy `LegacyConsoleSink`                                     | 1               |
| 1                     | Per-host sinks (extension, desktop, CLI text, CLI ndjson, CLI Ink REPL, tests)                                                                          | 1.2             |
| ~~2~~                 | ~~Schema unification with progress~~                                                                                                                    | **cut** (§15.1) |
| 3                     | Group ALS retirement (`runWithGroupContext` → `Logger.withGroup`); auto-derived channel from `RunContext.streamId` (per §15.3)                          | 0.5             |
| 4                     | `outputChannelFactory` / `channels` / `mainOutputChannel` removals (channel-derivation cleanup already landed in Phase 3, so only the deletions remain) | 0.3             |
| 5                     | `McpProgressSink` — lands when `texra mcp serve` ships (out of v1.x per round 4 §34.6)                                                                  | 0.3             |
| **Total to CLI v1.0** | Phases 0 / 1 / 3 (interactive + workflow; no MCP)                                                                                                       | **~2.7**        |
| **Total to CLI v1.1** | + Phase 4 (when `2026-05-06-prd-runcontext-refactor.md` Phase 2 lands)                                                                                  | **~3.0**        |
| **Total with MCP**    | + Phase 5 (when `texra mcp serve` ships, post-v1.x)                                                                                                     | **~3.3**        |

Net code reduction vs round 1: Phase 2 cut saves \~30 LOC, simpler bootstrap saves \~50 LOC, simpler shim saves \~80 LOC of mechanical changes. Round-1 §9 estimated +600/-290 ≈ +310 net; round-2 estimate is **\~+200 net** to v1.0, **\~+220 net** to v1.1 (Phase 4 only — Phase 5 / `McpProgressSink` is no longer in v1.x; it adds \~+80 net whenever MCP eventually ships).

### 15.7 What round 2 does NOT change

The round-1 _direction_ is correct and ships unchanged: structured `LogRecord`, host-port `LogSink`, one logger per `RunContext`, retirement of `outputChannelFactory` and `contextStorage` ALS, deprecation shims through `logUtils.ts` for one release. Round 2 is a tightening pass on the migration mechanics, not a redesign.

## 16. Single source of truth and abstraction budget

Logger v2 has one shared semantic object: `LogRecord`. Its schema, grouping semantics, run identity fields, and severity vocabulary are the single source of truth for extension, desktop, and CLI logging. Host packages may implement sinks and renderers, but they must not define parallel log shapes or reinterpret log levels.

A logger abstraction is acceptable only when it owns one of the following: record construction, group lifetime, sink flushing, host rendering, or temporary compatibility during migration. A file that merely renames `info`, `warn`, or `error` and forwards to another logger is not part of the design unless it is the documented migration shim and has a removal phase.

PRs for this PRD must state:

- The log source of truth affected by the change.
- Which host sinks are affected: extension, desktop, CLI, tests.
- Which old logging path was removed or intentionally left as a compatibility shim.
- Why any new abstraction is deeper than a pass-through layer.
