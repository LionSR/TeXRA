# PR 1 of the runtime lane: the run ledger vocabulary, `RunLedger`, and `foldRunState` (2026-09-08)

Status: this is a **proposal, adversarially reviewed once**, not a ratified
plan. It specifies PR 1 of lane D of the runtime cutover
([the agent runtime on Effect](./2026-09-04-agent-runtime-on-effect.md), §5
PR plan), stacked on `cutover/native-runtime-llm-20260907`. The review found
real defects and this document carries their corrections rather than the
original text: five of the six §0.1 boundary values came back **partial**,
and the one that came back clean (`RemoteOperationSchema`, usable verbatim
inside a runtime envelope) is clean only because PR 1 carries the attempt and
the deadline itself. The `packages/llm` edits L1-L6 below are a **precondition,
not a first commit**: PR 1 makes that package a compile-time dependency of
`src/shared`, and therefore of the CLI, the desktop app and every webview
bundle, so PR 1 cannot merge to `main` before the package does. Two of the
eight rows are **not frozen** by this document and are flagged as such:
`flow.snapshot`, whose payload as first specified cannot hold what the
reflection family persists, and `model.compaction`, whose `keepPrefix` can
produce a history the LLM package refuses at prepare time.

Companion to [the delivery plan](./2026-09-06-effect-runtime-delivery-plan.md)
and [the substrate decision](./2026-09-03-persistence-substrate-decision.md).
It supersedes §2.1's payload sketches where they conflict; every deviation is
argued at its schema and repeated in §8. Paths under `packages/llm/` are on the
cutover branch only and are cited as plain text, since that directory does not
exist on `main`; every other citation is a link into this tree and was opened
before it was written down.

---

## 1. Preconditions

### 1.1 Ordering: the package merges first

The first blocker is not L1-L6. It is that `packages/llm` exists only on the
cutover branch, that PR 1 makes it a compile-time dependency of `src/shared`,
and that PR 1 simultaneously rewrites five of its schemas and four of its
provider codecs. Those three facts fix the merge order, and the original spec
never stated it:

1. `packages/llm` merges, with L1-L6 in it, reviewed as package work.
2. Then PR 1 merges: `src/shared` gains the import, the eight rows, the ledger
   service and the fold.

The dependency is not incidental. `src/shared/schemas/runLedgerEvent.ts`
imports `MessageSchema` and `TurnResultSchema` from the package, and
`src/shared/schemas` is imported by the extension webview frontends, by
`packages/desktop`, and by `packages/cli`. Every one of those bundles gains
`turn.ts` (51 KB of source) the day PR 1 lands. The marginal cost is bounded
because `turn.ts` imports only `Data` as a value plus `type Effect` and
`type Stream`, and no provider SDK, and because
[`sessionEvent.ts`](../../../../src/shared/schemas/sessionEvent.ts) already
puts `effect` in those bundles. But it is a real widening of the browser-side
dependency graph, and it belongs in PR 1's description.

**Correcting the review on one point.** The review asserted that
`packages/llm` has zero test files. That is wrong, and the correction matters
because it changes how much of the L-series risk is uncovered. The package is
tested; its tests live in the repo's centralized `src/test-kernel/` tree per
the repo's own convention, not beside the package:

| Suite                                              | Lines     |
| -------------------------------------------------- | --------- |
| `src/test-kernel/llm/OpenaiChat.vitest.ts`         | 3,449     |
| `src/test-kernel/llm/OpenaiResponses.vitest.ts`    | 2,463     |
| `src/test-kernel/llm/GoogleInteractions.vitest.ts` | 1,610     |
| `src/test-kernel/llm/AnthropicMessages.vitest.ts`  | 1,177     |
| `src/test-kernel/llm/OpenrouterChat.vitest.ts`     | 878       |
| **total**                                          | **9,577** |

Four of the five codecs L3 and L4 touch have a dedicated suite. That does not
make the L-series free, but it does mean the codec edits land against existing
coverage rather than into a vacuum, and it means the honest framing of the risk
is "a behavior change to a tested package that has not yet been reviewed on
`main`", not "an untested package".

### 1.2 The `packages/llm` edits

`turn.ts` line numbers are on the cutover branch at the time of writing.

| #      | Edit                                                                                                                                                                                                                                                                                                                                                                                                                                 | Why it cannot wait                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1** | `export` `ContentSchema` (turn.ts:341), `AssistantMessageSchema` (442), `MessageSchema` (461), `PreparedHistorySchema` (489); add `assistantMessageFromResult(result: TurnResult): AssistantMessage`.                                                                                                                                                                                                                                | The `model.message` row cannot be authored on the canonical value without them. Importing a non-export is impossible, re-declaring in `src/shared` is a dual system, and `z.custom<ProviderMessage[]>` is what §0.1 forbids by name. **`PreparedHistorySchema` must have a caller in PR 1** (§4.5), or L1 exports a symbol nothing uses.                                                                                                                                                                                                                                   |
| **L2** | Drop the `connection` member from `ResponsesContinuationSchema.anchor` (turn.ts:570-585, arm at 577-578). The websocket's eligible-response identity stays on the live transport, where openaiResponses.ts:2099/2287/2411 already tracks it as `eligibleResponseId`; delete the production site and the reuse gate at openaiResponses.ts:1081-1088.                                                                                  | The gate returns `ModelError kind: 'unsupported'` for the whole turn when a connection anchor does not match the live `transport.connectionId`. A process-local `randomUUID()` never matches after restart, so persisting the anchor makes a known-dead union member part of a permanent row API.                                                                                                                                                                                                                                                                          |
| **L3** | `LocalCallPartSchema` (turn.ts:255-259): retain the observed argument text at every decode site and re-encode from it, rather than `JSON.stringify`-ing the parsed object.                                                                                                                                                                                                                                                           | `JSON.parse` then `JSON.stringify` is not byte-exact: it truncates integers past 2^53, normalizes `1.0` to `1`, collapses duplicate keys and reorders integer-like keys. The loss happens inside the codec, before any row is written, and no row design repairs it. **See the open problem in §8.4: the two-field form the original spec proposed is itself a dual representation.**                                                                                                                                                                                      |
| **L4** | `finishEvidence` on `HttpTurnResultSchema` (turn.ts:1220 onward): add `google-interactions` and `openai-responses` arms populated from the wire, rather than synthesizing `finishReason` from whether any call ids were seen.                                                                                                                                                                                                        | Synthesizing records a Google turn truncated at max output tokens as a clean `stop`, permanently, and defeats reflection's response-continuation policy, which §0.1 assigns to the reflection program.                                                                                                                                                                                                                                                                                                                                                                     |
| **L5** | `LocalCallPartSchema.providerCallId` (turn.ts:257): drop `.nullable()`. **Companion edit required in the same commit:** `EditorContentSchema` at turn.ts:342-355 reads `providerCallId: LocalCallPartSchema.shape.providerCallId.unwrap()` at **turn.ts:350**. `.unwrap()` is defined on the optional/nullable wrapper L5 removes, so L5 alone does not compile. The editor arm becomes a plain reuse of the now-non-nullable field. | The durable settlement key. No producer emits null today and all three lowering paths hard-fail on one, so the nullability buys nothing and costs the primary key.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **L6** | Discriminate `TurnResultSchema` (turn.ts:1351-1354). It is today a plain `z.union([HttpTurnResultSchema, EditorTurnResultSchema])`.                                                                                                                                                                                                                                                                                                  | **Promoted from "deferred" to required by the review.** The editor arm (turn.ts:1335-1349) has _no_ `continuation` property and `finishReason: z.null()` (:1342), and its `content` is `EditorContentSchema` (:1344), not `ContentSchema`. So §4's fold rule "`continuation` from `turn.continuation ?? null`" is a property access on a union member that lacks it, and `p.turn.content.filter(...)` in the `model.message` refinement is a call on `readonly OutputPart[] \| readonly EditorPart[]`, which TypeScript refuses. The rows in §2 do not compile without L6. |

Also in the same commit, unrelated hygiene: delete the stray
`if (deadline) console.log('JOINDEBUG', cause, exit);` at
googleInteractions.ts:353.

**Deliberately deferred, all additive to a discriminated union so old rows keep
parsing:** a media arm on `OutputPartSchema`; a provider-hosted-output arm;
`strictObject` on the provider wire envelopes. PR 1's description must name
which arms are still to come, so the row set is frozen knowingly.

### 1.3 Build plumbing

`src/shared` must be able to import the package. Add to root `tsconfig.json`
paths:

```jsonc
"@llm/*": ["./packages/llm/src/*"],
```

Every package tsconfig extends the root and inherits its `paths`, and the
bundlers read the root map through `scripts/aliasUtils.mjs`, so
this one entry propagates. **Do not** add `@texra-ai/llm` as a root dependency:
its `exports` map points at raw `.ts` (`"./turn": "./src/turn.ts"`), and there
is no precedent in this repo for `src/` resolving `.ts` out of `node_modules`
across esbuild, four Vite configs and vitest.

### 1.4 Schema relocation

`src/shared` may not import `@agent/*`:
[`dependencyDirection.vitest.ts:70`](../../../../src/test-kernel/architecture/dependencyDirection.vitest.ts)
keeps `SHARED_AGENT_IMPORT_ALLOWLIST` empty and asserts the offender list is
`[]`. The `flow.snapshot` payload needs the families' non-message state, so
these declarations move into a new `src/shared/schemas/runState.ts`,
behavior-identical, with the agent modules importing back (agent to shared is
the allowed direction). **No re-export shims.**

| Symbol                                                             | From                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `AgentRunStateSnapshotSchema`                                      | [`AgentState.ts:23-27`](../../../../src/agent/core/state/AgentState.ts)                                                    |
| `RunUsageAccumulatorJSONSchema`                                    | [`RunUsageAccumulator.ts:44-47`](../../../../src/agent/core/usage/RunUsageAccumulator.ts)                                  |
| `NormalizedUsageSchema`                                            | `src/agent/types/NormalizedUsage.ts` (the _type_ has 47 consumers; keep the alias exported from `runState.ts` and repoint) |
| `AgentWorkspaceStateSnapshotSchema` and its module-private members | [`AgentWorkspaceState.ts:296`](../../../../src/agent/core/state/AgentWorkspaceState.ts)                                    |
| `UserVariableChannelsSchema`                                       | [`AgentCycleOptions.ts:199`](../../../../src/agent/core/definition/AgentCycleOptions.ts)                                   |
| `ModelHandlerCompatibilityKeySchema`                               | [`modelHandlerCompatibilityKey.ts:23`](../../../../src/agent/runtime/modelHandlerCompatibilityKey.ts)                      |
| `StateSlicesSchema`                                                | [`nodes/types.ts:26-30`](../../../../src/agent/implementations/flows/tooluse/nodes/types.ts), currently module-private     |

`ConversationRoundStateSnapshotSchema` is **not** moved: it is a per-attempt
metrics accumulator minted fresh in `ResponseCycleNode` and is not in any
snapshot.

### 1.5 Verified substrate facts the implementation depends on

- **`durable(type, shape, kind)`
  ([sessionEvent.ts:174-189](../../../../src/shared/schemas/sessionEvent.ts))
  builds a plain `z.object` from the spread shape.** Spreading `.shape`
  silently drops both `strictObject` strictness and every
  `.refine`/`.superRefine`. Verified in zod 4.4.3. **Every new arm therefore
  nests its payload under one key** (`durable('flow.step', { payload:
FlowStepPayloadSchema })`), matching `approval.requested`, `updateTodos` and
  `goalStateChanged`. This is not stylistic: it is the only way the rows'
  cross-field invariants exist at the one boundary where persisted data is
  validated.
- The stored `type` column already carries a `.1` suffix written by `INSERT`
  and stripped by `decodeEvent`. Row versioning is handled by the substrate;
  the arms must **not** invent a `.1` suffix in their literals.
- `LISTING_TYPES`
  ([Database.ts:138](../../../../src/controllers/session/Database.ts)) is
  derived by filtering `SessionEventDraftSchema.options` through
  `listingTypeOf`, so putting the new types in its `return null` branch keeps
  them out of the cold listing with no SQL change and no migration.
- `applyOwnArm`
  ([sessionFold.ts:1340](../../../../src/shared/session/sessionFold.ts)) has no
  `default:` and returns `StreamView`; under `"strict": true` a new arm is a
  compile error. `foldDurable` (:1603) returns at `listingTypeOf(event) ===
null` (:1616) _before_ `applyOwnArm`, so the new cases are unreachable no-ops
  in PR 1, but they must exist.
- `projectCliSessionEvent`
  ([sessionProgressSubscription.ts:211](../../../../packages/cli/src/runtime/sessionProgressSubscription.ts))
  ends in `assertNever`. It is the only other exhaustive site over a session
  event in the repo, and the second mandatory edit outside the new files.
- `redactTraceDraft`
  ([traceRedaction.ts:10](../../../../src/shared/session/traceRedaction.ts))
  ends in `default: return event` (:82-83), so ledger rows pass through
  unscrubbed. That is C3's second owner, held today only by a `default:` arm,
  and PR 1's test pins it.
- `databaseLayer('ephemeral')`
  ([Database.ts:219](../../../../src/controllers/session/Database.ts), `:memory:`
  at :234) opens SQLite in memory. **There is no need for a hand-written
  in-memory `SessionEvents`.**
- New leaf modules must be added to `src/shared/schemas/index.ts`; consumers
  import through `@shared/schemas`. The `shared-schemas-deep-import` ratchet
  fails on any new `@shared/schemas/<leaf>` specifier. Relative intra-directory
  imports (`./runState`) are unaffected.
- `logId` is `undefined` for fast tools
  ([ToolUseDispatchNode.ts:68-69, 223, 349](../../../../src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts)).
  It is nullable on the row, not required.

### 1.6 What the substrate does not give you, and PR 1 must say so

These three were raised by both judges against every design in the panel. None
is fixable inside PR 1; all three must be in its description, and two of them
change what the rows can honestly claim.

1. **A returned commit is not an fsync boundary.**
   [`Database.ts:950`](../../../../src/controllers/session/Database.ts) sets
   `PRAGMA synchronous = NORMAL`, and the surrounding `configure()` justifies
   it only against `kill -9`. Under WAL, `NORMAL` does not fsync the WAL on
   commit, so an OS crash or power loss can lose recently committed
   transactions, including the `model.message response` row that is supposed
   to make a paid response survivable, and including the `model.message
attempt` row that is supposed to make an in-flight generation attributable.
   PR 1 states the durability level it actually gets. Whether the run
   aggregate deserves `synchronous = FULL` is open decision 10.
2. **`SessionEvents.publish` is `Effect.orDie`.**
   [`SessionEvents.ts:99-102`](../../../../src/agent/runtime/SessionEvents.ts)
   is `log.appendAll(events).pipe(Effect.orDie)`. Write failures, including
   the single-owner refusal enforced inside `NEXT_SEQ`'s `WHERE
event_sequence.owner_id = excluded.owner_id AND closed = 0`, reach the
   runtime as **defects, not typed failures**. Every refusal arm in §3 that
   depends on a _write_ outcome is therefore **decorative** until this changes.
   `RunLedgerRefused('not-owner')` is not one of the arms PR 1 can honestly
   claim to raise from a lost race; it is raised only by `acquire`, which is a
   read, and even there it must not be used to report a disk error (§3.1).
3. **Every large row goes through one global, uninterruptible write permit.**
   `transaction()` is a session-wide `withPermit` around an uninterruptible
   `BEGIN IMMEDIATE`. A `tool.result` carrying a multi-megabyte base64
   attachment, or a compaction carrying a whole history with media inlined,
   blocks every other stream's appends for its duration and cannot be
   interrupted by a stop. PR 1 does not fix this; PR 1's fixture comment
   records the measured serialized size of one realistic reflection snapshot
   and one tool-use snapshot, so PR 2 has a number before it turns the writes
   on.

### 1.7 Recorded, not blocking

1. **`z.url()` on `deployment.endpoint`** admits userinfo and `?api-key=`. The
   run aggregate is never scrubbed and lives until explicit user deletion.
   PR 1 adds a write-boundary assertion; the durable fix is open decision 1.
2. **Replay is hostage to a user-editable string.** `sameModelOrigin` compares
   `endpoint` and `credentialScope` byte-for-byte and a mismatch is a hard
   `unsupported`. PR 1 records the origin verbatim and surfaces a mismatch as
   an explicit decision; it cannot fix it.
3. **A run in flight at the upgrade becomes unresumable.** With the importer
   removed by the 0.41 ruling, a run whose process is alive with a
   `flow_<id>.json` checkpoint and zero ledger rows has no ledger state. Today
   `src/agent/storage/resumability.ts` still reads that checkpoint, so unless
   PR 2 deletes that path in the same release, two resumability authorities
   disagree about the same run. PR 1 owns only the wording distinction:
   "recorded before the run ledger" is not "checkpoint corrupt". §7
   records the obligation on PR 2.

---

## 2. The rows

### 2.1 Placement

| What                       | Where                                                                                                                    | Why                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The `durable(...)` arms    | [`src/shared/schemas/sessionEvent.ts`](../../../../src/shared/schemas/sessionEvent.ts), inside `SessionEventDraftSchema` | That union is the single vocabulary `SessionEvents.publish` and `Database.appendAll` accept, and the one `listingTypeOf`, `referencedAggregates`, the framers and both folds switch over. A parallel union is a second vocabulary the substrate must accept. The arms stay **unexported** (the `RunStartEventSchema` pattern). |
| The payload schemas        | `src/shared/schemas/runLedgerEvent.ts` (new)                                                                             | Mirrors how `traceEvent.ts` holds payloads for the transcript arms. Lets the fold and (PR 3) the trace viewer import payload _types_ without importing the event union.                                                                                                                                                        |
| The relocated family state | `src/shared/schemas/runState.ts` (new)                                                                                   | §1.4.                                                                                                                                                                                                                                                                                                                          |

They do **not** join `AgentEvent` in `@agent/trace`. §2.1's "all carried as
`AgentEvent` arms" is superseded by
[the delivery plan, line 194](./2026-09-06-effect-runtime-delivery-plan.md):
_"Private ledger rows stay outside the public trace union."_ Only `flow.step`
is display-visible, and it reaches the viewer through the session vocabulary.

### 2.2 The table

Every row lands on the one `run` aggregate keyed by the run id (§3.1). The
class column is the split above, and it is what decides which fold reads a row:
`foldRunState` reads all six. All six also reach `sessionFold.ts` as explicit
named cases, where in PR 1 every one of them is inert because `listingTypeOf`
returns `null`; PR 3 gives the display-visible one real handling (§4.1).

| Row                | Row class       | Written when                                                                                                                                                                                                  | Fold effect                                            | Frozen?          |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------- |
| `flow.step`        | display-visible | round begin/end; turn ready/begin/end; response ready/processed; results/output ready; `waiting`; `halted`                                                                                                    | sets coordinates and `halt`                            | yes              |
| `model.message`    | ledger-private  | five variants, below                                                                                                                                                                                          | the only row that grows provider history               | yes, after L6    |
| `model.compaction` | ledger-private  | a handler returns a history that is not a prefix extension; a reflection round opens; a mid-run model switch re-encodes                                                                                       | replaces history; sets or invalidates the continuation | **no**, see §2.5 |
| `tool.intent`      | ledger-private  | unconditionally at the barrier dispatch site, before any non-parallel-safe call starts. **Not** from an approval hook: `onExecutionReady` covers three tools while most of the fifty are barriers             | opens outcome-unknown state                            | yes              |
| `tool.result`      | ledger-private  | after each call settles, one row per call, duplicates and synthetic skips included                                                                                                                            | settles a call, applies its state ops exactly once     | yes              |
| `flow.snapshot`    | ledger-private  | once before the first external activity; at `turn.end`/`round.end`; before `waiting`; before a manual-retry prompt; before calling `observe`; whenever bytes appended since the last snapshot exceed its size | restores what no row carries; **asserts** what rows do | **no**, see §2.6 |

### 2.3 The money window, and what closes it

Both judges found the same gap in every design the panel produced: **no design
wrote a durable fact before submitting a billed request.** Every design's first
durable act was the response row, written _after_ generation completed, so a
crash during a multi-minute generation lost paid work with zero durable
evidence it happened, and resume re-invoked.

That is fixable, and this is where PR 1 spends its one non-obvious addition.
`TurnEventSchema` already emits an `identified` event carrying
`providerResponseId` and `requestedOrigin` **before** completion. So
`model.message` gains three variants ahead of `response`:

- **`attempt`**: a billed request is about to leave the process. The first
  durable act of a turn.
- **`identified`**: provider identity observed before completion. For
  `openai-responses` this is what lets a lost stream be retrieved rather than
  re-billed.
- **`accepted`**: §0.1's commit barrier: the accepted remote operation,
  committed before `observe` is called.

They are additive members of a discriminated union, so deferring them would
cost nothing later, but the commit barrier is PR 1's job to make
representable, and "no row design recovers an interrupted generation" is false
as stated once `identified` exists.

**The honest limit.** Under `synchronous = NORMAL` (§1.6.1), an OS crash can
lose the `attempt` row itself. The window is narrowed from "the whole
generation" to "the interval between the attempt row's commit and the WAL
reaching disk", not closed. PR 1 says exactly that.

### 2.4 `src/shared/schemas/runLedgerEvent.ts`

Paste-ready, minus the two unfrozen payloads, which are §2.5 and §2.6.

```ts
/**
 * Payloads for the run-ledger arms of `SessionEventDraftSchema`
 * (`2026-09-04-agent-runtime-on-effect.md` §2.1). Shapes only: the arms
 * themselves live in `sessionEvent.ts`, which is the single vocabulary the
 * publisher and both folds switch over.
 *
 * Every arm nests its payload under one key rather than spreading `.shape`
 * into `durable()`. `durable` builds a plain `z.object` (sessionEvent.ts:174),
 * and spreading a `strictObject`'s shape drops both its strictness and every
 * refinement (verified in zod 4.4.3), which would make the cross-field
 * invariants below decorative at the one boundary where persisted data is
 * validated.
 *
 * No payload references a `commit`. Response identity is a runtime-minted
 * uuid, so no persisted row ever names an ordinal the publisher has not
 * assigned, `appendBatch` needs no intra-batch reference resolution, and this
 * module needs no import from `sessionEvent.ts` (which imports it).
 */
import { z } from 'zod';

import {
  ContinuationSchema,
  MessageSchema, // L1
  ModelOriginSchema,
  RemoteOperationSchema,
  TurnResultSchema, // discriminated by L6
} from '@llm/turn';

import { PersistedRetryErrorInfoSchema } from './errors';
import { JsonValueSchema } from './jsonValue';
import { ModelHandlerCompatibilityKeySchema } from './runState';
import { RunOutcomeSchema } from './stream';
import {
  ErrorToolResultSchema, // newly exported
  ExecutedToolResultSchema, // newly exported
  ToolFileAttachmentSchema, // newly exported
} from './toolResult';

/* ------------------------------------------------------------------ ids */

export const RunFamilySchema = z.enum(['toolUse', 'reflection']);

/**
 * One completed provider turn. Runtime-minted when the response row is
 * authored: durable, stable across compaction and branching, and needing no
 * commit resolution. A commit identifies a row; this identifies a response.
 */
export const ResponseIdSchema = z.uuid();

/**
 * One model invocation and its billed attempt. `attempt` increases only for a
 * retry of the same invocation. The package carries no attempt correlation,
 * and §0.1's Ownership paragraph assigns retries to the runtime, so it lives
 * here (open decision 2).
 */
export const InvocationRefSchema = z.strictObject({
  invocationId: z.uuid(),
  attempt: z.int().positive(),
});

/** The canonical call key: `providerCallId`, non-nullable after L5. The
 *  runtime never mints one: a completed turn with a null call id is
 *  refused at the write boundary, not repaired. */
export const CallIdSchema = z.string().min(1);

/* ------------------------------------------------------------- flow.step */

export const FlowStepSchema = z.enum([
  'round.begin',
  'round.end',
  'turn.ready',
  'turn.begin',
  'turn.end',
  'response.ready',
  'response.processed',
  'results.ready',
  'output.ready',
  'waiting',
  'halted',
]);

export const FlowStepPayloadSchema = z
  .strictObject({
    family: RunFamilySchema,
    step: FlowStepSchema,
    round: z.int().nonnegative().nullish(),
    turn: z.int().nonnegative().nullish(),
    /** Reflection's within-round response-cycle index. Renamed from §2.1's
     *  `continuation`: the package's `Continuation` anchor lives in the same
     *  `RunState`, and two fields one word apart is a live foot-gun. */
    continuationIndex: z.int().nonnegative().nullish(),
    /** The loop's own terminal word. Listing status stays the canonical
     *  `status` fact, which also covers failures before the runtime starts. */
    outcome: RunOutcomeSchema.nullish(),
  })
  .refine(
    (p) => (p.step === 'halted') === (p.outcome != null),
    'Only a halted step carries an outcome, and it always carries one.',
  );

/* ---------------------------------------------------------- model.message */

/**
 * Per-call dispatch facts, stamped at append time so the fold and the resume
 * rule stay data-only and need no tool registry. One entry per local-call
 * part of the response, in content order.
 */
export const DispatchFactsSchema = z.strictObject({
  callId: CallIdSchema,
  toolName: z.string().min(1),
  ordinal: z.int().nonnegative(),
  parallelSafe: z.boolean(),
  /** Contiguous dispatch partition; each barrier is its own. */
  partition: z.int().nonnegative(),
  /** The primary this call duplicates. A duplicate never executes and never
   *  reapplies its primary's effects. */
  duplicateOf: CallIdSchema.nullable(),
  /** Card correlation, so a resumed settlement closes the same card. Null for
   *  a fast tool: `logId` is set only for slow tools
   *  (`ToolUseDispatchNode.ts:68-69, 223, 349`). */
  logId: z.string().min(1).nullable(),
  stageId: z.string().min(1).nullable(),
});

export const ModelMessagePayloadSchema = z
  .discriminatedUnion('kind', [
    /**
     * A billed request is about to leave the process (§2.3). Carries no
     * history: the history is whatever the rows below this commit say.
     */
    z.strictObject({
      kind: z.literal('attempt'),
      invocation: InvocationRefSchema,
      origin: ModelOriginSchema,
      delivery: z.enum(['stream', 'blocking', 'background']),
    }),
    /** Provider identity observed before completion. */
    z.strictObject({
      kind: z.literal('identified'),
      invocation: InvocationRefSchema,
      providerResponseId: z.string().min(1),
      returnedModel: z.string().min(1).nullable(),
    }),
    /**
     * §0.1's commit barrier: the accepted remote operation, committed before
     * `observe` is called. `deadlineAtMs` is the limit admitted with the
     * submission, never one recomputed from current settings; the package
     * produces neither it nor an attempt, so both ride the envelope.
     */
    z.strictObject({
      kind: z.literal('accepted'),
      invocation: InvocationRefSchema,
      operation: RemoteOperationSchema,
      deadlineAtMs: z.int().positive(),
    }),
    /**
     * A completed provider turn, committed once and reused after restart.
     * `turn` is `TurnResultSchema` verbatim: ordered content with its exact
     * signatures and encrypted reasoning, the complete call list, finish
     * reason and native finish evidence, observed usage, continuation.
     */
    z.strictObject({
      kind: z.literal('response'),
      responseId: ResponseIdSchema,
      invocation: InvocationRefSchema,
      turn: TurnResultSchema,
      calls: z.array(DispatchFactsSchema).readonly(),
    }),
    /**
     * Canonical messages appended to history, verbatim.
     *
     * When `sourceResponse` is set the row carries ONLY the settlement group
     * (and any accompanying user message). The assistant message is derived
     * by the fold from the pending response's own row, so the paid turn is
     * stored once on an aggregate that never rewrites and never deletes, and
     * no partial group or independently appended pending assistant enters
     * provider history.
     */
    z.strictObject({
      kind: z.literal('append'),
      messages: z.array(MessageSchema).min(1).readonly(),
      sourceResponse: ResponseIdSchema.nullable(),
    }),
  ])
  .superRefine((p, ctx) => {
    if (p.kind !== 'response') return;
    // L6 discriminates TurnResultSchema; the editor arm has no local calls.
    if (p.turn.kind !== 'http') {
      if (p.calls.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls'],
          message: 'An editor turn dispatches no local calls.',
        });
      }
      return;
    }
    const local = p.turn.content.filter((part) => part.kind === 'local-call');
    if (local.length !== p.calls.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message:
          'Every local call of the response has exactly one dispatch fact.',
      });
      return;
    }
    const ids = new Set(p.calls.map((c) => c.callId));
    // A duplicate has a primary to reuse, so it names a call that precedes it
    // and is not itself a duplicate. Membership in `ids` alone would admit a
    // call naming itself, which can never settle.
    const earlierPrimaries = new Set<string>();
    p.calls.forEach((call, index) => {
      if (
        call.ordinal !== index ||
        call.callId !== local[index]?.providerCallId
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index],
          message:
            'Dispatch facts follow the response call order and identity.',
        });
      }
      if (call.duplicateOf != null && !earlierPrimaries.has(call.duplicateOf)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'duplicateOf'],
          message:
            'A duplicate names an earlier non-duplicate call of this same response.',
        });
      }
      if (call.duplicateOf == null) earlierPrimaries.add(call.callId);
    });
    if (ids.size !== p.calls.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'Duplicate call id.',
      });
    }
  });

/* ------------------------------------------------------------ tool.intent */

export const ToolIntentPayloadSchema = z.strictObject({
  responseId: ResponseIdSchema,
  callIds: z.array(CallIdSchema).min(1).readonly(),
  /** Increases only after an explicit re-run decision. An earlier approval
   *  never authorizes another attempt implicitly. */
  attempt: z.int().positive(),
});

/* ------------------------------------------------------------ tool.result */

/** `ToolFileAttachment.bytes` is a `Uint8Array`, which JSON does not
 *  reconstruct; a path alone is not recoverable content; a capture failure
 *  records the omission and its reason rather than a claim that bytes were
 *  included. */
export const SettledAttachmentSchema = z.strictObject({
  path: z.string().min(1),
  mimeType: z.string().min(1),
  description: z.string().optional(),
  content: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('base64'), data: z.base64() }),
    z.strictObject({
      kind: z.literal('metadata-only'),
      reason: z.string().min(1),
    }),
  ]),
});

/**
 * The follow-up builder's input. Derived from the exported members, never
 * re-declared: `files` loses its binary payload and `diagnostics` is narrowed
 * from `z.unknown()` (toolResult.ts:140) to JSON, because an arbitrary value
 * in a durable payload is a `JSON.stringify` throw waiting for a cycle or a
 * BigInt.
 *
 * `SettledFileSchema` is derived from `ToolFileAttachmentSchema`
 * (toolResult.ts:23-27), NOT rebuilt as a `strictObject` over
 * `FileReferenceSchema.shape`. `FileReferenceSchema` is a `z.looseObject`
 * (toolResult.ts:9-15) and real attachments carry `base64Data`/`bytes` plus
 * whatever extra keys a tool attached, so a strict rebuild would refuse every
 * executed result that has an attachment. That same looseness is why the two
 * binary fields go through a transform rather than `.omit()`: on a loose
 * object an omitted key is only undeclared, so `base64Data` and the
 * `Uint8Array` in `bytes` would pass through as unknown keys and land in the
 * row anyway, the second expanded into a numeric-key object.
 */
const SettledFileSchema = ToolFileAttachmentSchema.transform(
  ({ base64Data: _base64Data, bytes: _bytes, ...file }) => file,
);
export const SettledToolResultSchema = z.discriminatedUnion('status', [
  ExecutedToolResultSchema.omit({ files: true }).extend({
    files: z.array(SettledFileSchema).optional(),
    diagnostics: JsonValueSchema.optional(),
  }),
  ErrorToolResultSchema.extend({ diagnostics: JsonValueSchema.optional() }),
]);

/**
 * Per-call state operations over the run's mutable slices, never a whole-state
 * copy that could overwrite a concurrent call. `add` is not optional
 * generality: `recordSubagentCost` adds raw USD into
 * `run.usageAccumulator.totals.totalCost` from inside a tool call
 * (`ToolUseDispatchNode.ts:307-311`), and an enumerated slice list cannot
 * express it. Folding a result applies its mutation exactly once.
 */
export const StateOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('set'),
    path: z.array(z.string().min(1)).min(1),
    value: JsonValueSchema,
  }),
  z.strictObject({
    op: z.literal('delete'),
    path: z.array(z.string().min(1)).min(1),
  }),
  z.strictObject({
    op: z.literal('append'),
    path: z.array(z.string().min(1)).min(1),
    items: z.array(JsonValueSchema).min(1),
  }),
  z.strictObject({
    op: z.literal('add'),
    path: z.array(z.string().min(1)).min(1),
    amount: z.number().finite(),
  }),
]);

export const ToolResultPayloadSchema = z
  .strictObject({
    responseId: ResponseIdSchema,
    callId: CallIdSchema,
    attempt: z.int().positive(),
    /**
     * The fold's key fact, and the replacement for today's practice of
     * detecting a cancelled call by matching the English prose of
     * `CANCELLED_CALL_ERROR` (`ToolUseDispatchNode.ts:49`).
     */
    disposition: z.enum([
      'executed',
      'failed',
      'cancelled',
      'skipped',
      'duplicate',
    ]),
    duplicateOf: CallIdSchema.nullable(),
    result: SettledToolResultSchema,
    attachments: z.array(SettledAttachmentSchema).readonly(),
    stateMutation: z.array(StateOperationSchema).readonly(),
  })
  .superRefine((p, ctx) => {
    if ((p.disposition === 'duplicate') !== (p.duplicateOf != null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['duplicateOf'],
        message:
          'A duplicate settlement names its primary, and only a duplicate does.',
      });
    }
    if (p.disposition === 'executed' && p.result.status !== 'executed') {
      ctx.addIssue({
        code: 'custom',
        path: ['result'],
        message: 'An executed disposition requires an executed result.',
      });
    }
    if (
      p.disposition === 'duplicate' &&
      (p.attachments.length > 0 || p.stateMutation.length > 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: "A duplicate never reapplies its primary's effects.",
      });
    }
  });

/* --------------------------------------------- flow.snapshot, partial */

export const RunPhaseSchema = z.enum([
  'initial',
  'round.ready',
  'model.ready',
  'model.submitted',
  'response.ready',
  'tools.dispatching',
  'results.ready',
  'output.pending',
  'waiting',
  'halted',
]);

export const PendingRetrySchema = z.strictObject({
  requestId: z.string().min(1),
  invocation: InvocationRefSchema,
  failedModelId: z.string().min(1),
  failedCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullable(),
  /** Route requirements without secrets: a credential scope, never a
   *  credential. */
  credentialScope: z.string().min(1),
  /**
   * No default and no `.catch`. A spent permit that reads as an unused one
   * silently buys a second billed attempt: `waiting` = a decision is
   * outstanding, `authorized` = exactly one unused permit, `started` =
   * consumed, a new decision is required.
   */
  substate: z.enum(['waiting', 'authorized', 'started']),
});

/** Reference fields the fold reconciles rather than replaces (§4.4). */
export const SnapshotReferencesSchema = z.strictObject({
  pendingIntents: z
    .array(
      z.strictObject({
        callId: CallIdSchema,
        attempt: z.int().positive(),
        responseId: ResponseIdSchema,
        approvalRequestId: z.string().min(1).nullable(),
      }),
    )
    .readonly(),
  pendingResponse: z
    .strictObject({
      responseId: ResponseIdSchema,
      settled: z.array(CallIdSchema).readonly(),
    })
    .nullable(),
});

/** Coordinates and runtime-owned failure state, which no row carries. */
export const SnapshotRuntimeSchema = z.strictObject({
  phase: RunPhaseSchema,
  round: z.int().nonnegative(),
  turn: z.int().nonnegative(),
  continuationIndex: z.int().nonnegative(),
  modelId: z.string().min(1),
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullable(),
  /**
   * Runtime-owned failure vocabulary, already persisted today and already
   * carrying the exhaustion classification that drives retry and route-switch
   * policy. Deliberately NOT derived from the package's `ModelError`
   * (open decision 3).
   */
  lastError: PersistedRetryErrorInfoSchema.nullable(),
  pendingRetry: PendingRetrySchema.nullable(),
});
```

`FlowSnapshotPayloadSchema` itself is **not written here**, for the reason in
§2.6.

### 2.5 Open problem: `model.compaction` can write a history the package refuses

The compaction payload is:

```ts
export const ModelCompactionPayloadSchema = z
  .strictObject({
    keepPrefix: z.int().nonnegative(),
    messages: z.array(MessageSchema).readonly(),
    cause: z.enum([
      'handler-replacement',
      'round-open',
      'context-limit',
      'model-switch',
    ]),
    continuation: ContinuationSchema.nullable(),
    continuationDropped: z
      .enum(['history-replaced', 'protocol-has-no-continuation'])
      .nullable(),
  })
  .refine(
    (p) => p.continuation === null || p.continuationDropped === null,
    'A replaced continuation is not also a dropped one.',
  );
```

`keepPrefix` exists so a reflection round-open does not re-store the entire
conversation, media inlined as base64, once per round, which is O(rounds x history) on
an aggregate that never deletes. It is load-bearing and it stays.

**But nothing validates the history the fold assembles.** The fold's `messages`
is a `readonly Message[]`, and every cross-message invariant lives in
`PreparedHistorySchema` (turn.ts:489-530): an assistant that emits local calls
must be followed by an _adjacent, complete, ordinal-ordered_ tool-result group,
and a tool message must be immediately preceded by a calling assistant. A
`keepPrefix` that lands between an assistant and its tool group produces a
history the package refuses at prepare time, and the ledger's write-boundary
checks, which today cover only the _delivery_ case, never see it.

This is precisely §0.1's acceptance scenario "restart between two signed tool
settlements, after compaction, or on a branch". Two ways to close it, and the
owner picks one before the row freezes (open decision 11):

- **(a) Validate at the write boundary.** `appendBatch` runs the compaction's
  resulting history through `PreparedHistorySchema` before publishing, refusing
  `RunLedgerRefused('unprepared-history')`. This also gives L1's
  `PreparedHistorySchema` export the consumer it otherwise lacks. Cost: an
  O(history) refinement on the write path of every compaction.
- **(b) Constrain `keepPrefix` structurally.** A refinement on the payload
  itself cannot see the prefix it cuts, so this requires carrying enough of the
  boundary message in the row to check adjacency, which is a second carrier
  for a fact the history already holds.

**Recommendation: (a).** It is the only one that checks the real invariant, and
it puts the check at the boundary where a refusal is still actionable.

### 2.6 Open problem: `flow.snapshot` cannot hold what reflection persists

**This is the most important thing the review found, and the original spec's
`FlowSnapshotPayloadSchema` is cut rather than shipped with a caveat.**

The spec's `SnapshotCommonSchema` was
[`ToolUseRunSharedSchema`](../../../../src/agent/implementations/flows/tooluse/nodes/types.ts)
(:48-67) promoted to "common", with a reflection extension bolted on. It is not
common.
[`ReflectionFlowStateSchema`](../../../../src/agent/implementations/flows/reflection/ReflectionFlowState.ts)
(:39-65) has **no** `stateSlices` (tool-use, :59), **no** `modelId` (:54), **no**
`systemPrompt` (:61), **no** `shouldSkipCycle` (:58), **no**
`userCancelledRetry` (:62) and **no** `structured` (:66). What it does carry is
different in kind:

| Reflection field                                       | Line     |
| ------------------------------------------------------ | -------- |
| `currentRound`, `totalRounds`                          | :40-41   |
| `workspaceSnapshot: AgentWorkspaceStateSnapshotSchema` | :43      |
| `context: RoundConversationSchema.nullable()`          | :44      |
| `outputLocation`, `roundOutputs`                       | :45, :49 |
| `runStateSnapshot: AgentRunStateSnapshotSchema`        | :47      |
| `continueRounds`, `endTurn`                            | :51-52   |
| `lastError`, `modelHandlerCompatibilityKey`            | :55, :58 |
| `compileFailureContext`, `unresolvedCompileRejection`  | :61, :64 |

`workspaceSnapshot` and `runStateSnapshot` are **top-level** on reflection,
whereas on tool-use they are nested inside `StateSlicesSchema`
(`nodes/types.ts:26-30`) alongside a `userChannels` reflection does not have. So
under the promoted schema a reflection snapshot must either set `stateSlices:
null`, discarding the workspace snapshot (file edits, media attachments,
reasoning cache, thinking blocks) and the run-state snapshot, or fabricate a
`userChannels`. And `context`, which §2.1 names in the snapshot payload
explicitly, has no field at all; the spec never said where it goes.

**The direction, not a frozen schema.** Drop the fiction of a common shape.
`FlowSnapshotPayloadSchema` becomes a `z.discriminatedUnion('family', …)` in
which each arm carries `SnapshotRuntimeSchema` and `SnapshotReferencesSchema`
(§2.4) plus **that family's own state schema, relocated verbatim by §1.4**,
minus its message-bearing fields, which rows carry. Two arms, two honest
shapes, no promotion. That is implementable today. What it does not do is
resolve §2.7, which is why the payload is not written down here.

### 2.7 Open problem: usage has three carriers, not one

§4.4 of the original claimed "exactly one carrier per fact". Usage has three:

1. **Inside the snapshot.** `StateSlicesSchema.runStateSnapshot` is
   [`AgentRunStateSnapshotSchema`](../../../../src/agent/core/state/AgentState.ts)
   (:23-27), whose `usageAccumulator` (:26) is
   [`RunUsageAccumulatorJSONSchema`](../../../../src/agent/core/usage/RunUsageAccumulator.ts)
   (:44-47). Reflection carries the same accumulator at
   `runStateSnapshot` (ReflectionFlowState.ts:47).
2. **Inside `model.message` `response`.** `TurnResultSchema`'s HTTP arm carries
   the observed `usage` verbatim, which is the whole point of storing the turn
   byte-exact.
3. **Inside `tool.result`.** `recordSubagentCost` adds raw USD into
   `run.usageAccumulator.totals.totalCost` from inside a tool call
   (`ToolUseDispatchNode.ts:307-311`), which is exactly what the `add`
   operation in `StateOperationSchema` exists to express.

And the snapshot rule for the state slices is "restore-only, replaced
wholesale", which **silently un-applies a committed `recordSubagentCost` add**
whenever a snapshot authored before that add lands after it. That is the same
hazard §4.4 congratulates itself for eliminating on reference fields, still
live on the field §0.1 names: _"Usage is attributed once per recorded
attempt/receipt, including child rollups."_
[`recordCycleMetrics`](../../../../src/agent/core/state/AgentState.ts) (:37-48)
mutating the accumulator in place is the site that makes the carriers diverge.

This is a row rewrite after the fact, not an additive fix, so it must be
settled before the first row is written. Open decision 12 states the options.
Until it is settled, `flow.snapshot` is not frozen.

### 2.8 The arms, in `sessionEvent.ts`

Added to `SessionEventDraftSchema`, unexported, payload nested:

```ts
  durable('flow.step', { payload: FlowStepPayloadSchema }),
  durable('model.message', { payload: ModelMessagePayloadSchema }),
  durable('model.compaction', { payload: ModelCompactionPayloadSchema }),
  durable('tool.intent', { payload: ToolIntentPayloadSchema }),
  durable('tool.result', { payload: ToolResultPayloadSchema }),
  durable('flow.snapshot', { payload: FlowSnapshotPayloadSchema }),
```

and to `listingTypeOf`'s `return null` group:

```ts
    case 'flow.step':
    case 'model.message':
    case 'model.compaction':
    case 'tool.intent':
    case 'tool.result':
    case 'flow.snapshot':
      return null;
```

All six take the `run` aggregate kind: one run owns one aggregate, so no arm
names a kind of its own. That kind does not exist yet. At `main`,
`AggregateKeySchema`
([sessionEvent.ts:98-110](../../../../src/shared/schemas/sessionEvent.ts)) has
no `run` arm and `durable(type, shape, kind = 'stream')` (:186-190) defaults to
`stream`, so adding `'run'` to the kind enum and moving `durable`'s default are
edits S1 of the one run model owns, and PR 1 cannot merge before S1 lands. `LISTING_TYPES`
([Database.ts:138](../../../../src/controllers/session/Database.ts)) is derived
from `listingTypeOf`, so the six stay out of the cold listing with no SQL
change, so a large snapshot never lands in every renderer's listing read.
`approval.requested` / `approval.resolved` are reused unchanged; their recovery
bindings are `flow.snapshot`'s `pendingRetry.requestId` and
`pendingIntents[].approvalRequestId`, so PR 1 adds no field to the display arm.

---

## 3. `RunLedger`

### 3.1 Tag and shape: `src/shared/session/runLedger.ts` (new)

Beside `sessionEvents.ts` and `database.ts`, which declare their tags in
`src/shared/session/` and their layers under `src/agent/runtime/` and
`src/controllers/session/`.

```ts
/**
 * The run ledger: the only reader of ledger-private payloads and the only
 * writer of the run rows. Three operations, each a boundary §2.2 or §2.3
 * names, each taking the run id and qualifying its own aggregate access with
 * `aggregateId('run', run)`.
 *
 * Stateless by construction. The loop holds the `RunState`; the ledger folds
 * the batch it just committed onto the state it was handed. That is what
 * makes `foldRunState` provably the same function on the live path and on
 * resume, and it keeps a session-root service free of per-run mutable cache.
 */
import { Context, Data, Effect } from 'effect';

import type { RunId } from '@shared/schemas';
import type { DatabaseReadFailed } from './database';
import type { RunLedgerDraft, RunState } from './runStateFold';
import { RunLedgerInconsistent } from './runStateFold';

/**
 * A refusal the ledger itself decided. Read failures are NOT folded into
 * this type: reporting a disk error as a stolen claim is the silent-
 * degradation defect in a different costume, so `acquire` and `load` keep
 * `DatabaseReadFailed` in their error channel beside it.
 *
 * Write failures are absent for a harder reason: `SessionEvents.publish` is
 * `Effect.orDie` (SessionEvents.ts:99-102), so a lost single-owner race
 * arrives as a defect and never reaches this union. `'not-owner'` is
 * therefore raised only by `acquire`, which is a read. See open decision 6.
 */
export class RunLedgerRefused extends Data.TaggedError('RunLedgerRefused')<{
  readonly reason:
    | 'not-owner' // the claim moved, or was never held
    | 'unpersistable-continuation' // a process-local anchor reached the write boundary
    | 'unsafe-endpoint' // a credential-bearing endpoint reached a durable origin
    | 'null-call-id' // a completed turn whose call has no identity
    | 'unprepared-history' // §2.5, if option (a) is taken
    | 'batch-contract' // a precondition of `appendBatch` was violated
    | 'inconsistent'; // the rows do not fold (see `cause`)
  readonly runId: RunId;
  readonly detail: string;
  readonly cause?: RunLedgerInconsistent;
}> {}

export class RunLedger extends Context.Service<
  RunLedger,
  {
    /**
     * The claim gate, called before any resume side effect: resume acquires
     * the run aggregate's current claim first, then calls `load`. Without it
     * a second process can fold a run's state, re-dispatch a barrier tool,
     * and learn only at its first append that the claim never moved, after
     * the side effect.
     */
    readonly acquire: (
      run: RunId,
    ) => Effect.Effect<void, RunLedgerRefused | DatabaseReadFailed>;

    /**
     * Fold a run's rows into its state. `null` only when the run aggregate
     * carries no ledger row: that is the loop's fresh-run branch and, for a
     * pre-0.41 run, the honest "recorded before the run ledger" answer,
     * distinct from "checkpoint corrupt". Ledger rows without an initial
     * `flow.snapshot` are not that case. They are a malformed aggregate and
     * fail `inconsistent`, because folding an `attempt` or a `response` into
     * a fresh run is how a paid invocation gets issued twice. PR 1 reads the
     * run aggregate in full; the snapshot-anchored read is PR 2's
     * optimization, and `foldRunState`'s `state` parameter is what makes it a
     * drop-in rather than a second fold.
     */
    readonly load: (
      run: RunId,
    ) => Effect.Effect<RunState | null, RunLedgerRefused | DatabaseReadFailed>;

    /**
     * Commit one ordered batch in one transaction, and return the state the
     * loop continues from: `state` folded with the rows the publisher
     * actually committed. Failure of any member commits none.
     *
     * Preconditions, checked before publish and failing `batch-contract`:
     *   - a `flow.snapshot` is the last ledger row of its batch, except
     *     when a `flow.step` follows it in the same transaction;
     *   - a `model.compaction` immediately precedes the `model.message`
     *     `response` row that used it, when both are present;
     *   - a `model.message` `append` naming `sourceResponse` requires that
     *     response to be the current pending response, and its first message
     *     to be a tool group carrying, at the `callOrdinal` of each of that
     *     response's dispatch facts, the committed settlement for that
     *     `callId`. This is the settlement-to-provider join: the canonical
     *     tool message binds results to calls positionally, the ledger keys
     *     them by `callId`, and this is where the two are checked against
     *     each other. A count alone would admit a delivery whose settlements
     *     never committed, and the delivery is what clears them.
     */
    readonly appendBatch: (
      run: RunId,
      state: RunState | null,
      rows: readonly RunLedgerDraft[],
    ) => Effect.Effect<RunState, RunLedgerRefused | DatabaseReadFailed>;
  }
>()('@texra/session/RunLedger') {}
```

`RunLedgerDraft` is defined in `runStateFold.ts` as the discriminated union of
the six ledger arms plus the named display arms a batch has to commit atomically
with them: `tool.end`, which settles with its `tool.result`, and
`approval.requested` / `approval.resolved`, whose recovery binding is the
snapshot committed in the same batch. Publishing those companions separately
is the crash window where a settled tool keeps an active card, or an approval
survives with nothing to recover it by. The union is still that explicit list
narrowed from `SessionEventDraft`, not `SessionEventDraft` itself, or
`appendBatch` would accept a `tool.start`. The original spec used the name
without ever defining it.

**Deliberately absent.** No `append` (a one-row case is a one-element batch; a
second entry point is the dual system). No `messages()` (the folded state holds
them). No `snapshot()` helper (a snapshot is a row like any other; row
constructors are plain functions the loop calls). No subscribe surface. No
`rowsThrough` (PR 3 adds it for the viewer) and no `resumability` (PR 2 adds it
when it deletes `deriveResumability`).

**No `RunStateSchema` is exported anywhere.** C10 forbids the projection, and
the absence of a schema is a stronger guarantee than a comment.

### 3.2 What the loop does with a refusal

This is the first thing a reviewer will ask, and a foundation PR that writes
nothing is where the answer gets frozen. PR 1 introduces refusals over data
today's tools produce freely: non-JSON `diagnostics` (`z.unknown()` by
deliberate design at
[toolResult.ts:140](../../../../src/shared/schemas/toolResult.ts)), loose file
keys, a user-typed base URL with a query string. CLAUDE.md forecloses the quiet
option, so the rule is stated once, here:

| Refusal                                                         | Loop behavior                                                                                                                                                                            |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unsafe-endpoint`, `unpersistable-continuation`, `null-call-id` | **Halt the run** with the refusal as the failure cause. Each is a durable-correctness violation whose only alternatives are writing a poisoned row or silently dropping a paid response. |
| `unprepared-history` (if §2.5(a))                               | **Halt the run.** A history the package will refuse at prepare time cannot be recovered by continuing.                                                                                   |
| `batch-contract`, `inconsistent`                                | **Defect.** These are the ledger catching its own caller; they are programming errors and must not be handled.                                                                           |
| `not-owner` from `acquire`                                      | **Refuse the resume**, before any side effect, with the "another process owns this run" wording.                                                                                         |
| `DatabaseReadFailed`                                            | Surfaced as a read failure, never converted to `not-owner`.                                                                                                                              |

Dropping a row is never an option, and neither is asking the user: a refusal
means the ledger cannot describe what happened, so continuing would produce a
run whose durable record is a lie.

### 3.3 Layer: `src/agent/runtime/RunLedger.ts` (new)

Mirrors `sessionEventsLayer`'s placement.

```ts
export const runLedgerLayer: Layer.Layer<
  RunLedger,
  never,
  SessionEvents | Database
> = Layer.effect(
  RunLedger,
  Effect.gen(function* () {
    const events = yield* SessionEvents; // writes: the one transaction
    const log = yield* Database; // reads and claims
    // acquire     -> log.acquireClaims([aggregateId('run', run)])
    // load        -> log.readAggregate(aggregateId('run', run), 1),
    //                then foldRunState(null, rows)
    // appendBatch -> preconditions, write-boundary rules, events.publish(drafts),
    //                then foldRunState(state, committed)
  }),
);
```

Two write-boundary rules live here and nowhere else, both loud, neither a
fallback:

1. **Continuation durability.** A draft carrying a `connection`-anchored
   continuation fails `unpersistable-continuation`. After L2 it cannot
   type-check and the check becomes vacuous, which is the point: it is an
   assertion over the imported schema, not a second declaration of it. Never a
   `?? null`.
2. **Endpoint hygiene.** Every `deployment.endpoint` reaching a ledger row is
   asserted to carry no userinfo, no query string and no fragment, failing
   `unsafe-endpoint`. `z.url()` permits `?api-key=` and `#api-key=` alike, this
   row is never scrubbed and lives until explicit user deletion; the assertion
   is the only thing between a mistyped base URL and a permanent plaintext
   credential.

Plus one refusal: a `response` row whose `turn` contains a local call with a
null `providerCallId` fails `null-call-id` rather than being given a
synthesized key that cannot survive a restart.

### 3.4 Tests run the real ledger

**There is no second `RunLedger` and no hand-written `SessionEvents`.**
`databaseLayer('ephemeral')`
([Database.ts:219](../../../../src/controllers/session/Database.ts), `:memory:`
at :234) already opens SQLite in memory, so tests run the real ledger over the
real publisher, which means a schema mistake fails in PR 1 rather than in PR 2.
The stack, copied from
[`sessionEvents.vitest.ts`](../../../../src/test-kernel/controllers/session/sessionEvents.vitest.ts):

```ts
const roots = createFakeWorkspaceRoots({ storagePath: '/workspace/ledger' });

const testLedgerLayer = runLedgerLayer.pipe(
  Layer.provideMerge(sessionEventsLayer),
  Layer.provideMerge(databaseLayer('ephemeral').pipe(Layer.orDie)),
  Layer.provide(Layer.succeed(WorkspaceRoots)(roots)),
  Layer.provide(ProcessIdentity.layer(SELF)),
);
```

`at` is stamped from `Clock.currentTimeMillis` inside the publisher, so
`it.effect`'s `TestClock` controls it. The `event` table is generic (`type
TEXT`, `data TEXT`) and the new arms need no schema change.

### 3.5 Wiring

[`sessionLayer.ts`](../../../../src/controllers/session/sessionLayer.ts),
inside `sessionGraphLayer` (:430), one line beside the existing
`sessionEventsLayer` merge (:435):

```ts
    Layer.provideMerge(runLedgerLayer),
```

The ledger is available to every session root from PR 1; nothing appends yet.
This is the whole production wiring, and it is what keeps §6 honest.

---

## 4. `foldRunState`

### 4.1 Module, and its relationship to `sessionFold.ts`

`src/shared/session/runStateFold.ts` (new). A **sibling** of
[`sessionFold.ts`](../../../../src/shared/session/sessionFold.ts), never a
section inside it:

|           | `sessionFold.ts`                                                               | `runStateFold.ts`                                                      |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| output    | `SessionView`, what people see                                                 | `RunState`, what the loop continues from                               |
| redaction | display-redacted before view state                                             | **none**: a redacted fold produces a conversation the provider rejects |
| machinery | module-private `WeakMap` index maps, a structural-sharing publication contract | a small pure reducer with no incremental-publication requirement       |
| inputs    | every `SessionEvent` arm plus chunks, local runtime, subscriptions             | the six rows plus the two approval arms                                |

They share only `SessionEvent` and commit ordering, which already live in the
schema module. Same directory keeps the fold family together and keeps the
trace viewer's reach: `packages/trace-viewer/src/traceFrames.ts` already
imports `@shared/session/*`, so PR 3's stepper gets this function with no new
import edge.

In PR 1 the six arms are **inert** in `sessionFold.ts`: `listingTypeOf` returns
null, so `foldDurable` returns at :1616 before `applyOwnArm` (:1340). Six
explicit no-op cases are nonetheless added, because the switch has no
`default:` and returns `StreamView`. **A reviewer will be tempted to add a
`default:` instead. The explicit cases are the point**, because a `default: return`
there is exactly the "unknown event quietly dropped" defect CLAUDE.md names,
and PR 3 gives `flow.step` real handling.

### 4.2 Signature and state

```ts
/**
 * The one pure run-state fold. `RunLedger.load` runs it over a run's rows,
 * `appendBatch` runs it over the rows it just committed, and the trace
 * viewer's stepper (PR 3) runs it over the same rows up to a chosen commit.
 * Because the same function produces the state the loop saw when it appended
 * step k, "state at step k" and "resume would continue after step k" are the
 * same fact: replay along the flow, without re-executing anything.
 *
 * Pure in the sense that matters: no IO, no clock, no `Date.now()`, no
 * platform, no store read, no synthetic id, no dependence on `Map` iteration
 * order in any output value. Every value it produces comes from a row. It
 * applies no redaction: display redaction is a later boundary.
 *
 * `rows` must be strictly increasing in `commit`; the fold does not reorder
 * them. `state` is `null` for a cold fold and the previous level for an
 * incremental one, and the two are the same computation, and that equality is
 * what the ledger test pins.
 *
 * Returns a typed inconsistency rather than throwing or defaulting: a
 * snapshot that disagrees with the rows below it is corruption, not a state
 * to degrade into.
 */
export function foldRunState(
  state: RunState | null,
  rows: readonly SessionEvent[],
): Result.Result<RunState | null, RunLedgerInconsistent>;

export class RunLedgerInconsistent extends Data.TaggedError(
  'RunLedgerInconsistent',
)<{
  readonly reason:
    | 'out-of-order' // commits not strictly increasing
    | 'stale-snapshot' // a snapshot contradicts rows already folded
    | 'orphan-settlement' // a tool.result under no pending response
    | 'unknown-run-row' // an unrecognized type on the run aggregate
    | 'dangling-binding' // an approval binding names no row
    | 'mismatched-delivery'; // a delivering append does not settle its response
  readonly detail: string;
  readonly commit: CommitOrdinal | null;
}> {}
```

`RunState` is a plain TypeScript type with **no schema of its own**, because giving it
one invites persisting it, which C10 forbids. Every field is `z.infer`'d from
the row that produced it: the commit and snapshot-commit ordinals, the
`rowsBeforeSnapshot` counter that drives §4.4, `messages` in provider order,
the flow coordinates, the continuation, the open attempt with its identity and
acceptance, the pending response with its dispatch facts and settled map, the
pending intents keyed by call id, the runtime failure state, the family state,
and the unresolved approvals with their recovery bindings resolved.

### 4.3 Transitions

| Row                                                  | Rule                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model.message` **`attempt`**                        | sets the open attempt; sets `phase: 'model.submitted'`. A second `attempt` for the same invocation at a higher attempt replaces it; a lower one is `out-of-order`.                                                                                                                                                                                     |
| `model.message` **`identified`**                     | sets the open attempt's `providerResponseId`. `dangling-binding` if no open attempt matches the invocation.                                                                                                                                                                                                                                            |
| `model.message` **`accepted`**                       | sets the open attempt's acceptance. The commit barrier: `observe` may be called only after this row is committed.                                                                                                                                                                                                                                      |
| `model.message` **`response`**, `calls` empty        | requires the row's invocation to be the open attempt, else `dangling-binding`; appends `assistantMessageFromResult(turn)`; sets the continuation from the HTTP arm's `continuation` (the editor arm has none, L6); clears the open attempt and the pending retry.                                                                                      |
| `model.message` **`response`**, `calls` non-empty    | same invocation requirement, which is what stops a replayed row from replacing an unrelated pending response; sets the pending response with an empty settled map; installs **no** provider message; same continuation, attempt and retry effects.                                                                                                     |
| `model.message` **`append`**, `sourceResponse: null` | appends `messages`.                                                                                                                                                                                                                                                                                                                                    |
| `model.message` **`append`**, `sourceResponse` set   | must equal the pending response's id, else `mismatched-delivery`. Appends `assistantMessageFromResult` of the pending response's turn, then the row's `messages`; clears the pending response, its settlements and their pending intents. **This is where the paid assistant turn enters history, once.**                                              |
| `model.compaction`                                   | `messages := [...messages.slice(0, keepPrefix), ...row.messages]`; continuation from the row. The only row that shortens history. **See §2.5: nothing here checks the result is a preparable history.**                                                                                                                                                |
| `tool.intent`                                        | requires the row's `responseId` to be the pending response and every call id to name one of its non-`parallelSafe` dispatch facts, else `dangling-binding`; a row naming neither leaves the real barrier unprotected. Upserts one pending intent per call id at the row's attempt. A higher attempt supersedes; a lower one is `out-of-order`.         |
| `tool.result`                                        | requires a pending response holding the call id and no settlement yet recorded for that call at that attempt, else `orphan-settlement`; that is what makes the mutations exactly-once rather than once per replayed row. Records the settlement; removes the pending intent **only when the attempt matches**; applies `stateMutation` in array order. |
| `flow.step`                                          | sets the step and each coordinate it carries (asserted non-decreasing, so a round-end step is emitted before the snapshot that opens the next round, never after it); records the halt outcome on `'halted'`.                                                                                                                                          |
| `flow.snapshot`                                      | §4.4.                                                                                                                                                                                                                                                                                                                                                  |
| `approval.requested` / `approval.resolved`           | maintain the approval map by request id. A `model-retry` binding must match the pending retry's request id; a `tool-outcome` binding must match a pending intent's `approvalRequestId`. An inconsistent binding is `dangling-binding`, a resume refusal with a diagnostic, never consent.                                                              |
| every other display row type                         | ignored by an explicit named list.                                                                                                                                                                                                                                                                                                                     |
| any other unrecognized row type                      | `unknown-run-row`.                                                                                                                                                                                                                                                                                                                                     |

That last pair is the design: display rows are ignored _by name_; anything
else unrecognized is a failure, never a `default: return state`. Note what one
aggregate costs here. While display rows lived on a different aggregate, an
unrecognized type was safe by construction. Now the named list is the only
thing between a newly added display arm and a resume refusal, and the steps
this note is sequenced against add them: S2 of the one run model adds `run.end`
and `run.description`, S3 adds `request.opened` and `request.decided`. Each must
extend the list in the same pull request that adds the arm.

### 4.4 The snapshot rule: reconcile, never overwrite

A `flow.snapshot` is persisted derived state that §2.1 lets override the facts
it was derived from. Left as a wholesale replacement, a snapshot authored from
stale in-process state silently un-applies a `tool.result` that already
committed below it, and the resumed run re-dispatches a barrier tool with no
error anywhere. So:

- **Restore-only fields**: everything in `SnapshotRuntimeSchema` plus the
  family state: replaced wholesale. No row carries them, so there is nothing to
  contradict. **With one exception the fold cannot currently police: the
  family state contains the usage accumulator (§2.7), which `tool.result` `add`
  operations do mutate. Until open decision 12 is answered, this rule is
  unsound for that one field.**
- **Reference fields**, `SnapshotReferencesSchema`: **if no ledger rows
  were folded before this snapshot, adopt; otherwise assert equal and fail
  `stale-snapshot` on any difference.** A cold full read has already folded the
  rows that establish them, so the snapshot is checked; PR 2's
  snapshot-anchored read has folded nothing before it, so the snapshot
  restores. One rule, deterministic, total on any suffix.
- **Never touched**: `messages`, `continuation`, `commit`. Messages are absent
  from the snapshot by §2.1; the continuation is absent by design, because
  `model.compaction` and `model.message response` are its only carriers.

`RunState.messages` is therefore a lower bound in an anchored read, which is
exactly what `RunLedger.load`'s read window is responsible for covering.

### 4.5 The history the fold assembles must be preparable

If §2.5's option (a) is taken, `foldRunState` is where the check has a natural
home on the read path too: after a cold `load`, the assembled `messages` are
run through `PreparedHistorySchema` (turn.ts:489-530) once, and a failure is
`RunLedgerInconsistent` rather than a silently-broken resume. That single
consumer is what makes L1's `PreparedHistorySchema` export legitimate under the
export-needs-a-consumer rule; without it, L1 exports a symbol nothing calls.

---

## 5. The two tests

Under the repo's budget (default zero new tests; a feature gets a few at its
**durable boundary**), PR 1 gets two files. Both would have to be written
eventually; neither is pinned to a seam PR 2 rewrites. **Resist a suite per row
type.**

### 5.1 `src/test-kernel/agent/runtime/RunLedger.vitest.ts`

`it.effect` from `@effect/vitest`, `TestClock`, the real ledger over
`databaseLayer('ephemeral')` (§3.4). Three cases:

1. **Live state equals reloaded state.** Drive one run through: initial
   `[append, flow.snapshot]`, `attempt`, `identified`, `response` (two calls,
   one a duplicate), `tool.intent`, two `tool.result` batches each with its
   `tool.end`, the delivering `append`, then `flow.snapshot` +
   `flow.step turn.end`. Assert the `RunState` returned by the last
   `appendBatch` deep-equals a fresh `RunLedger.load` on the same run.
   _Why it earns its place:_ this is the lane's central invariant, and nothing
   else checks it.
2. **The ledger rows are byte-exact.** Read the stored `data` column back and
   assert the `TurnResult` is identical to the one appended, including
   thinking signatures and encrypted reasoning, and that a secret-shaped string
   inside the turn content survives unchanged while the same string in a `log`
   display row is redacted. (`redactTraceDraft` has no `tool.start` arm today:
   that type falls through its `default: return event`, so tool input is not
   scrubbed on any display arm.)
   _Why it earns its place:_ it fails the day someone routes ledger rows
   through `redactTraceDraft`, which is C3's second owner and is currently held
   only by a `default:` arm
   ([traceRedaction.ts:82-83](../../../../src/shared/session/traceRedaction.ts)).
3. **The batch contract.** A delivering `append` whose tool group does not
   match the pending response's call set is refused; a `response` row carrying
   a `connection` continuation is refused; an executed `tool.result` carrying a
   real attachment with loose keys is **accepted** (the regression the review's
   `SettledFileSchema` finding predicts). All assert the refusal or the
   acceptance, not a silently-nulled field.

### 5.2 `src/test-kernel/shared/session/runStateFold.vitest.ts`

Plain vitest, no Effect runtime, hand-built row arrays, one table-driven
`it.each` over the acceptance table PR 1 owes the reviewer:

| Crash point                                          | Recovered by                                                                                                            | Explicitly **not** recovered                                                                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| between `tool.intent` and the adapter call (barrier) | the intent row with no matching `tool.result`, giving outcome-unknown                                                   | whether the tool ran. `tool.intent` is evidence that execution was **admitted**, never that it happened. The resume rule must raise a `tool-outcome` approval and must never fabricate `cancelled`. |
| after a paid response, before the turn-end snapshot  | the `response` row plus the preceding snapshot's phase                                                                  | nothing; the rule is "process the committed response, never re-invoke".                                                                                                                             |
| during generation, before the `response` row         | the `attempt` and `identified` rows: the invocation is attributable, and for `openai-responses` retrievable             | the response content. And, under `synchronous = NORMAL`, an OS crash can lose the `attempt` row itself (§1.6.1).                                                                                    |
| approval requested, never resolved                   | the existing approval arms **plus** the binding in `pendingRetry.requestId` / `pendingIntents[].approvalRequestId`      | anything, without the binding: the approval payload names no call and no invocation, so a resumed process could only retire it as `interrupted`, which is forbidden for these two purposes.         |
| compaction that replaced history mid-run             | `model.compaction` (`keepPrefix`, `messages`, continuation)                                                             | nothing from the snapshot alone: snapshots omit messages.                                                                                                                                           |
| a completed run being continued                      | a `flow.snapshot` existing, full stop; the outcome does not enter it                                                    | n/a                                                                                                                                                                                                 |
| pre-0.41 run                                         | zero ledger rows, so `load` returns `null`, worded "recorded before the run ledger", distinct from "checkpoint corrupt" | n/a                                                                                                                                                                                                 |

Plus the loudness cases: out-of-order commits; a snapshot naming a settled
intent (`stale-snapshot`); a `tool.result` under no pending response
(`orphan-settlement`); a `model-retry` binding naming no pending retry
(`dangling-binding`); an unknown row type on the run aggregate. And two guards
that keep the union widening honest: `listingTypeOf` returns `null` for all six,
and `redactTraceDraft` returns a ledger draft unchanged.

The fixture comment records the **measured serialized byte size** of one
realistic reflection snapshot and one tool-use snapshot, so PR 2 has a number
before it turns the writes on (§1.6.3).

---

## 6. Dead-code ratchet

`npm run check:dead-code-ratchet` runs knip twice; the `--production` pass
drops `src/test-kernel/**/*.vitest.ts` entry points, so anything only a test
consumes surfaces as `production-dead`. **PR 1 adds no export that only a test
consumes**, and needs no new entry in `config/ratchets/knip-baseline.json`:

| New export                                                                                                       | Production consumer, same PR                                                                                    |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| the six arm schemas                                                                                              | **not exported**, inline `durable(...)` members of `SessionEventDraftSchema`, the `RunStartEventSchema` pattern |
| `runLedgerEvent.ts`'s payload schemas and types                                                                  | `sessionEvent.ts`, re-exported through the `@shared/schemas` barrel                                             |
| `runState.ts`'s relocated schemas                                                                                | `runLedgerEvent.ts` and the agent modules that imported them before the move                                    |
| `toolResult.ts`'s newly exported `ExecutedToolResultSchema`, `ErrorToolResultSchema`, `ToolFileAttachmentSchema` | `runLedgerEvent.ts`                                                                                             |
| `foldRunState`, `RunState`, `RunLedgerDraft`, `RunLedgerInconsistent`                                            | `src/agent/runtime/RunLedger.ts`                                                                                |
| `RunLedger`, `RunLedgerRefused`                                                                                  | `src/agent/runtime/RunLedger.ts`                                                                                |
| `runLedgerLayer`                                                                                                 | `sessionGraphLayer` in `sessionLayer.ts`                                                                        |
| `PreparedHistorySchema` (L1)                                                                                     | `foldRunState` / `appendBatch`, per §4.5                                                                        |

**Two exports the original spec proposed are cut**, because they have no
production consumer in PR 1: `RUN_LEDGER_ROW_TYPES` and `RunLedgerRowType`. The
arms are `case` labels in two exhaustive switches, not set lookups, so the set
is dead against the ratchet. If PR 2 needs a set, PR 2 adds it with its caller.

Two ratchets must be checked but not widened: `shared-schemas-deep-import`
(satisfied by adding both modules to `src/shared/schemas/index.ts` and importing
through the barrel) and `host-agent-import-baseline` (untouched: PR 1 adds no
host import). `effect-migration` is untouched: no new `Effect.run*`, no
`platform()`, no `setServices()`, no `new AbortController(`, no
`@adapter-until` marker.

Note the knip caveat the review raised and this PR must actively check rather
than assume: several `runLedgerEvent.ts` exports are consumed only through the
barrel's `export *`, which is the pattern that has produced false-green knip
runs in this repo before. Run the ratchet with the barrel in place and read the
`production-dead` list, do not infer it.

**If a reviewer asks to export the six arm schemas "for testability", the
answer is no**: the fold test builds rows through `SessionEventDraftSchema`,
which is the boundary that actually runs in production.

---

## 7. What PR 1 deliberately does not do

**Deletes nothing.** `src/agent/node/`, `ModelInvocationNode.ts`,
`RoundPersistedFlow`, `ResponseCycleFlow`, `ToolUseRoundFlow`, the node
classes, `resumability.ts`, `SessionResumeRetrieval`'s checkpoint arm,
`persistedCompileRejection.ts` and the `PocketFlowNode` / `PersistedFlow` /
`ReflectionFlowStateRecovery` suites are all untouched.

**Writes no row in production.** The layer is provided; nothing appends. The
vocabulary is frozen where §2.2 says it is frozen, the machinery is proven by
tests, and PR 2 turns the writes on.

**Does not enable PR 2's deletions by itself.** Both judges made this point and
it belongs here rather than in a defensive footnote: the rows encode where the
loop _was_, not what the loop _did_. All of `ModelInvocationNode`'s retry
policy (the `p-retry` batch, `shouldAutoRetry`, the two-key route gate with
`classifyModelRouteFailure`, the Kimi-Code credential rebuild) becomes durable
only as a three-value `pendingRetry.substate`; every other line of it moves into
PR 2 unchanged. PR 1 enables PR 2 to be _written_. It does not shrink the tree.

**Owns none of these, all PR 2:** the two Effect loops; `ModelInvoker` /
`Tools` / `FollowUps` / `RunContext` / `OutputPipeline`; the resume _rules_
(re-run vs ask vs synthesize-cancelled, permit consumption, binding
revalidation), where the fold decides nothing and reads only row data;
`deriveResumability` and its callers; the `flow_<id>.json` consumers outside
the flow engine, which the judges enumerated as six sites in four subsystems
(`executionLiveness.ts`, `executionKvFiles.ts`, `executionLifecycle.ts`,
`AgentLaunchContext.ts`, `persistedCompileRejection.ts`, `resumability.ts`),
each of which becomes a ledger query and none of which PR 1 provides an indexed
latest-snapshot read for; the `setProjection` write-through in
`runToolUseFlow.ts`, whose touched-file artifact loses its writer when
`PersistedFlow` goes; the reflection prep segment
(`PrepareContext`/`TeXCount`/`MediaExtraction`), which the coarser phase
vocabulary cannot address and which therefore needs a stated idempotence
obligation; and record deletion, which no row expresses, so every run that ever
wrote a `flow.snapshot` is resumable forever unless PR 2 gives closure a row.
**PR 2 must delete `resumability.ts`'s checkpoint parse in the same release, or
the two authorities disagree.**

**PR 3** adds `flow.step` handling to `sessionFold.ts`,
`RunLedger.rowsThrough`, and the viewer's scrubber over the same
`foldRunState`. **PR 4** folds the workflow-script journal into the event table.

**Not in any PR of this lane:** an importer, a cursor mapping, or any
conversion of `flow_<id>.json` into rows. The 0.41 owner ruling removed it.

---

## 8. Open decisions for the owner

Numbered by how expensive they are to reverse after the first row is written.
Decisions 10 to 12 are new, added by the review; the rest carry forward.

**0. One aggregate per run.** _(Before PR 1 is implemented.)_ This note now
declares every row on one `run` aggregate keyed by the run id, which is what
removes the two-key deviation earlier drafts carried. That shape is the
recommendation of the
[one run model](2026-09-10-one-run-model.md), not yet a ruling: its §7 item 1
still puts it to the owner, and it is the one place that note departs from a
ratified detail, the one-fold PRD's per-kind sequence. If the owner instead
keeps two aggregate kinds sharing one logical id, §2.2, §2.8, §3.1 and §4.3
here revert to naming a kind per row class, and the counter and claim this
shape deletes come back.

**1. Is the durable route binding the literal deployment, or an opaque route
id?** _(Before PR 1 merges; after rows exist it is a row rewrite.)_
`BindingSchema` puts `deployment: { endpoint: z.url(), credentialScope }` on
every assistant message, `sameModelOrigin` compares both byte-for-byte, and a
mismatch is a hard `unsupported` for the whole turn. A credential rename, a
move to a relay, or a trailing slash permanently poisons rows already written.
_Options:_ (a) an opaque route identity resolved at execute time; (b) constrain
the durable endpoint to scheme, host and path; (c) persist as-is with §3.3's
assertion. **Recommendation: (b) now, (a) as a package follow-up.**

**2. Do the invocation attempt and the accepted operation's absolute deadline
live on the runtime row envelope, or inside `RemoteOperationSchema`?** _(Before
PR 1 merges.)_ §0.1's boundary table describes them as constituents of the
accepted operation; the package has neither. **Recommendation: the runtime
envelope**, per §0.1's Ownership paragraph. If the package ever absorbs them,
rows PR 1 wrote carry the fields in the wrong place, so record the ruling in
§0.1, not just here.

**3. `flow.snapshot`'s `lastError` is runtime-owned and is not derived from
`ModelError`.** _(One-line ruling; it unblocks the row.)_ The package's
`ModelError` fields schema is unexported, its payload carries a
non-serializable cause, and its enum has no counterpart to the exhaustion
classification that drives retry and route-switch policy today.
**Recommendation: rule it runtime-owned and keep
[`PersistedRetryErrorInfoSchema`](../../../../src/shared/schemas/errors.ts)
(:287).** The contract check flagged this as blocking only because the ruling
was not written down.

**4. `argumentsText` (L3) is itself a dual representation.** _(Before the
package merges.)_ The spec proposed shipping `arguments: JsonObjectSchema`
**and** a required `argumentsText: z.string()` tied by a `superRefine` that
`JSON.parse`es and deep-compares on every validation, including every fold of
every row. That is the dual system the same document condemns when the second
field is optional, and it puts an O(arguments) comparison on the read path.
_Options:_ (a) store only `argumentsText` and parse on demand at the two lowering
sites; (b) two fields with the refinement; (c) two fields, no refinement.
**Recommendation: (a).** One carrier, byte-exact, and the parse happens where a
parse already happens.

**5. Deviations from §2.1's payload sketches.** Sign off or send back. There are
**five**: `sourceResponseCommit` becomes a runtime-minted `responseId`;
`messageBaseCommit` is dropped (PR 2 adds it back as an optional hint);
`flow.step.continuation` becomes `continuationIndex`; the enumerated
state-slice mutation set becomes a general path vocabulary, required by
`recordSubagentCost`; and `model.message` gains
`attempt`/`identified`/`accepted`. **Recommendation: accept all five.**

**6. Should `SessionEvents.publish` gain a typed failure channel?** Today it is
`Effect.orDie` (SessionEvents.ts:99-102), so the single-owner refusal enforced
inside `NEXT_SEQ` reaches the runtime as a defect. _Options:_ (a) leave it;
`acquire` gives resume a typed answer before any side effect, and a lost race
dies loudly; (b) widen `publish` and let callers decide. **Recommendation: (a)
for PR 1, (b) filed as a substrate item for PR 2**, which is the first code
that must survive losing a race. Whichever is chosen, §3.1's comment must say
which refusal arms are actually reachable, so the type is not read as a promise
it cannot keep.

**7. `codecVersion` is a literal embedded in every persisted `ModelOrigin`.**
The day a version 2 exists, every stored row fails to parse unless the literal
is widened, and `.catch` on persisted data is forbidden. **Recommendation:
record now that persisted origins accept a forward-compatible union of version
literals while execution admits only the current version.** The same applies to
the prefix-fingerprint algorithm version, which today lives only in a code
constant and never reaches a row.

**8. Does the schema relocation (§1.4) ship as PR 1's second commit or as its
own prerequisite PR?** It touches roughly forty files mechanically and is
behavior-identical. **Recommendation: PR 1's second commit**, so review reads
it as a move, but check `main` for a sibling relocation first and land it
before anything else touches `src/agent/core/state`.

**9. Confirm the `flow.step` enum (eleven values) and that `RunPhaseSchema`
stays a separate ten-value enum.** Steps are transitions and phases are states.
Both are closed and the fold switches them with no `default`, so a new member
is a compile-time decision, not a data migration.

**10. Does the run aggregate need `PRAGMA synchronous = FULL`?** _(New.)_
`NORMAL` (Database.ts:950) is justified in-file only against `kill -9`, and the
rows that make a paid response survivable are exactly the rows an OS crash can
lose. _Options:_ (a) leave `NORMAL` and state the limit in the PR body and in
§0.1; (b) `FULL` for the whole database and accept the write-latency cost on
every display row; (c) a per-transaction `synchronous` change around ledger
batches. **Recommendation: (a) for PR 1**, but the ruling must be written down
in §0.1 rather than left implicit, because every "durable" claim in this lane
inherits it.

**11. How is compaction's assembled history validated?** _(New; before the row
freezes.)_ §2.5. **Recommendation: option (a)**, validate through
`PreparedHistorySchema` at the write boundary and on cold load.

**12. Where does usage live?** _(New; before the first row is written.)_ §2.7.
_Options:_ (a) usage is derived by the fold from `model.message response` and
`tool.result` `add` operations only, and the accumulator is **removed** from
every snapshot payload, which makes the snapshot rule sound again but requires
the relocated family schemas to omit a field they carry today; (b) the
accumulator stays in the snapshot and becomes the sole carrier, with the fold
forbidden from deriving usage, which contradicts storing `TurnResult`
verbatim; (c) both, reconciled the way §4.4 reconciles reference fields, with a
mismatch failing `stale-snapshot`. **Recommendation: (a).** It is the only one
that satisfies §0.1's "attributed once per recorded attempt/receipt", and it is
also the only one that lets `flow.snapshot` freeze.

---

## 9. Verified

Every path:line below was opened on 2026-09-08 before it was written down.

Repo line references use the `main` snapshot
[`77b8866c467cf939e5a84d94cd7682da262393b4`](https://github.com/LionSR/TeXRA/tree/77b8866c467cf939e5a84d94cd7682da262393b4).
Cutover changes can move these line numbers; the named symbols identify the
corresponding current code.

`ReflectionFlowStateSchema` at
`ReflectionFlowState.ts:39-65`, with `workspaceSnapshot` :43, `context` :44,
`outputLocation` :45, `runStateSnapshot` :47, `roundOutputs` :49,
`continueRounds`/`endTurn` :51-52, `lastError` :55,
`modelHandlerCompatibilityKey` :58, `compileFailureContext` :61,
`unresolvedCompileRejection` :64, and no `stateSlices`, `modelId`,
`systemPrompt`, `shouldSkipCycle`, `userCancelledRetry` or `structured`
anywhere in it. `StateSlicesSchema` at `nodes/types.ts:26-30`;
`ToolUseRunSharedSchema` at :48-67 with `modelId` :54, `shouldSkipCycle` :58,
`stateSlices` :59, `systemPrompt` :61, `userCancelledRetry` :62, `structured`
:66. `AgentRunStateSnapshotSchema` at `AgentState.ts:23-27` with
`usageAccumulator` :26; `recordCycleMetrics` mutating in place at :37-48.
`RunUsageAccumulatorJSONSchema` at `RunUsageAccumulator.ts:44-47`.
`AgentWorkspaceStateSnapshotSchema` at `AgentWorkspaceState.ts:296`.
`UserVariableChannelsSchema` at `AgentCycleOptions.ts:199`.
`ModelHandlerCompatibilityKeySchema` at `modelHandlerCompatibilityKey.ts:23`.
`durable()` at `sessionEvent.ts:174-189`, building a plain `z.object` from
`...shape`. `LISTING_TYPES` at `Database.ts:138`; `databaseLayer` at :219 with
`:memory:` at :234; `PRAGMA synchronous = NORMAL` at **:950**, inside
`configure()` at :940. `publish = log.appendAll(events).pipe(Effect.orDie)` at
`SessionEvents.ts:99-102`. `applyOwnArm` at `sessionFold.ts:1340`,
`foldDurable` at :1603, its `listingTypeOf(event) === null` return at :1616.
`redactTraceDraft` at `traceRedaction.ts:10`, `default: return event` at
:82-83. `assertNever` at `sessionProgressSubscription.ts:211`.
`SHARED_AGENT_IMPORT_ALLOWLIST` empty at `dependencyDirection.vitest.ts:70`.
`sessionGraphLayer` at `sessionLayer.ts:430`, `sessionEventsLayer` merged at
:435. `CANCELLED_CALL_ERROR` at `ToolUseDispatchNode.ts:49`, the `logId`
comment at :68-69, `logId: undefined` at :223 and :349, `recordSubagentCost`
adding into `options.run.usageAccumulator.totals.totalCost` at :307-311.
`AbsoluteFS.appendFile` at `ResponseCycleFlow.ts:348`. `FileReferenceSchema` is
a `z.looseObject` at `toolResult.ts:9-15`; `ToolFileAttachmentSchema` extends it
with `base64Data` :25 and `bytes: z.instanceof(Uint8Array)` :27; `diagnostics:
z.unknown().optional()` at :140; `ExecutedToolResultSchema` at :145.
`RunOutcomeSchema` at `stream.ts:68`; `AgentFileLocationSchema` at
`output.ts:38`; `RoundOutputSchema` at :271; `PersistedRetryErrorInfoSchema` at
`errors.ts:287`.

`packages/llm` (cutover branch `llm-durable-shape`, not on `main`):
`LocalCallPartSchema` at `turn.ts:255-259` with `providerCallId:
z.string().min(1).nullable()` at :257. `ContentSchema` :341;
`EditorContentSchema` :342-355, with
`LocalCallPartSchema.shape.providerCallId.unwrap()` at **:350**, the L5
companion edit. `AssistantMessageSchema` :442; `MessageSchema` :461;
`PreparedHistorySchema` :489-530, whose `superRefine` requires an adjacent,
complete, ordinal-ordered tool group after any calling assistant and a calling
assistant immediately before any tool message. `ResponsesContinuationSchema`
:570-585 with the `connection` arm at :577-578; the reuse gate returning
`ModelError kind: 'unsupported'` at openaiResponses.ts:1081-1088;
`eligibleResponseId` tracked on the live transport at openaiResponses.ts:2099,
:2287, :2411. `HttpTurnResultSchema` :1220 with `continuation:
ContinuationSchema.optional()` :1267; `EditorTurnResultSchema` :1335-1349 with
`finishReason: z.null()` :1342 and `content: EditorContentSchema` :1344 and no
`continuation` field; `TurnResultSchema = z.union([...])` :1351-1354 is
undiscriminated, which is why L6 exists. `googleInteractions.ts:353` still
contains `if (deadline) console.log('JOINDEBUG', cause, exit);`.
`packages/llm/package.json` is `private: true`, version `0.41.0`, with an
`exports` map pointing at raw `./src/*.ts`.

Correcting the review: `packages/llm` is **not** untested. Five suites live in
`src/test-kernel/llm/` on the cutover branch: `OpenaiChat.vitest.ts` 3,449
lines, `OpenaiResponses.vitest.ts` 2,463, `GoogleInteractions.vitest.ts` 1,610,
`AnthropicMessages.vitest.ts` 1,177, `OpenrouterChat.vitest.ts` 878, **9,577
total**, placed there by the repo's centralized-test convention rather than
beside the package.

Ruling cited: "Private ledger rows stay outside the public trace union", at
[`2026-09-06-effect-runtime-delivery-plan.md`](./2026-09-06-effect-runtime-delivery-plan.md)
line 194.

Not verified, and carried forward from the original spec as claims rather than
facts: the count of `flow_<id>.json` consumers outside the flow engine and
their line numbers (§7 states the file list without line citations for that
reason); the assertion that a new root `paths` entry reaches every build; the
"roughly forty files" estimate for the §1.4 relocation. Each is PR 2's or the relocation commit's to confirm.
