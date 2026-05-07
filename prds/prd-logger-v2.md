# PRD: Logger v2 — structured records, host sinks, schema unified with progress

**Status:** Draft (v1 — extracted from `prd-cli-app.md` round 2 §23; 2026-05-05)
**Owner:** TBD
**Date:** 2026-05-05
**Branch:** `claude/refactor-texra-cli-tOC5U`
**Companions:** [`prd-runcontext-refactor.md`](./prd-runcontext-refactor.md), [`prd-cli-app.md`](./prd-cli-app.md), [`prd-electron-app.md`](./prd-electron-app.md)

## 1. Summary

Today's logger (`src/logger/logUtils.ts`) is a serviceable VS Code-shaped string sink. It is also wrong for the CLI in three concrete ways (enumerated in §4) — module-level state that collides under concurrency, a second ALS scope that shadows the runtime host's scope, and a per-line config lookup that's silently ignored during boot — plus one duplication issue with the round-1 CLI NDJSON pipeline. This PRD specifies a host-neutral structured logger that:

- Emits **`LogRecord`s** (timestamp + level + message + structured fields + group stack), not pre-formatted strings.
- Routes every record through a per-host **`LogSink`** (extension → `vscode.OutputChannel`, desktop → `electron-log`, CLI text → stderr, CLI JSON → stdout NDJSON, CLI MCP → MCP `notifications/progress`, tests → in-memory).
- Lives on **`RunContext`** (per `prd-runcontext-refactor.md`) — one logger per run, no module globals, no second ALS scope.
- Shares a **single Zod schema** with the round-1 CLI progress NDJSON stream — `LogRecord` is a `ProgressEvent` with `event: "log"`. Tools that parse one parse the other.
- Provides a **`BootstrapLogger`** that buffers records emitted before `initPlatform()` returns, then flushes them through the host's chosen sink.

The total kernel work is ~430 LOC new + ~130 LOC modified + ~5 LOC deleted. None of it gates a v1 CLI deliverable except the structured CLI renderer (which today's logger cannot produce).

## 2. Goals

- Replace `LogBackend` (`src/platform/interfaces/log.ts`) with a `LogSink` that consumes `LogRecord` objects rather than formatted strings.
- Unify the round-1 CLI §11.2 NDJSON event stream with the log stream — one schema, one renderer pipeline, two surface modes (text vs JSON).
- Move group context off its own ALS (`src/logger/logUtils.ts:10` `contextStorage`) onto a per-`Logger` stack accessible via `withGroup`/`group`.
- Eliminate `outputChannelFactory` (line 21) and the `channels` Map (line 19) as module-level state — every host installs one `LogSink` per run via `RunContext.log`.
- Provide a `BootstrapLogger` so log lines emitted before `initPlatform()` returns are captured and replayed (today's `console.info` boot lines are unstructured and lose group context).
- Maintain backward compatibility: `src/logger/logUtils.ts`'s public functions (`debug`, `info`, `warn`, `error`, `runWithGroupContext`, `setOutputChannelFactory`) keep working for one release, deprecated, routing to the new logger.

## 3. Non-goals

- **Not** a logging-framework selection — no `pino`, no `winston`. The interface is small; the impl per host is small. We do not adopt a third-party framework's opinions.
- **Not** a redaction subsystem. The `prd-cli-app.md` round-1 §16 risk row mentions secret-redaction in the `consoleLog` adapter; that's a sink-level concern, sized separately, and not in scope here.
- **Not** a tracing system. Spans, trace IDs, and OpenTelemetry exporter wiring are future work. `LogRecord.fields` is open, so adding `traceId` later is non-breaking.
- **Not** a per-line filter language. Filtering by level / channel / agent is a sink concern — implemented in the host's sink, not in the kernel.
- **Not** a UI surface for browsing logs. The extension's existing OutputChannel pickers and the desktop's `electron-log` UI don't change.

## 4. Background — what's wrong with today's logger

`src/logger/logUtils.ts` is the canonical kernel logger today. Three concrete defects:

### 4.1 Module-level state collides under concurrency

`outputChannelFactory` (line 21) and the `channels` Map (line 19) are module-level. The general concurrency case for retiring this kind of binding is in `prd-runcontext-refactor.md` §4.5 (and `setOutputChannelFactory` is one of the 19 setter pairs in that PRD's §4.2 table). Logger-specific consequence: the `setOutputChannelFactory(null)` reset in test teardown calls `dispose?.()` on every cached channel and disposes channels for *other* concurrent runs — visible today only as occasional vitest flakes; visible always in an MCP-server or re-entrant-SDK process.

### 4.2 Two ALS scopes that shadow each other

Group context lives in its own ALS (`contextStorage`, line 10). `runtimeHostScope` (`AgentRuntimeHost.ts:12`) is the runtime context. A sub-agent emits a log line and passes through both scopes; the two are kept in sync by convention. It works today but it's fragile — every new background timer or `then()` boundary risks losing one scope but not the other.

### 4.3 Per-line config lookup

`writeLine` (line 79) calls `getConfig('texra.logger.debugMode', false)` _on every line_. In the extension that's a wrapped `vscode.workspace.getConfiguration` lookup — fast but not free. In the CLI before `initPlatform()` returns it goes through `tryPlatform()` and silently uses the default. Today's behavior is "config debug toggle is silently ignored during boot" — observed when debugging agent-directory bootstrap issues.

### 4.4 Non-bug observation: two parallel pipelines

The CLI's round-1 §11.2 NDJSON event stream is a _separate_ code path from the logger. Two formats, one schema is fine; two formats, two code paths is duplication that will bit-rot. Logger v2 unifies them.

## 5. Shape

### 5.1 The `Logger` interface

Lives on `RunContext` (per `prd-runcontext-refactor.md` §5). One `Logger` per run, plus a `BootstrapLogger` for the pre-`initPlatform()` window.

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
}
```

`LogSink` is a host port — installed once per `RunContext` (or once per host, if the host wants a process-shared sink). It accepts structured records; formatting is its job.

### 5.3 The `BootstrapLogger`

A `Logger` impl that buffers records in an array. `flushTo(sink)` drains the buffer through the given sink and switches subsequent emissions to direct passthrough.

```ts
export class BootstrapLogger implements Logger {
  private buffer: LogRecord[] = [];
  private downstream: LogSink | null = null;

  /* … level methods build a LogRecord, push onto buffer if downstream is null,
     otherwise write directly … */

  flushTo(sink: LogSink): void {
    this.downstream = sink;
    for (const r of this.buffer) sink.write(r);
    this.buffer.length = 0;
  }
}
```

The CLI's `bin/texra.ts` constructs a `BootstrapLogger` immediately, threads it through config-load + secret-resolution + agent-directory bootstrap, then calls `bootstrap.flushTo(stderrSink)` (or whichever sink the resolved mode picks) right after `initPlatform()` returns.

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

// ProgressEventSchema is the existing union from @eventBus/ProgressEventBus
// (event: "setActiveStream" | "setTaskState" | … )

export const RunStreamEventSchema = z.discriminatedUnion('event', [
  LogRecordSchema,
  ...progressEventVariants,
]);
```

Implications:

- The CLI's `--output-format ndjson` writes one `RunStreamEvent` per line. Consumers filter `event === 'log'` for logs and `event !== 'log'` for progress.
- The session JSONL format (per `prd-cli-app.md` §27) uses the same schema. A run's transcript is byte-equivalent to its NDJSON output (modulo synthetic `session_start` / `session_end` markers).
- A schema bump in either pipeline is a schema bump in the other. `@texra/shared/schemas` versioning gates both.

## 7. Per-host sinks

Each host installs the sinks it wants. The mapping:

| Host                                | Sink                      | Rendering                                                                                                      |
| ----------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Extension                           | `VscodeOutputChannelSink` | Formatted string per line, written to one `vscode.OutputChannel` per agent (today's behavior).                 |
| Desktop                             | `ElectronLogSink`         | Wraps `electron-log` (per `prd-electron-app.md` §6.4); same channel-per-agent shape.                           |
| CLI headless (`--print` or non-TTY) | `StderrTextSink`          | picocolors-formatted; respects `--quiet` / `--verbose` / `NO_COLOR`; copies to `--log-file` if passed.         |
| CLI JSON (`--output-format json     | ndjson`)                  | `NdjsonStdoutSink`                                                                                             | One `RunStreamEvent` per line on stdout; schema-validated. |
| CLI MCP server (`texra mcp serve`)  | `McpProgressSink`         | Converts each record to an MCP `notifications/progress` payload; respects the client's progress-update opt-in. |
| Tests                               | `MemorySink`              | Pushes records into an array; auto-installed via `withRunContext()` in `vitest.setup.ts`.                      |

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
- `Logger` is a field on `RunContext` (per `prd-runcontext-refactor.md`); add it to `buildRunContext()`.
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
- **Exit criteria:** `git grep "outputChannelFactory\|setOutputChannelFactory" packages/` returns zero hits. Phase aligns with `prd-runcontext-refactor.md` Phase 2 (singleton retirement); the two should land in the same release.

### Phase 5 — `McpProgressSink` (gates `texra mcp serve` v1.1) (~0.3 weeks)

- `McpProgressSink` in `packages/cli/src/mcp/sinks/`.
- Wires into the per-`tools/call` `RunContext` in the MCP server (per `prd-cli-app.md` §24.6).
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
