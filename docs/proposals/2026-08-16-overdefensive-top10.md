# Over-defensive patterns: the top 10 — let it break (2026-08-16)

> **Status:** Adjudicated audit + removal plan, pinned to origin/main
> `25fe7d354b`. Executes the maintainer ruling: _defensive code that
> tolerates states a single owner already excludes is not safety — it is
> silent-failure manufacturing; the smart move is to let it break and let
> the layer's catcher make it loud._ Method: four census workflows
> (parse/validation, control-flow, state/copy, error-handling) over all
> prod code, merged into a top-10 ranking, then every entry re-verified
> adversarially at exact file:line. Verifier verdicts: 5 CONFIRMED,
> 5 ADJUSTED, 0 refuted outright — all corrections are folded in below,
> and two inflated sub-claims (#5's flagship catch story, 2 of #10's four
> FS sites) are rewritten to what the code actually does. R6 net-element
> accounting applies to every PR; R8 consumer-greps are named per entry.

Scoreboard: **~230 defensive sites censused → ~180 removable across 10
families (est. net −700..−800 LoC of pure defense + one whole
silent-failure class), gated by ~25 LoC of root-level catches (§3), with
a boundary charter (§2) so sweeps don't overshoot into the ~350 sites
that are true boundaries.**

## 0. The ruling and the let-it-crash layer map

The ruling: a guard is over-defensive when the state it tolerates is
either (a) excluded by a mechanism that already owns the invariant
(lease, single-owner pipeline, synchronous dispatch), or (b) a
programming/wiring error whose correct fate is a loud failure. In both
cases the guard converts a reportable bug into wrong-but-quiet behavior
— §15's M-rules at family scale. The replacement is never a new
handler: it is **throw, and rely on the layer's existing catcher**. That
only works where the catcher is loud, so this map is the safety argument
cited by every REMOVE below. Verified per layer at this HEAD:

| Layer                                                   | What a throw does today                                                                                                                 | Catcher (file:line)                                                               | Loud?                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| Run path (flow/node/model-handler/runtime inside a run) | `finalizeFailedRun` → `classifyAgentError` → terminal FAILED result, structured error, log + subagent delivery; double-finalize guarded | `src/agent/runtime/AgentRunLifecycle.ts:572,576` (guard `:788`)                   | **Yes** — FAILED state + per-host error surface |
| Tool call                                               | caught, normalized, returned as `{status:'error', error}` tool result; the model sees the text and adapts; run survives                 | `src/agent/implementations/flows/tooluse/toolUseRound/ToolUseDispatchNode.ts:316` | **Yes** (to the model and transcript)           |
| CLI command / CLI background                            | root catch → stderr `TeXRA CLI failed: …` + nonzero exit; `CliUsageError` → exit 2; unhandled rejection → Node ≥15 default crash        | `packages/cli/src/bin/texra.ts:13-27`, `packages/cli/src/commands/root.ts:189`    | **Yes** everywhere                              |
| Extension command                                       | registered verbatim ("no wrapping" by design) → VS Code's own error notification + ExtHost log                                          | `packages/extension/src/commands/_shared/registerCommands.ts:32`                  | **Yes**                                         |
| Extension view-message dispatch                         | `dispatchInbound` onError forwards async rejections but only `log.error('Error handling message')` — no user surface                    | `src/shared/webview/dispatcher.ts:176-177`                                        | **Log-only** — gate G2                          |
| Desktop main IPC                                        | `ipcMain.on` fire-and-forget; rejection → `onAsyncError?.` → `reportAsyncError = console.error`                                         | `packages/desktop/src/main/hostBridge.ts:30-34`, `index.ts:308`                   | **No** — gate G1                                |
| Desktop main post-startup background                    | fatal-startup handlers removed after import; no process-level rejection surface                                                         | `packages/desktop/src/main/bootstrap.ts:9-15`                                     | **No** — gate G1                                |
| Desktop renderer / webview frontends                    | `unhandledrejection` listener installed only on the bootstrap-failure path; normal path bare                                            | `packages/desktop/src/renderer/main.ts:1237-1241`                                 | **No** — gate G3                                |
| ExtHost background (non-command async)                  | no `unhandledRejection` handler anywhere in the extension host                                                                          | (absent)                                                                          | **No** — gate G2                                |

Consequence, encoded throughout §1: **REMOVE verdicts on run-path, tool,
and CLI code are executable today.** REMOVE verdicts whose throw would
land in a log-only or silent row are sequenced behind §3's gates G1-G3
(~25 LoC total). Renderer-resident code gets DEFINE-AWAY, not REMOVE —
a renderer throw kills the UI, not the run.

## 1. The top 10

Format per entry: pattern → quantified extent → representatives →
disposition → execution shape → est. net LoC.

### 1. `z.unknown()` StreamLogEntry.data → per-consumer safeParse+skip

One untyped field on the internal log-entry carrier
(`src/shared/schemas/log.ts:129`, `data: z.unknown().optional()`) forces
every downstream consumer to re-discover the payload type with
`safeParse` plus a silent skip/fallback branch. **Extent:** 27 verified
sites across 6+ files, est. 300-400 LoC of failure branches and
"legacy or corrupt?" reasoning. Representatives:
`packages/cli/src/chat/tui/state/transcriptFold.ts:74,210,237,317,836`
(`:74` also does render-time dedup via a `seen` set — a separate
UI-anti-pattern violation to delete with it),
`src/shared/streams/taskGroupProjection.ts:96,118` (~20 lines of
malformed-payload reasoning at `:93-111`),
`src/transcript/completedRunArchive.ts:152,198,225,249`, plus the
progressView formatters (`dataFormatters.ts:70,104,213`,
`messageFormatters.ts:55,112`, `logSlice.ts:106,137`,
`TaskGroupList.ts:429`). **Disposition: DEFINE-AWAY** — retype `data`
as a discriminated union and validate ONCE at the two real boundaries:
persisted-log read (`src/transcript/StreamLogStore.ts:1654`, already
parses the envelope per entry) and exported-trace import
(`packages/trace-viewer/src/replayTrace.ts:129`). Verifier correction
applied: the discriminant is **not** the 3-member entry `type`
(`log.ts:73-77`) — the payload variance lives under the optional
`messageType` field (14+ members, `log.ts:33+`), so the union keys on
`messageType` plus the group-payload kind, and a producer census of
`messageType`-absent `'log'` entries must precede the retype. Not
REMOVE: all 27 consumers are renderer/projection code (map row:
renderer throws kill the UI). The `taskGroup.ts:62-68` per-field
`.catch` survives only at the exported-trace boundary (register:
permanent legacy boundary); live rows stop needing it once this lands.
**Execution shape:** one schema PR (producer census + union + boundary
parses), then a mechanical consumer sweep deleting the 27 branches. R8:
grep `safeParse(.*\.data` before and after. **Est. net −250..−300 LoC.**

### 2. `try*` platform accessors turning persisted writes into silent no-ops

`tryPlatform()/tryGlobalState()/tryWorkspaceState()`
(`src/platform/platform.ts:88-100`) exist to tolerate pre-init access,
but **42 call sites in 23 files** use them post-init, so user
settings/goal writes silently vanish — §15 M2 at family scale.
Representatives: `src/utils/config/providerConfig.ts:40,60,74,92,150`
(a settings toggle that doesn't stick),
`src/tools/goal/goalStore.ts:109,287` (goal persistence no-ops),
`src/model/subscriptionPreference.ts:26,32`. **Disposition: REMOVE** —
post-init consumers call `platform().globalState`, which throws on
uninitialized = programming error. Verifier corrections applied, per
map row: the CLI leg is loud today (`bin/texra.ts:13-27`); the
**extension leg** of the representative write path
(`SettingsViewMessageHandler.ts:437` →
`BaseViewMessageHandler.dispatchInbound`) lands in the log-only
`dispatcher.ts:176-177` onError — loud in the log, no user surface —
so extension-view-path sites want gate G2 first; the **desktop leg**
lands in `reportAsyncError = console.error` (`index.ts:308`, entry #9's
sink) — desktop sites are sequenced behind gate G1. Excluded: bootstrap
callers keep `try*` (`packages/cli/src/runtime/initPlatform.ts`,
`bin/texra.ts`, `packages/agent/src/index.ts`), and goalStore's read
paths carry a written pre-init rationale (`goalStore.ts:57-60`; its
`writeRaw` already uses throwing `platform()`) — documented KEEPs that
shrink the removable set to ~35. **Execution shape:** mechanical
workflow sweep (CLI/run-path/extension-command sites now; extension
view-message and desktop sites after G1/G2). R8: grep
`tryPlatform\(\)|tryGlobalState\(\)|tryWorkspaceState\(\)`.
**Est. net −25 LoC + deletes an entire silent-failure class.**

### 3. Intermediate-era legacy-normalization arms on internal persisted formats

Tolerant readers for record shapes only pre-cutover installs wrote,
several running on LIVE parses. **Extent:** 7 mechanisms censused, ~250
LoC; removable after corrections: **2 clean + 1 preconditioned + 1
policy-gated**, ~120 LoC. Per mechanism:
`src/agent/core/state/AgentWorkspaceState.ts:343-389` (legacy
todos/plan union arms) and
`src/agent/implementations/flows/tooluse/nodes/types.ts:163-176`
(modelId-lift) — **REMOVE via age-out** per the #9590 disposal policy:
era-check the cutover date, delete; an ancient record fails the resume
parse and lands in the existing not-resumable path (user sees a
non-resumable session, not corruption; modelId-lift additionally has a
config fallback). `src/shared/schemas/usage.ts:54-90`
`withLegacyUsageRoute` (applied 3×, incl. live) — **REMOVE with a
precondition** (verifier): the `usage.ts` strictObject copy is safe
(failures land in the verified warn+preserve `unparsedRuns` path,
`streamData.ts:146-155`), but `TokenUsageStatsParsingBaseSchema` wraps a
non-strict `z.object` (`streamData.ts:85`), so deleting the wrapper
there would silently STRIP `viaChatGptSubscription` and reclassify old
subscription rows — the #7464 corruption this mechanism guards;
strictify that base first. `src/shared/schemas/agentRoster.ts:59` —
**demoted to policy-gated**: documented at `:54-58` as a permanent
parse-side reader over immutable, never-rewritten per-run history rows;
no rewrite event exists for age-out to wait on, and dropping it lists
finished team runs as incomplete (wrong-but-quiet). Removable only
under an explicit stop-reading-old-history decision.
`contextManagement.ts:42` follows the age-out lane. Excluded (KEEP):
EndGroupStatus and `errors.ts:77` normalization — named external
producers in exported archives. **Execution shape:** PR-by-PR (each
mechanism needs its own era-check/strictification). **Est. net −120
LoC.**

### 4. Double-checks of invariants another mechanism already owns _(CONFIRMED verbatim)_

Four apparatuses defending against states the single-owner machinery
already excludes, each with test plumbing pinning the defense — highest
drift burden per site in the corpus. (a) Resume double-read + drift
check: `src/agent/runtime/SessionResumeRetrieval.ts:223`
structuredClones the freshly-read record into `sourceShared`; sole
consumer `runToolUseFlow.ts:468-476` does a **second disk read** and
`isDeepStrictEqual` over the whole shared state to detect drift the
executionLease machinery already excludes. DEFINE-AWAY: pass the
retrieved record in; the existing
`PersistedFlowStateError('invalid-shared')` throw already routes to
`classifyAgentError` → `finalizeFailedRun`
(`AgentRunLifecycle.ts:565-585`) — same catcher, one read. (b)
`packages/cli/src/chat/tui/state/sessionSignalsAdapter.ts:51-93` +
~18 guard sites: staleness machinery whose own comments admit
session-fact application is synchronous — `isStaleDispatch` can never
fire today, and if it fired it would silently drop a fact (M6+M2).
REMOVE outright; a future async-dispatch PR owns re-adding staleness.
(c) `src/agent/core/tools/toolAttachmentExtraction.ts:99` re-parses its
own just-constructed output (two full Zod parses per tool call; first
parse at `:56` remains the wire guard) plus the silent
`filter(isToolFileAttachment)` drop at `:53-54` — delete the second
parse, make the filter loud or throwing. (d)
`packages/cli/src/runtime/terminalStatus.ts:60-78` re-reads
just-persisted ExecutionMeta and prefers `meta.outcome` over the
in-memory `result.outcome` it already holds — a second owner for a
decided fact; keep only the `outcomePersisted` probe. Excluded
(register): `inBandSubagentExecution.ts:529` manifest read-back
(crash-recovery consumer real), lease/crash-repair machinery.
**Execution shape:** PR-by-PR — four bespoke apparatuses, each deleting
its tests in the same PR (R6: scaffolding test LoC counts double).
**Est. net −100 LoC + per-tool-call CPU.**

### 5. Zod `.catch()` on our own durable/authoritative data

Small count, defect-grade: each is the M3 whole-file-rewrite trap —
corruption becomes a silent default becomes permanent data loss.
**Extent after corrections: 6 sites**, ~35 LoC. Representatives:
`src/shared/schemas/streamSnapshot.ts:69-75` — `.catch` on EVERY field
of "our own trusted disk format" (its words), including
`schemaVersion.catch(...)`; REMOVE → strict parse, on failure warn +
treat-as-absent (loud, non-destructive; read path
`streamSnapshotRead.ts:183` is not run-critical, and per verifier this
is no more destructive than today's per-field defaults feeding the same
later write). `src/agent/runtime/UsageMonitor.ts:275`
`.catch('unknown')` masks a model-registry typo as `provider:'unknown'`
in accounting rows forever; REMOVE, **with the verifier's correction to
the catch story**: the parse sits inside the method's own try whose
catch at `UsageMonitor.ts:314-318` swallows everything at
`logger.debug` — a plain `.parse` would die there, converting a
silently-wrong row into a silently-dropped one. The fix hoists the
parse above that try (so the throw reaches `AgentRunLifecycle.ts:576` →
terminal FAILED) or loudens the catch to warn — which §15's
no-downgrade-below-warn rule requires independently. Deflated to KEEP:
`telemetrySettingsHandlers.ts:9-14` carries a written rationale
(non-authoritative view snapshot; runtime telemetry independently fails
closed). Excluded: auth/JWT decoders (`codexJwt.ts:43-47`,
`xaiJwt.ts:26`, `jwtDecode.ts:11` — external tokens, auth-credential
register), OAuth/device-code responses, `updateChecker.ts:185` (npm
registry), `taskGroup.ts:62-68` at the exported-trace boundary only.
**Execution shape:** PR-by-PR (each site has a distinct blast radius;
UsageMonitor needs the hoist). **Est. net −35 LoC.**

### 6. All-optional private logger interfaces _(CONFIRMED)_

`interface ServerSideKeyLogger { error?(...) }` and siblings exist only
so tests can pass partial mocks, forcing `?.` at every call site.
**Extent:** 24 prod `.error?.(`/`.warn?.(` sites (verifier recount;
claimed 26), 22 of them in four auth files:
`src/auth/serverKeys/ServerSideKeyService.ts:30-33` (the interface) ×5
call sites, `src/auth/SupabaseSession.ts` ×7,
`src/auth/serverKeys/TierService.ts` ×7, `supabaseSessionTypes.ts` ×3;
2 desktop stragglers (`desktopProtocolCallbacks.ts:197`,
`desktopCrashReporting.ts:33`) are optional-host-callback style — fold
in or exclude. **Disposition: DEFINE-AWAY** — methods required, bind
noop/real logger at construction; mechanically safe, no throw path
involved. Excluded: genuinely-optional callbacks (`onError?.`,
HostInteractions' partial host surfaces — hosts really do attach
partial surfaces). **Execution shape:** one mechanical PR.
**Est. net −30 LoC.**

### 7. Nullable ExecResult stdout/stderr → per-consumer re-default _(CONFIRMED)_

`normalizeOutput` returns `string | null`
(`src/utils/system/execUtils.ts:37-39,127`), so consumers each write
`result.stdout ?? ''` — the §15 dual-default `??`-chain. **Extent:** 17
strict-grep sites (claimed 20). Representatives:
`src/tools/grep.ts:180`, `src/tools/lean/direct/lakeCommands.ts:79`,
`src/utils/git/repositoryOverview.ts:59`. **Disposition: DEFINE-AWAY**
— stdout/stderr always `string` at the one producer. The audit
precondition is load-bearing (verifier): `normalizeOutput` conflates
empty output with null via `text?.trim() || null`, and at least two
consumers branch on that semantic — `workspaceInfo.ts:89`
(`stdout !== null` = dirty git tree; must become `!== ''`) and
`updateChecker.ts:231` — rewrite those in the same PR. Excluded: the 98
`?? undefined` null-normalizations (exactOptionalPropertyTypes / the
OpenAI-compat `.nullish()` rule). **Execution shape:** one PR — producer
flip + 2 consumer rewrites + mechanical sweep of the 17. R8: grep
`\.std(out|err) \?\? ''` and `stdout (!|=)== null`. **Est. net −20
LoC.**

### 8. Stringly-typed internal carriers + typed-data-through-untyped-bags _(CONFIRMED)_

Sibling of #1 at smaller scale: internal carriers hold `string`/bag
values, every consumer re-narrows. **Extent:** 5 status re-narrow sites
(~40 LoC) + the vars-bag laundering chain (~20 LoC) + exactly 4
`provider.toLowerCase()` sites (~10 LoC). Representatives:
`src/shared/schemas/stream.ts:166-175` (`executionStatusToRunOutcome`
double-safeParse); `streamStatusDisplay.ts:27`, whose own comment
admits its retired 7-value vocabulary "no live producer emits";
`TaskGroupList.ts:595`; the laundering chain verified end-to-end —
`ATTACHED_MEMORY_MISSES` produced typed at `userVars.ts:237` → stored
in string-keyed `baseVars` → re-parsed at
`src/agent/runtime/AgentLaunchContext.ts:493-495` through a schema
whose `.catch([])` (`src/agent/types/AttachedMemory.ts:10-13`) silently
empties malformed misses; `provider.toLowerCase()` at
`ServerSideKeyService.ts:244,432`, `providerConfig.ts:35`,
`UsageMonitor.ts:276`. **Disposition: DEFINE-AWAY** — type the carriers
as `StreamPhase`/`RunOutcome` with one narrow at the persisted-history
read (`packages/cli/src/runtime/history.ts:418`); carry memory misses
as a typed field beside the bag (matches the no-deep-injection
single-owner ruling — no new bag keys, no parameter-object growth);
lowercase provider once at registry load. Excluded:
`MainViewExecutionController.ts:88` (wire schema deliberately
`partial()`; second parse applies defaults), `validateExecutionRequest`
(shared boundary validator). **Execution shape:** 2-3 PRs by carrier;
not workflow-sweepable (each retype has type-level ripples).
**Est. net −70 LoC.**

### 9. Silent failure sinks in background/bridge layers — the loudness precondition _(CONFIRMED)_

The mirror image of the other nine: the places where "let it break"
currently breaks silently, which GATE every background-code REMOVE.
Extent: 1 no-op fallback + 1 console sink + 3 silent host layers, ~25
LoC of fixes. (a) `src/shared/hostBridge.ts:5-9,26` — silent no-op
`fallbackApi`; broken bridge wiring makes every webview→host
`postMessage` vanish (M2). REMOVE → throw at webview boot; verifier
caveat: `hostBridge.ts:29` claims an intentional "non-webview contexts"
fallback — R8-census the importers (frontend unit tests etc.) before
throwing. (b) `packages/desktop/src/main/index.ts:308`
`reportAsyncError = (error) => console.error(error)` — the sink for ALL
desktop IPC async failures (wired at
`index.ts:310,884,956,994,1048,1092`, consumed via `onAsyncError?.`,
e.g. `desktopWorkspaceIpc.ts:164` — the `?.` means an unwired reporter
is fully silent). Keep the hook, fix the sink to the renderer
toast/log surface. (c) The three silent layers of the §0 map: ExtHost
`unhandledRejection`, desktop main post-startup (`bootstrap.ts:9-15`),
desktop renderer normal path (`main.ts:1237-1241`). **Disposition:
SPLIT** — run-path/tool/CLI-command guards are deletable TODAY
(catchers per §0); extension-view-message, desktop, and background-code
guards are deletable only AFTER these root handlers land. This entry is
§3's G1-G3. **Execution shape:** one small PR per host, FIRST.
**Est. net +25 LoC (the only net-positive entry; it buys every other
REMOVE).**

### 10. Verified point-defect residue in individually-cleared families

The catch/switch/retry corpora are healthy overall (2026-07 audit, 880
sites), but a fixed straggler list survived verification. **Extent
after corrections: 11 sites**, ~35 LoC. Confirmed REMOVEs:
`src/latex/latexdiff.ts:81` bare catch→null (FNF-discriminate then
rethrow; callers sit under tool-error return and run classification;
ENOENT keeps the legitimate skip-diff, and the read precedes any diff
write — no mid-write stranding);
`src/agent/implementations/flows/reflection/output/diffComputation.ts:48`
(debug + return `{}`); `packages/cli/src/commands/orchestrate.ts:132`
catch-all→`false` around internal model selection (M1; CLI root catch
is the landing zone); 3 assertNever gaps —
`src/shared/copy/modelAccess.ts:97`,
`packages/cli/src/runtime/modelAccess.ts:458`,
`packages/cli/src/runtime/modelAccessRoute.ts:134` (a new route member
silently gets no copy/action); `src/agent/node/index.ts:172-177`
maxRetries<1 log-and-clamp → throw in the constructor (reaches
`finalizeFailedRun`). Verifier deflations:
`src/utils/files/rulesUtils.ts:41-42` already logs WARN with the error
— add FNF discrimination as an upgrade, not an unmasking;
`packages/cli/src/runtime/cliContext.ts:221` is a commented
multi-candidate build-layout probe loop — KEEP, drop from the list.
Excluded: the 68 §15-L3-commented `catch {}`, ~10 listener fan-out
guards (L1), throwing-stdlib→option adapters on untrusted input
(`tryParseUrl` etc.), dev-asserts `dispatcher.ts:239,266`.
**Execution shape:** one mechanical sweep PR over the fixed list.
**Est. net −35 LoC.**

## 2. The boundary charter — where defensiveness REMAINS correct

Sweeps must not touch: **(i) true boundaries** — the ~120-site boundary
safeParse corpus (external APIs, persisted-file reads such as
`StreamLogStore.ts:1654` / `persistedFlow.ts:137` / `PersistedState.ts`,
IPC/webview wire including `dispatcher.ts:146` and the desktop
`*Ipc.ts` decoders, model-output JSON, vm-sandboxed user-script values
at `runWorkflowScript.ts:428`), auth/JWT token decoders
(`codexJwt.ts:43-47`, `xaiJwt.ts:26`, `jwtDecode.ts:11`), and
error-message matching on provider/relay wire text (all 10 sites
external); **(ii) the §15 accepted exceptions** — L3-commented
best-effort catches (68), listener fan-out L1 guards
(`SessionEventHub.ts:120`, `SessionHandle.ts:1028`, etc.), display
defaults (`?? 'unknown'`, 33 sites), test-seam optional-init
(`?? DEFAULT_*`, ~75 sites — per the no-deep-injection ruling: don't
grow, don't remove), and the OpenAI-compat `.nullish()` /
`?? undefined` normalizations (98); and **(iii) the fenced
irreducibility registers** — lease/crash-repair machinery, the
`inBandSubagentExecution.ts:529` manifest read-back, auth credential
cells, ModelCell, storageGeneration, the interrupted-follow-up buffer
(`ToolUseFollowUpQueueManager.ts:83,364`), onboarding funnel,
round-update reset, `workflowExecutionState` sealed-guard silent
returns (documented late-async-publication tolerance — watch, don't
remove), the exported-trace legacy boundary (`taskGroup.ts:62-68`,
`replayTrace.ts:129`), and goalStore's documented pre-init reads
(`goalStore.ts:57-60`). A sweep agent finding a candidate in any of
these lists stops and records it; it does not "fix" it.

## 3. Execution plan

**Land the gates first (entry #9; ~25 LoC total, one small PR per
host):**

- **G1 — desktop:** point `reportAsyncError` (`index.ts:308`) at the
  renderer toast/log surface; restore a post-startup process-level
  rejection handler after `bootstrap.ts:9-15` removes the fatal-startup
  pair.
- **G2 — extension host:** add an ExtHost `unhandledRejection` surface,
  and give `dispatchInbound`'s onError (`dispatcher.ts:176-177`) a
  user-visible surface beyond `log.error`.
- **G3 — desktop renderer/webview frontends:** install the
  `unhandledrejection` listener on the normal path, not only the
  bootstrap-failure path (`main.ts:1237-1241`); then execute the
  hostBridge throw-at-boot after the R8 importer census.

**Workflow-sweepable (many mechanical sites, per-site judgment
minimal):** #2 (CLI/run-path/extension-command sites immediately;
extension view-message sites after G2; desktop sites after G1), #6, #7
(after its 2-consumer null-semantics rewrite lands in the producer PR),
#10 (fixed list), and the consumer half of #1 (after its schema PR).
Sweep prompts carry §2 verbatim as the stop-list, per the campaign
know-how (canary 1-2 agents, central typecheck gate — vitest green ≠
typecheck green).

**PR-by-PR (schema retypes, preconditions, bespoke apparatuses):** #1's
schema PR (messageType producer census first), #3 (era-check per
mechanism; strictify `streamData.ts:85` before touching
`withLegacyUsageRoute`; agentRoster only on explicit policy), #4 (four
apparatuses, tests deleted in-PR), #5 (UsageMonitor hoist), #8 (carrier
retypes). Not gated on G1-G3: #4, #5's run-path sites, #10 — their
throws land in the already-loud rows of the §0 map.

Every PR reports R6 net-element accounting; every emitter/guard
deletion runs the R8 consumer-grep named in its entry.

## 4. Runners-up (all explicit KEEP — recorded so later waves don't re-audit)

- Boundary safeParse corpus (~120 sites) — true boundaries (external
  APIs, persisted files, IPC/webview wire, model-output JSON).
- `catch {}` / log-and-continue corpus (129 + 26 sites) —
  §15-disciplined post-2026-07 audit; listener fan-out L1 accepted.
- Defensive clones/spreads/freezes (~12 clone sites) — hand-calibrated
  with written rationales; hot paths already tuned
  (`openAIMessageUtils.ts:149`, `StreamLog.ts:570`).
- Bounded caps/LRU (22 sites) — real unbounded producers or documented
  finite-key rationale; follow-up-queue caps registered.
- Existence pre-checks (29 `existsSync`) — concentrated at true FS
  boundaries; if-defined-then-call on required members: zero found.
- Retry wrappers (6 pRetry sites) — all I/O, all shouldRetry-gated; the
  flow engine defaults to no retry (`src/agent/node/index.ts:112`).
- Error-message string matching (10 sites) — all external/provider wire
  text; own-error dispatch is instanceof everywhere (24 sites, all
  reachable narrows).
- Default arms over unions (100 arms) — 29 assertNever'd; remainder are
  wire/dispatch pass-throughs (the 3 stragglers are in #10).
- Guard-clause silent no-ops (248 single-line) — sampled: state-machine
  idle guards on genuinely-optional state; goalStore masking subsumed
  by #2.
- `?? DEFAULT_*` optional-init (~75 sites) — test seams; undefined is a
  legal input; don't grow, don't remove.
- `workflowExecutionState` sealed-guard silent returns (5 sites) —
  documented late-async-publication tolerance; watch, don't remove.
- Register items re-confirmed out of scope: lease/crash-repair, auth
  credential cells, ModelCell, storageGeneration, interrupted-follow-up
  buffer, onboarding funnel, round-update reset, manifest read-back.
