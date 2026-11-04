# Storage, errors and stop paths: one vocabulary per fact

Date: 2026-11-03
Status: accepted (owner, 2026-11-04)
Origin: the deeper pass the owner asked for after
[fewer processing options](./2026-11-03-fewer-processing-options.md), over the
SQLite and storage layer, error definitions and catch sites, interruption and
stop, and the model-call failure path. Surveyed on `main` at `6ae3ae0`. The
rule is the same: an option, a mode literal, an error kind or a reason value is
a decision; one nothing branches on is a name, not a decision, and one decided
in several places has no owner. The settled constraints this note works
inside: the catch budget's seven planes and its rejected findings
(`.agents/docs/implemented/architecture/2026-06-10-error-pipeline-and-ownership.md`),
and the stop and liveness rules
(`.agents/docs/implemented/architecture/2026-10-02-durable-harness.md`,
`.agents/docs/implemented/architecture/2026-09-20-single-owner-liveness-and-one-fold.md`).

## 1. Storage: modes that are booleans, branches nothing reaches

| Item                              | Where                                                                                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `databaseLayer(mode)`             | `packages/harness/src/controllers/session/Database.ts:187-230`                                                      | Three values (`persistent` ×2, `ephemeral` ×1, `existing` ×1 producer) become `create = mode !== 'existing'`, a `?mode=rw` URI branch, `disableWAL`, and a re-mapped two-value mode that `openStore` and `prepareStore` branch on again five times (`packages/harness/src/controllers/session/storeSchema.ts:261-387`). It is `{ file: path \| null, create: boolean }`. |
| `Database.readAggregate` `types?` | `Database.ts:835-836`, SQL at `:315-317`                                                                            | Both callers (`packages/harness/src/controllers/session/sessionStore.ts:329,332`) always pass `types`; the untyped `aggregate` statement is dead.                                                                                                                                                                                                                        |
| `DeletionMode`                    | `packages/harness/src/shared/session/database.ts:49`                                                                | `single` \| `bulk` \| `automatic`, read once as `mode === 'single'` (`Database.ts:533`). A boolean.                                                                                                                                                                                                                                                                      |
| Transaction `gated`               | `Database.ts:436-457`                                                                                               | A fourth axis beside `'read' \| 'write' \| 'derive'`; `gated: false` has one caller (`releaseClaims`, `:986`), `'derive'` one (`:560`).                                                                                                                                                                                                                                  |
| Row upcast machinery              | `packages/harness/src/shared/schemas/rowVersions.ts:123-270`, `controllers/session/rowCodec.ts:128-170,295,325-327` | All 22 row and plugin-fact kinds declare an empty upcast list; no upcaster exists. The per-row upcast loop, the `readableFrom` floor, the plugin upcaster reduce and the per-kind `EARLIER_RUNS` scan still run on every read. `packages/harness/AGENTS.md` "Storage format" says before 1.0 a kind changes with no upcaster.                                            |
| The global database               | `Database.ts:1045-1059`                                                                                             | Opens the full event store with an empty tool registry to serve two tables (`values`, `inputHistory`); every project database carries `input_history`, whose only consumers are global (`packages/cli/src/chat/tui/history/inputHistory.ts:33,49`).                                                                                                                      |
| `ValueFamily.deletable`           | `packages/harness/src/shared/session/valueFamily.ts:24`                                                             | Set at seven sites, never read at runtime; deletion happens whenever `next === undefined` (`controllers/session/currentValues.ts:126`).                                                                                                                                                                                                                                  |
| Two version gates on values       | `currentValues.ts:65-67` and `rowCodec.ts:377`                                                                      | Each read checks `version > VALUE_VERSION`; the store gate checks `CURRENT_VALUE_KIND` too; each write upserts `stored_kind`.                                                                                                                                                                                                                                            |
| Busy and lock handling            | `Database.ts:227`, `storeSchema.ts:309`, `storeAside.ts:37,47,153`, `currentValues.ts:52`                           | A 5 s driver timeout, then a 25 ms pragma, `retryBusy` on `query` and the outer transaction but not on `prepareStore` or `underCopy`, two retry schedules, and `busyTimeout: 0` for the elsewhere probe.                                                                                                                                                                 |

**Proposal.** `databaseLayer({ file, create })` with WAL derived from
`file === null`; `types` required and the untyped SQL deleted; `DeletionMode`
a boolean named for what it allows; `gated` folded into a `'release'`
transaction mode; the upcast fields and their loops deleted until a first
upcaster exists ("readable iff `stored === version`"); a `ValuesStore` layer
(current values plus input history) split from the event `Database` and the
global database opened on it; `deletable` a phantom type or gone; one value
gate; one busy policy table in `storeAside.ts` that every statement goes
through.

**Give up.** Nothing. Each deleted value has one producer value or none.

## 2. Storage: one classifier for a run that cannot be read

Four predicates, five fallbacks and a second write path answer "this run's rows
cannot be read":

- `unloadable` (`packages/harness/src/shared/session/runHistory.ts:161-167`),
  a direct `instanceof` on `DatabaseRowCorrupt | DatabaseRowEarlier`;
  `earlierBuildRefusal` (`packages/harness/src/agent/storage/resumability.ts:26-33`),
  which walks the cause chain; `rowReader.ts:205-208,316-320`, which tags
  `'earlierBuild' | 'damaged'` into the runtime state; and
  `runRecords.ts:304-310`, the only `catchTag('RunHistoryRefused')`, which
  turns it into `DatabaseReadFailed`.
- On failure each caller chooses differently: a view scan
  (`packages/harness/src/agent/storage/runRecords.ts:152-158`), "child failed"
  (`:171-177`), "no usage" with a log (`:236-241`), `{kind:'unreadable'}` then
  back into a failure (`resumability.ts:47-57,89-92`), skip the run
  (`packages/harness/src/agent/storage/runListing.ts:108-113`).
- `finalizeRun` ends an unloadable run by writing `append(beside)` raw
  (`packages/harness/src/agent/storage/runLifecycle.ts:278-282`), beside the
  `RunCell.append` path (`:273`) that `runHistory.ts:174-181` calls the only
  writer.
- `factKindOf` (`rowCodec.ts:341-364`) and `readTraceFacts`
  (`packages/harness/src/transcript/traceDocumentSchema.ts:61-79`) implement
  the same four version branches.
- "The store is missing" is decided three ways: `readSessionView.ts:53-69`
  (absence, SQLite 14, then `fs.exists`), `openStore` (`storeSchema.ts:364-373`,
  `cannotOpen || isDamaged` means create), and `storeOpenElsewhere`'s
  three-value result of which each caller reads one value
  (`projectDatabase.ts:100,151`).

**Proposal.** One `classifyRunRead(cause): 'corrupt' | 'earlier' | 'io'` in
`shared/session`, used by all four sites; each caller states its fallback
against those three values and no other. The raw end write becomes an
explicit `RunCell` mode or is documented on `RunCell` as the one exception.
`factKindOf` moves beside `pluginFactFloor` and both readers call it. One
`probeStore(path): 'absent' | 'damaged' | 'held' | 'free'`.

**Give up.** Nothing observable; the fallbacks keep their behaviour and lose
their private predicates.

## 3. Errors: kinds nothing branches on

The error-pipeline note already rules that a terminal kind ships only with a
verified producer. The same holds for a consumer: a literal nothing branches
on is a message, and belongs in `message`.

- **`ModelError.kind`** (`packages/llm/src/errors.ts:86-98`), 11 values.
  Outside `retryableByDefault`, five are branched on; `authentication`,
  `rate-limited`, `observation-deadline`, `unsupported` and
  `malformed-output` (about 70 producers between them) are not.
  `rate-limited` is exactly `status === 429` (`packages/llm/src/api/verdict.ts:305`)
  and `quota-exhausted` exactly `quota !== undefined` (`:303,356`); auth is
  decided from the status, not the kind, at
  `packages/harness/src/agent/runtime/run/invocation.ts:157` and
  `packages/harness/src/shared/schemas/errors.ts:131-140`.
- **`AgentErrorKind`** (`packages/harness/src/shared/schemas/runRecords.ts:49-58`):
  `AGENT_ERROR_OUTCOME` (`packages/harness/src/common/errors/agentErrorClassification.ts:20-29`)
  is six rows of which five are `FAILED`, with one consumer;
  `agentErrorPresentation` (`:77-101`) has four identical branches. The
  "missing key" fact travels `RouteUnavailable.reason` →
  `ProviderErrorClassification.kind` → `AgentErrorKind`, three spellings;
  `RouteUnavailable.reason: 'unavailable'` has seven producers and no branch.
- **Reason unions with unbranched values**: `RunHistoryInconsistent.reason`
  (`packages/harness/src/shared/session/runState.ts:77-82`: four of five
  values produced, only `mismatched-delivery` read, `RunHistory.ts:257`);
  `RunHistoryRefused.reason 'unsafe-endpoint'`; `HistoryQueryRefused.reason`
  (`not-a-read`, `result-too-large`); `AgentCustomizeRefused.reason`;
  `SecretsFailed.reason` (`packages/llm/src/providers/credentials.ts:37`,
  neither value read); `TaskRecordsFailed.reason`; `WindowCallFailed.reason`;
  `PromptFailed.reason` (`packages/texra/src/hosts/uiHosts.ts:98`, a one-literal
  union); `SubscriptionOAuthError.kind` (`packages/llm/src/oauth/subscriptionOAuthError.ts`,
  read only through `needsReauth`).
- **`ProviderError.userRetryable`** (`packages/harness/src/shared/schemas/errors.ts:346-353`)
  is required, documented as gating the retry UI, and read by no host.
- **Tagged classes with no discriminator**: of 149 `TaggedError` classes
  across the five packages, about 58 have no production `catchTag`,
  `_tag ===` or `instanceof`, and 24 carry only `message` and `cause`. About
  20 sites build `new X({ message: toErrorMessage(cause), cause })`, adding a
  tag nothing reads (`packages/texra/src/controllers/session/hostCallFailure.ts:36`
  is the shape). Clusters of one failure under several names: thirteen
  "host capability failed", thirteen "unreadable", twelve "refused", six
  "unavailable"; `LeanFileReadError` re-wrapped 1:1 into `LeanFileUnreadable`
  (`packages/texra/src/tools/lean/direct/leanServerPool.ts:515-518`);
  `DeviceCodeExpired` and `DeviceCodeTimedOut`; `CliResourcesNotFound` and
  `DesktopResourcesNotFound`; `ScriptCpuExhausted`, `ScriptMemoryExhausted`
  and `ScriptTimedOut` whose three handlers are identical
  (`packages/harness/src/tools/codemode/ScriptTool.ts:303-305`).

**Proposal.** Delete each kind or reason value with no branch and move its
text into `message`; `ModelError` keeps `retryable`, `scope`, `status` and
`quota` as the decided facts and the kinds that are branched on. The run
record carries `ModelError.kind` or `RouteUnavailable` directly, deleting the
two re-spelled unions. `AGENT_ERROR_OUTCOME` becomes
`kind === 'abort' ? CANCELLED : FAILED`, and goes with `abort` once §5 lands.
`userRetryable` is wired to the retry panel or deleted. One tagged error per
host edge (`HostCallFailed` with the capability as a field), one
`ScriptLimitExceeded { limit }`, and the 1:1 re-wraps gone: the dead-code
ratchet shrinks by the deleted classes.

**Give up.** Catching a failure by a name nobody catches it by.

## 4. Errors: one classifier per question

| Question                 | Deciders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Is this 401/403          | `authOrRejectionKind` (`packages/llm/src/errors.ts:227`), `isCredentialRetryFailure` (`packages/harness/src/shared/schemas/errors.ts:131-139`, re-reading the status after llm set the kind), `oauthTokenErrorKind` (`packages/llm/src/oauth/oauthRequest.ts:53`), GitHub `classifyFailure` (`packages/texra/src/tools/github/githubClient.ts:96`), `packages/texra/src/controllers/modelAccess/subscriptionUsage/SubscriptionUsageService.ts:319`, `isCloneAuthError` (`packages/texra/src/latex/overleafClone.ts:266`) |
| Is this retryable        | `ModelError.retryable`, `notRetryable` (`verdict.ts:269`), `offersRetry` (`packages/harness/src/common/errors/sdkError/providerErrorFormat.ts:150`), `userRetryable`; `unsent` forces "no offer" twice (`failureInfo.ts:37`, `invocation.ts:288`)                                                                                                                                                                                                                                                                        |
| Transient HTTP status    | `isRetryableStatus` (`packages/llm/src/errors.ts:142`), `isTransientHttpStatus` (`packages/harness/src/utils/core/httpStatus.ts:14`, the 409 split documented), an inline `status >= 500` (`packages/llm/src/oauth/chatgpt/chatgptProvider.ts:287`), a hand-rolled loop with its own error pair (`packages/texra/src/latex/arxivProcessor.ts:206-245`) beside `retryTransientFetch` (`packages/harness/src/tools/timeouts.ts:53`)                                                                                        |
| Is this an abort         | `isUserAbort` (`packages/harness/src/common/errors/errorPredicates.ts:35`), inline `name === 'AbortError'` at `packages/llm/src/api/googleInteractions.ts:232` and `arxivProcessor.ts:419`                                                                                                                                                                                                                                                                                                                               |
| Is nothing there         | `absentReason` (the twelve inline `NotFound` checks now call it: done); EACCES-as-absent decided at `packages/harness/src/platform/defaults/workspaceStorage.ts:37` and `packages/harness/src/utils/system/nodeWorkspace.ts:28`                                                                                                                                                                                                                                                                                          |
| Walk a cause chain       | `causeChain` in `packages/harness/src/utils/errors/errorMessage.ts:7` and `verdict.ts:211`; `toErrorMessage` in the harness and `packages/llm/src/oauth/support.ts:4`                                                                                                                                                                                                                                                                                                                                                    |
| Unwrap a `PlatformError` | fifteen hand-written `reason.cause` unwraps (`jsonStore.ts:25`, `nodeProcesses.ts:58`, `execUtils.ts:277`, `arxivProcessor.ts:92,573`, `clone.ts:81,102`, `doctor.ts:196`, …)                                                                                                                                                                                                                                                                                                                                            |
| Word a used-up plan      | `usedUpPlanMessage` and `quotaFallbackMessage` (`providerErrorFormat.ts:89,116`) and again `modelFailureText` and `quotaFallbackNoticeText` (`packages/texra/src/ui/copy/modelAccess.ts:71,98`); the harness wording reaches only logs                                                                                                                                                                                                                                                                                   |

**Proposal.** One decider per row: `ModelError.kind` is the auth fact and
`isCredentialRetryFailure` reads it; `offered` is computed once in
`failureInfo`; the arXiv loop and the ChatGPT revoke use the existing
transient helpers; `toErrorMessage`
unwraps `PlatformError` once and the fifteen sites delete their copy; the llm
package imports the harness's browser-safe `toErrorMessage` and `causeChain`
or the harness imports llm's, not both; the plan wording has one owner, the
UI's, and the harness copies go.

**Give up.** Nothing observable.

## 5. Stop and interruption: one answer to "did it stop or fail"

- **Eleven deciders.** `outcomeFromCause`
  (`packages/harness/src/shared/runs/runStatus.ts:27`) is the named owner;
  `endRun` (`packages/harness/src/agent/runtime/AgentRunLifecycle.ts:325-341`)
  re-derives it by hand and says so in a comment; `endChildLoop`
  (`packages/harness/src/agent/runtime/childRunLoop.ts:777-783`) adds "a
  not-owner error means stopped"; `writeEnd` (`:710`) re-reads `stopCause`;
  `classifyAgentError` maps a DOM `AbortError` to kind `abort` → `CANCELLED`
  (an error turned into a cancellation, with no harness producer of
  `AbortError`); `isTurnInterrupted` turns a `CANCELLED` report into
  `Effect.interrupt` (`childRunLoop.ts:605-606`, a value turned into an
  interruption); `runLaunchGuard.ts:96,101`, `sessionDescription.ts:215-217`,
  `executeCli.ts:474,486` (`hasInterruptsOnly || isUserAbort`) and
  `runRegistry.ts:235-238` each ask again. Three sites re-raise a bare
  `Effect.interrupt` that drops finalizer failures (`invocation.ts:216`,
  `ModelInvoker.ts:319-320`, `compaction.ts:209-211`).
- **`StopCause`** (`packages/harness/src/agent/runtime/runs.ts:89`) is
  `'user' | 'shutdown' | 'released'`; `'released'` exists only as the default
  argument of `interrupt` (`packages/harness/src/agent/runtime/runRegistry.ts:456`)
  and no consumer branches on it; `shutdown` differs from it in one place, the
  `closed` halt reason (`loop/rows.ts:97`).
- **Ten functions stop a run**: `stop`, `interrupt`, `terminate`, `stopAll`,
  `stopEnd` (written from `stop` and again from `start`'s resume body,
  `runRegistry.ts:293-295,484`), `dispose`, `rootRun`'s `Fiber.interrupt`
  (`rootLaunch.ts:156`, no stop record), `session.start`'s `onInterrupt`
  (`effect/sessionPrograms.ts:177`), `executeCli.ts:348` (no stop record), and
  `awaitInBand`'s own three-branch stop
  (`delegation/inBandSubagentRun.ts:354-371`). `SessionRequests.ts:335-355`
  and `ExecutionsTool.ts:485-492` are the same sequence; `RunStop.accepted`
  has one consumer.
- **`RunStopOptions.detachActiveChildren`** is `optional(NullOr(Boolean))` on
  the wire (`runtimeRequest.ts:52`); `true` and `null` have no producer, tests
  included. A `shutdown` stop reads the detach setting in the TUI but forces
  `false` headless and on session close.
- **Six end writers** share one block, built three ways:
  `{ kind: classifyAgentError(e), message: getSdkErrorMessage(e) }` at
  `runLaunchGuard.ts:80-85` and `childRunLoop.ts:724-730`, and `failedEnd`
  (`AgentRunLifecycle.ts:207-231`) through `normalizeProviderError`.
- **`halted` means two things**: a `run.position` row that changes no phase,
  and the loop phase `turn.end` maps to (`runStatus.ts:98,105`); readers of
  `phase === 'halted'` and `at === 'halted'` see different facts.
- **The stopped vocabulary**: `RUN_OUTCOME.CANCELLED`, `RunGroup 'interrupted'`,
  `RunNotice` (six values), `ScriptCallStatus` (`interrupted`, `cancelled`,
  `skipped`), `ScriptDeliverySummary.outcome 'stopped'` (one producer,
  `scriptRun.ts:302`), compaction `'cancelled' | 'interrupted'`,
  `request.decided` action `cancel` with a free-text `cause` nothing reads,
  `FollowUps.release('recoverable' | 'terminal')` read as a boolean.
  `AgentTool.ts:264` stamps `reason: 'user'` on every cancelled child.
- **Resume refusals**: `earlierBuild` detected three times in one resume
  (`resumeRun.ts:186,278`, `resumability.ts:51`), `ownedElsewhere` three
  times (`resumeRun.ts:211,275`, `resumability.ts:87`); `unusableCheckpoint`
  and `notResumable` are only worded; `pluginUnavailable` is lumped with two
  others by its one consumer.
- `COMPACTION_REASONS[reason].trigger` is written to `context.edit`
  (`compaction.ts:262`) and read by nothing.

**Proposal.** `stopOrFailure(cause)` beside `outcomeFromCause` is the one
decider; `endRun`, `endChildLoop`, `runLaunchGuard` and the CLI call it;
`abort` leaves `AgentErrorKind`. `StopCause` is `'user' | 'shutdown'` and
`released` callers say which. Every stop goes through `RunRegistry.interrupt`
so a stop record always exists; `stopEnd` has one caller; `accepted` folds
into the result. `detachActiveChildren` leaves the wire; `shutdown` implies
cascade inside the registry. One `runEndError(cause)`. The loop phase is
renamed so `halted` has one meaning. The script delivery summary says
`cancelled`. Ownership and build are decided once, in `runRejection`, and the
earlier checks go. `trigger` is read by a projection or deleted.

**Give up.** Nothing observable; the hosts converge on the registry's
behaviour, which is the documented one.

## 6. The model-call failure path

- **Dead outcomes.** `FailedNextSchema` (`packages/harness/src/shared/schemas/runHistoryEvent.ts:67-76`)
  admits `cancel`; `failedNext` (`packages/harness/src/shared/session/inFlight.ts:269-286`)
  and `afterFailure` (`invocation.ts:332`) never produce it, and its two
  consumers (`inFlight.ts:236-237`, `invocation.ts:376`) are dead. A person's
  cancel already travels `ask` → `request.decided`.
  `ToolResultPayload.disposition: 'cancelled'` (`runHistoryEvent.ts:404-410`)
  has no producer; `dispositionOf` returns `executed` or `failed`.
- **A truncated turn is a silent success.** `finishReason` is stored
  (`packages/harness/src/shared/schemas/storedTurn.ts:125`) and read by nothing
  outside the llm package; Anthropic `max_tokens` and OpenAI
  `max_output_tokens` arrive as `'length'`, Anthropic's
  `model_context_window_exceeded` as a finish reason while every other
  provider's overflow is the `context-overflow` error (`verdict.ts:302`).
- **An abnormal stream end lands on three kinds.** Google non-completed status
  → `malformed-output` (`googleInteractions.ts:482-484`) but the same status
  in a background snapshot → `provider-rejection` (`:672-682`); OpenAI
  `failed`/`cancelled` → `provider-rejection` (`openaiResponsesCodec.ts:129-145`);
  the background ack splits by status (`openaiResponses.ts:233-235`). "No
  completed turn" is checked three times (`assembleTurn.ts:263-264`,
  `turn.ts:617-623`, `ModelInvoker.ts:336-345`). A `SyntaxError` is
  pre-checked twice before `sdkModelError` already maps it
  (`openaiResponsesCodec.ts:455-461`, `openaiResponses.ts:180-187`). The
  Google wrapper passes only `status` to `sdkModelError`
  (`googleInteractions.ts:219-227`), so Google 429s never carry
  `retryAfterMs`.
- **Retry has several owners.** The invocation loop decides the budget and
  the next step (the documented one owner), but the wait is split: a fixed
  `RETRY_BACKOFF_MS = 1000` sleep in `pauseBefore` (`invocation.ts:48,247-262`)
  that ignores `retryAfterMs`, plus `ModelRetryGate`'s jittered backoff that
  engages only when `scope` is set, so a scoped failure waits both. `maxRetries: 0`
  is set at six SDK sites, and only Anthropic sets a request timeout.
- **A tool fails three ways** (`throw new ToolError` ×160, `errorResult()`
  ×40, literal `status: 'error'` ×26) and a thrown error is converted twice
  with two message texts (`packages/harness/src/tools/core/definition.ts:106-128`,
  `packages/harness/src/agent/core/tools/toolCallParsing.ts:74-89`). The
  tool boundary is catch-budget plane 3, so catching is right; but
  `definition.ts:106` squashes a defect, a programming error, into a
  model-visible error with no log. `diagnostics.code` values (`hook_denied`,
  `tool_unavailable`) and `diagnostics.name` have no reader; "skipped" is
  signalled both as a disposition and as `name: 'Skipped'`, and
  `scriptRun.ts:55` checks both.

**Proposal.** Delete `cancel` from `FailedNextSchema` and `cancelled` from the
disposition. The loop reads `finishReason`: `length` and overflow are one
outcome it acts on (a warning row at least, a compaction or a stop by policy),
not a success. One `terminalStatusFailure(status)` in `assembleTurn` and one
"no completed turn" check; the Google wrapper passes headers like the other
two. The gate owns every wait: `pauseBefore`'s sleep goes and `retryAfterMs`
is honoured. One thrown-to-result converter; a non-`ToolError` defect is
logged at `warn` before it becomes a result; one skip signal; `diagnostics`
values get a reader or go.

**Give up.** A silent success on truncation, which is the defect.

## Rejected

- **The `Symbol.for` error marks, SDK-internal retries, the launch
  presenter**: ruled in the error-pipeline note's rejected findings; not
  re-proposed.
- **The vendor phrase and code tables in `verdict.ts`**: per-provider by
  nature (a vendor's wording), and already the single owner; no `if (provider
=== X)` exists elsewhere in the failure path.
- **The 408/409 split between `isRetryableStatus` and `isTransientHttpStatus`**:
  documented as deliberate (a tool fetch and a model call differ on 409);
  the inline third copy is the find, not the split.
- **`OpenOptions.persistent` and the in-memory database**: the SDK's documented
  embedding mode.

## Order

§1 first, as independent PRs per row (the upcast deletion and the
`ValuesStore` split are the two with design weight). §2 is one PR. §3 and §4
are one PR per package side (llm's kinds, then the harness's unions and
classifiers, then the app's wrappers). §5 is two PRs: the one decider and the
one stop door. §6 is one PR for the dead literals, one for the stream end and
the gate, and one for `finishReason`, which changes run behaviour and gets
the one regression test the testing budget allows.
