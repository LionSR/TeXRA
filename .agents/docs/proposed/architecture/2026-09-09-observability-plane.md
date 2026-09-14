---
created: 2026-09-09
status: proposed
---

# One observability plane: Effect-native diagnostics, trace, and secrets

**Recommendation:** stop treating "the logger" as a subsystem to rebuild. TeXRA has one
observability plane implemented as five unrelated mechanisms, and Effect 4 already supplies
every one of them over a single fiber context. The 1.0 work is demolition, not construction:
each mechanism is deleted by the subsystem conversion that already owns it, and what remains
is `Effect.log*` at call sites plus one `Logger` per host.

The measurements below are taken against `main` at `fd31769` on 2026-09-09, and the Effect
APIs are read from the pinned `effect@4.0.0-rc.112` package sources rather than inferred.

## 1. The finding: one plane, five mechanisms

| Mechanism         | Where                                                                        | Shape                                               | Measured                                       |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| Channel logger    | [`logUtils.ts`](../../../../src/logger/logUtils.ts)                          | module-global sink map, host-injected factory       | 256 lines, 190 importing files, 502 call sites |
| Effect bridge     | [`effectDiagnostics.ts`](../../../../src/logger/effectDiagnostics.ts)        | routes Effect logs _inward_ to the channel logger   | 95 lines                                       |
| CLI logger        | [`logSinks.ts`](../../../../packages/cli/src/runtime/logSinks.ts)            | its own `LogRecord` / `LogSink` / `createCliLogger` | separate type set                              |
| Desktop logger    | [`desktopAppLog.ts`](../../../../packages/desktop/src/main/desktopAppLog.ts) | `console` monkey-patch, text file, regex re-parse   | severity lost and reconstructed                |
| Redaction scanner | [`redaction.ts`](../../../../src/logger/redaction.ts)                        | per-provider regex battery over formatted text      | 118 lines                                      |

Two consequences worth stating plainly, because they are defects rather than untidiness.

**Desktop severity loss is structural.** Desktop never calls `setOutputChannelFactory` — only
`packages/extension/src/extension.ts:472` and `packages/cli/src/runtime/initPlatform.ts:266` do.
Every core `log.warn()` on desktop therefore falls to the `console.info` fallback in
`logUtils.ts`, the mirror stamps it `[info]` (`desktopAppLog.ts:131`), and the real level survives
only as the text `WARN ` inside the message, which `LOG_LINE_PATTERN`
(`packages/desktop/src/renderer/logsPane.ts:65`) then parses back out. PR #12134 recovers the
severity by extending that parse. The 1.0 plan's disposition for it — carry structured severity,
do not add another text protocol — is right, and this design removes the flattening step instead
of compensating for it.

**Redaction compensates at render time.** `redaction.ts` scans formatted output for `sk-`,
`AIza`, `AQ.`, `xai-`, `Bearer`, and secret-shaped JSON properties. That is a scanner
compensating for secrets living in the data model as plain strings — the same shape the
repository's own UI guardrail forbids for renderers.

## 2. What is genuinely two things, and must stay two

The transcript plane and the diagnostics plane are different products and should not merge:

- **Transcript** — user-facing, durable, folded into SQLite and rendered by three hosts.
  Owns `AgentEvent`, `SessionEvent`, and the four-level `LogLevel` in
  [`schemas/log.ts`](../../../../src/shared/schemas/log.ts).
- **Diagnostics** — operator-facing, ephemeral, host-surfaced. Owns nothing durable.

The defect is not that they are separate. It is that each has independently invented the parts
that are the _same_: identity, ordering, redaction, level, and lifetime. This design unifies
those five and keeps the two sinks distinct.

Because the logger stops importing `@shared/schemas/log`, the two level vocabularies never meet
and need no mapping layer. That import is currently the **only** entry in the `floors` class of
`shared-schemas-deep-import-baseline.json`; deleting `logUtils.ts` empties the class.

## 3. The design

### 3.1 Identity comes from the fiber, not from parameters

Effect's log record already carries the identity every mechanism is threading by hand.
`Logger.formatStructured` yields exactly:

```
{ level, fiberId, timestamp, message, cause, annotations, spans }
```

So there is **no TeXRA log record type to define** — defining one duplicates `Logger.Options`.
Identity is supplied by `Effect.annotateLogs` (`executionId`, `streamId`).

One correction to an earlier draft of this note, established by running it: the entry's `spans`
field reads `CurrentLogSpans`, which only `Effect.withLogSpan` writes. A **tracer** span opened by
`Effect.withSpan` or `Effect.fn` does _not_ attribute a log entry, so the tracing spans this code
already opens cannot serve as the channel. Annotations are the carrier; `withLogSpan` is available
where a labelled, timed region is wanted, and is used nowhere today.

This retires three separate identity mechanisms:

- the `channel` string threaded through 502 call sites,
- the per-instance `AsyncLocalStorage<string[]>` stage scope in `TraceEmitter.ts`,
- the `channelKey(channel, isAgent)` sink map in `logUtils.ts`.

A run's channel becomes an annotation whose lifetime is the run's scope, which also deletes
`disposeAgentChannel` and the run-once `released` guard in `attachChannelSubscriber`.

### 3.2 Diagnostics: `Effect.log*` at call sites, one `Logger` per host

No facade. Delete `createLog`, the four free functions, `ChannelWriter`, `LogUtilsOptions`,
`Log`, and the namespace-indirection in `createLog` that exists only so `vi.spyOn` can patch it.

- **Extension** — `window.createOutputChannel(name, { log: true })`. The resulting
  `LogOutputChannel` supplies levels, timestamps, a user-facing level picker, and
  `onDidChangeLogLevel` (engine is `^1.125.0`). Our formatter, `LEVEL_TAG`, and the `date-fns`
  timestamp all go.
- **Desktop** — `Logger.toFile(Logger.formatJson, path, { batchWindow })`. Scoped, batched,
  flushed on scope close. The file becomes NDJSON and the renderer parses JSON, deleting
  `LOG_LINE_PATTERN` and the multi-line continuation heuristic. `toFile` does not rotate, so
  the existing rotate-on-startup stays (about ten lines).
- **CLI** — `Logger.formatJson` onto the existing stdout FIFO lane. The lane's backpressure and
  EPIPE handling are load-bearing and stay; `createCliLogger`, `LogSink`, `LogRecord`,
  `LogFields`, and `StderrTextSink` do not.

Level filtering moves to `References.MinimumLogLevel`, so a suppressed debug line never builds
its message. `isDebugModeEnabled()` and its per-line `getConfigBeforePlatformInit` read — a
documented pre-initialization exception currently serving as the steady-state path — are deleted.
The `texra.logger.debugMode` setting survives for its other two consumers (the transcript
recorder's verbose flag and webview debug-mode delivery); the logger stops reading it.

### 3.3 Secrets: `Redacted` at the boundary, not a scanner at the sink

`Formatter.format` redacts any value implementing the `Redactable` protocol
(`Formatter.ts:146`), and `Logger.formatJson` is `map(formatStructured, Formatter.formatJson)`.
Redaction is therefore a property of the value, applied by Effect's formatter. `Headers` from
`effect/unstable/http` already implements it, keyed off `CurrentRedactedNames`, which defaults to
`authorization`, `cookie`, `set-cookie`, `x-api-key` (`Headers.ts:753`).

Neither `Redacted` nor `Redactable` is used anywhere in this repository today.

The move: hold provider keys as `Redacted<string>` from the config and secret-store boundary
outward. They then cannot be logged by construction, and `redaction.ts` drops from mechanism to
defence-in-depth net. The wrapper machinery — `createRedactingSink`, the `redactingSinks`
`WeakMap`, and the mutable `outputSinksTrusted` flag — is deleted either way; the "trusted
terminal" opt-out becomes a layer choice.

Honest limit: `packages/llm` uses vendor SDKs (`openai`, `@anthropic-ai/sdk`) with `Sse` from
`effect/unstable/encoding`, so its request headers are not Effect `Headers`. The `Redacted<string>`
half lands now; automatic header redaction follows only if transport moves to `HttpClient`.

### 3.4 Transcript: a queue with one consumer, not a listener set

`TraceEmitter` fans out synchronously to a `createListenerSet` registry. Examine what the three
production subscribers do with that callback:

| Subscriber                                  | Callback body                                                       | Fate                            |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| `SessionHandle.ts:541`                      | `schedulePublication` → `runPromise(publicationGate.withPermit(…))` | re-enters Effect asynchronously |
| `packages/agent/src/effect/sessions.ts:403` | `Queue.offerUnsafe(trace, event)` + a hand-rolled buffer cap        | already a queue adapter         |
| `channelTrace.ts:70`                        | writes to a log sink                                                | deleted by §3.2                 |

**No production subscriber consumes an event synchronously.** Two immediately convert the push
back into Effect; the third is deleted by the logging work. Synchronous callback delivery is a
trampoline, not a requirement.

Worse, each subscriber has rebuilt the hub feature it was denied:

- `SessionHandle` pairs `Semaphore.withPermit` with a `Set` of in-flight promises and a
  `settlePublications()` drain — a queue with one consumer fiber, plus `FiberSet`. Its
  `runPromise` is registered debt (`Effect.run*` row, `src/agent/runtime/SessionHandle.ts: 3`,
  lane "Phase 3 — run lifecycle and cancellation"), and the trampoline is one of its causes.
- The SDK subscriber implements a bounded buffer with a drop-and-detach policy — precisely the
  delivery strategy a hub provides, written by hand at the consumer.
- `TraceEmitter.emit` wraps each subscriber in try/catch so one bad sink cannot break a run —
  fiber isolation.

Ordering improves rather than degrades: `publicationGate` exists to keep status facts in
transcript order, but only serializes _after_ `runPromise` has forked. A single-consumer queue
gives that ordering by construction.

> **Landed 2026-09-13 (one-door publisher).** The queue exists, and it carries more than the
> trace: `SessionEvents` is one inbox drained by one fiber, and _every_ writer of the log is a
> job on it — the trace subscriber (`detach`, enqueued synchronously at emit time), the run
> loop's `RunLedger.appendBatch` (`publish`, awaited), and the surfaces' read-then-append
> decisions (`exclusive`). A queue that carried only the trace would have left the ledger
> racing the drain fiber exactly as it raced the gate (the 2026-09-12 inversion: a tool card's
> terminal row committed before its start row in 24 of 89 cards of one session).
> `publicationGate`, the promise `Set`, `schedulePublication` and its `runPromise` are gone
> from `SessionHandle`; step 4 below now owns only the `TraceEmitter` listener set and the
> SDK's buffer cap.

One real constraint, on the producer side: `emit()` stamps `stageId` from the ambient scope and
must do so on the emitting fiber. Stamp, then enqueue — a queue preserves this completely.

### 3.5 Errors: `ErrorReporter`, not process handlers and silent catches

Effect 4 ships `ErrorReporter` (`make`, `layer`, `report(cause)`) with `severity`, `attributes`,
and `ignore` markers, fed by `Effect.withErrorReporting` boundaries. It is unused here; the repo
hand-rolls process-level handlers instead (`extension.ts:239`,
`packages/desktop/src/main/fatalStartupError.ts:34,83`). Those stay for non-Effect throws, but
Effect defects should reach a reporter rather than be discovered by a process hook.

The larger use is the repository's own **"silent degradation is a defect"** guardrail: a
swallowed failure becomes a reported `Cause` carrying severity and attributes, rather than a
`log.warn` nobody reads. This also gives the `catch:effect-importer` ratchet row (11 catches
across 8 files) a destination instead of only a cap.

### 3.6 Spans, and the plane we do not have

`DiagnosticSpan` subclasses `Tracer.NativeSpan` to bound attributes and drop payloads. That
policy is a real product decision and is kept — but as an attribute filter, not a span subclass.
Export becomes a layer choice: `effect/unstable/observability` ships `OtlpTracer`, `OtlpLogger`,
`OtlpMetrics`, and `PrometheusMetrics`, each with `layer` and `layerFromConfig`. None is
installed by default.

`Metric` (`counter`, `gauge`, `histogram`, `summary`, `timer`, `frequency`) is the one plane
TeXRA lacks: token and cost accounting rides the transcript as `UpdateStreamUsagePayload`, which
is correct for what the user sees but leaves no operator aggregate. **Deferred** — adding a
metrics plane without a named consumer would be speculative generality.

## 4. Demolition order

Each step is deleted by a subsystem conversion that already exists in the 1.0 plan. Nothing here
is a standalone logger migration, and no step introduces a bridge between old and new.

1. **Host loggers.** Add the three `Logger`s and reshape the host port: `setOutputChannelFactory`
   (an `appendLine(string)` factory) becomes `setLogSink` (a structured entry sink), and
   `effectDiagnostics`' logger half maps `Logger.formatStructured` straight onto it (the
   `DiagnosticSpan` tracer stays). The port is **reshaped, not deleted** — 501 imperative call
   sites still need a destination until step 5 — and that reshape is exactly what fixes #12134:
   severity stops being flattened into message text. **Zero call-site churn.**
2. **`Redacted` at the secret boundary.** Independent of the logger; the only step here that
   removes a compensating subsystem outright instead of relocating one. Makes every later plane
   safe by construction.

   As landed: `resolveApiKey` seals each key with `Redacted.make(raw, { label: provider })`, so
   the TTL cache and every caller hold a value that renders `<redacted:openai>` in a log, a
   trace, or `JSON.stringify`. Three callers wanted only existence and now ask
   `hasUsableApiKey`; the retry controller compares sealed values with `Equal` instead of
   holding raw keys in a map across awaits. Exactly three sites unwrap, each handing the
   credential to a foreign runtime — a provider SDK, a subprocess environment, a usage client —
   through one named `exposeApiKey`, which keeps them greppable.

   Two constraints worth recording for later steps. First, `exposeApiKey` is named rather than
   inlined because importing `effect` into a file obliges it to convert its raw catches in the
   same pass (`catch:effect-importer`); a helper exported from the sealing module lets a caller
   pass a credential onward without taking on that obligation. Second, this stops at
   `packages/llm`, whose `ModelConfigurationSchema` types `apiKey` as a Zod `string`: sealing
   the provider leg is a schema change belonging to the provider work, not to this step.

3. **Drop the per-run diagnostic channel.** This step's description above was wrong and is
   corrected here: `channelTrace.ts` does not delete, because `createChannelTrace` has seven
   production callers — it is how module-level code outside a run logs through an `AgentTrace`
   shape. What deletes is the _run_ half.

   A run's log events already reach the durable transcript: `runEventDraft`'s default arm
   publishes them as session facts, which all three hosts render. The second copy went to a VS
   Code output channel named by an opaque stream id, created and disposed once per execution.
   Removing it takes the whole run-scoped lifecycle with it — the `scope` annotation,
   `isRunScoped`, `disposeRunChannel`, the sink's `disposeRun`, the VS Code sink's channel map
   (now one channel), the stale-detach guard, and `createRunTrace`'s setup/teardown error
   aggregation, which existed only to unwind that attachment. `attachChannelSubscriber` survives
   with one caller and no lifecycle, for a trace with no session behind it: a model handler's
   default emitter before a run swaps in the real trace. Net −184 lines.

   A follow-on pass collapsed what the removal exposed. `createChannelWriter` and its
   `ChannelWriter` type had no consumer outside `channelTrace.ts`, and duplicated in a
   level-first shape what `createLog` already provides — both adapters now bind one `Log` and
   share a single `forward` that drops internal-only facts, instead of building that filter
   twice. `formatLogData` sat on the host port with one caller and no host using it, so it
   moved into the module that renders the payload. And `SessionHandle.attachRunTrace` took
   `Pick<RunTrace, 'trace'>` — a container passed to read one field, which two test call sites
   were building `{ trace }` wrappers to satisfy; it takes the `AgentTrace` now.

4. **Trace hub, after model-handler retirement.** That retirement deletes
   `ModelHandler.ts:279`, leaving one construction site and two consumers that both already want
   a queue. `createListenerSet` and the SDK's buffer cap collapse together; the publication
   half (`publicationGate`, the promise `Set`) is already gone (§3.4, landed 2026-09-13), so the
   hub feeds `SessionEvents.detach` and adds no ordering of its own.
5. **`logUtils.ts` dies last**, with the final Promise-based subsystem — not first.

Steps 1–3 are available now. Step 4 is gated on work already scheduled, and should be sized when
the seam is two files wide rather than now.

## 5. Corrections to existing notes

- **[`2026-09-08-effect-4-interface-findings.md`](2026-09-08-effect-4-interface-findings.md) §3
  should be re-scoped.** Its API findings are correct and verified: there is no synchronous
  `PubSub` constructor carrying a delivery strategy, and `makeAtomicUnbounded` yields a poll-queue
  rather than a callback registry. Its _conclusion_ does not follow. The section preserves
  synchronous callback delivery, which §3.4 shows no production consumer uses; it sizes the seam
  at "26 files, 16 subscribe", which counts tests against a production surface of **3 subscribe
  sites and 2 construction sites**; and it treats the `ModelHandler.ts` constructor as the
  blocking constraint, when that file is a 1.0 retirement target with its own ratchet row. The
  cost was computed against a tree 1.0 deletes.
- **CLAUDE.md contradicts AGENTS.md on `p-queue`.** CLAUDE.md's design guardrails still direct
  callers to "serialize async work with `p-queue`"; AGENTS.md's accepted 1.0 direction forbids
  introducing `p-queue` orchestration. CLAUDE.md is read first and is stale. The native
  replacement for the per-key case is `PartitionedSemaphore`, whose `makeUnsafe` is synchronous —
  so it needs no `Effect.run*` and is ratchet-legal below the boundary, unlike the `PubSub` case.
- **PR #12134** should be closed in favour of step 1 rather than merged and later reverted.

## 6. Adjacent supersessions, with evidence

The migration ratchet already registers six superseded packages, totalling 28 imports: `p-queue`
(13), `p-defer` (7), `p-map` (3), `p-retry` (3), `p-timeout` (1), `async-mutex` (1). The
following are _not_ registered and have verified replacements:

| Dependency                                                 | Files | Native replacement                                                    | Caveat                                                                            |
| ---------------------------------------------------------- | ----- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `lru-cache`                                                | 11    | `Cache` (`capacity`, `timeToLive(exit, key)`), `ScopedCache`          | 3 sites are webview frontends with no runtime                                     |
| `safe-stable-stringify`                                    | 6     | `Formatter.format` — **the 2 logger sites only**                      | the other 4 need stable key order for hashing, which `Formatter` does not promise |
| `date-fns`                                                 | 2     | logger site deleted; `intlFormatDistance` → `Intl.RelativeTimeFormat` | removes `date-fns` from the root entirely                                         |
| `serialize-error` (+ `@utils/core serializeError`, 5 uses) | 1     | `Cause`, `Inspectable`                                                |                                                                                   |
| `pretty-ms`                                                | 2     | `Duration.format`                                                     |                                                                                   |
| `perfect-debounce`                                         | 1     | `Stream.debounce`                                                     |                                                                                   |
| `@date-fns/tz` (`TZDate`)                                  | 1     | `DateTime` zoned                                                      |                                                                                   |
| `ky` / `undici`                                            | 9 / 2 | `HttpClient`                                                          | also what makes §3.3 header redaction real                                        |

These are recorded as evidence, not scheduled here. Each belongs to the subsystem that owns its
call sites, per the 1.0 rule that a wrapper count is not evidence of changed execution.

## 7. Non-goals

- **No log persistence.** Assessed and rejected in
  [`2026-05-17-logger-simplification-feasibility.md`](../../rejected/simplification/2026-05-17-logger-simplification-feasibility.md)
  (JSONL deferred, append-only never). Nothing has changed.
- **No merge of the transcript and diagnostics planes.** §2.
- **No metrics plane** until a consumer is named. §3.6.
- **No `nanoid` replacement.** `Crypto` is a service for cryptographic primitives, not an id
  generator.
- **`AppSignals` is flagged, not scheduled.** All six subscribers live in host packages, so a
  native version would be legal — but it is seven signals, and the file's present value is its
  per-signal record of which host consumes what.

## 8. Verification

Behaviour to prove, at the durable boundary rather than per call site: a `warn` from core reaches
each host's log surface at `warn`; a `Redacted` key cannot appear in any sink; a run's events
reach the transcript in emission order across a queue; and a trace subscriber that throws does
not interrupt its run. Per the 1.0 test direction these are `it.effect` programs with scoped test
layers, capturing logs through a test `Logger` layer — which also retires the namespace
indirection in `createLog` that exists solely to make `vi.spyOn` work.
