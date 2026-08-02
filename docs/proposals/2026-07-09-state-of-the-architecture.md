# State of the architecture: macroscopic review (2026-07)

> **Status:** Synthesis of the 2026-07-09 macroscopic architecture review at
> HEAD `4b402d75a`. 66 structural findings across 13 system-level areas
> survived adversarial challenge (every number below was recomputed at pinned
> HEAD by an independent verifier; corrections are folded in silently and the
> original over-claims are gone; counts are verified survivor findings —
> compact-table rows may pack several sub-findings, and fence-verification
> checks count as findings). This is the **macro companion** to the
> 2026-07-08 micro audit (PR #7636,
> [`2026-07-09-tech-debt-audit-runtime-ui.md`](./2026-07-09-tech-debt-audit-runtime-ui.md) +
> [`2026-07-09-tech-debt-error-ownership.md`](./2026-07-09-tech-debt-error-ownership.md)):
> that audit owns file-level defects; this one owns topology, boundaries,
> planes, and trajectory. Where a macro finding subsumes a micro finding it is
> cited as evidence (micro A1/A2/A4/A6/A10, EP-1, DUAL-n), not restated.
> Companions: [`2026-07-03-tech-debt-audit.md`](./2026-07-03-tech-debt-audit.md),
> [`2026-07-07-fewer-elements.md`](./2026-07-07-fewer-elements.md),
> [`2026-07-03-session-scoped-runtime-architecture.md`](./2026-07-03-session-scoped-runtime-architecture.md),
> [`2026-05-30-agent-sdk-readiness.md`](./2026-05-30-agent-sdk-readiness.md), trackers
> #6951/#6968/#6981/#7152. North star (maintainer decision, 2026-07-09): the
> runtime becomes an external (multi)agent SDK; the three hosts become
> reference examples. §7 is the plan for that; everything else is graded
> against it.

---

## 1. The map

Measured topology at `4b402d75a`. Numbers, not prose; census methods are in
the per-area findings.

**Workspace.** pnpm workspace: repo-root `src/` (host-agnostic core) +
`packages/{extension,desktop,cli,trace-viewer}`. Production code ~263.1k LoC;
`src/test-kernel` ~145.7k LoC across 613 vitest suites (the ledger's "~85k"
figure is a stale subset count). Three tsconfig alias maps for one alias set:
root 44 entries, extension copy 39 (5 behind), desktop copy 44 (byte-identical
duplicate); builds read only the root (`aliasUtils.mjs:4-7` documents the
divergence hazard; nothing checks it). `scripts/` = 35 files / 6,068 LoC, all
wired except one orphan.

**Subsystem graph.** 19 top-level `src/` subsystems; `types`, `hosts`,
`eventBus` are true leaves (zero outgoing alias edges); the other **16 form a
single strongly-connected component** (~95 distinct cross-subsystem edge
types). Dominant weights: agent→shared 188, tools→utils 190, agent→utils 179,
tools→shared 161, tools→agent 160. Back-edges holding the SCC together:
shared→agent 23 (all but one in the mislocated `shared/progressView/backend`),
transcript→agent 16, latex→agent 8, agent→tools 24 (13 wiring files),
plus ~8 single-file accidents. Inside `agent/`: 12 of 18 subdirs form an
internal SCC; the dominant inversion is core→modelHandlers/types (17 imports,
9 files). `tools/` (22 subdirs) is internally acyclic. Enforcement census:
**one** boundary rule in the whole repo (`local/no-vscode-import-in-free-zones`)
plus one 104-line vscode-only vitest; nothing restricts cross-subsystem or
host-alias imports in either direction.

**Host deep-import surface (the future SDK surface, measured).** Distinct
`@agent/*` specifiers per host: extension 49, CLI 35, desktop 27; union 62.
All-three-hosts intersection: **exactly 15 modules** (AgentConfig,
executionRequests/TaskState, ToolUseFollowUp, AgentDirectorySync, storage,
trace, and 9 `runtime/` modules incl. AgentRuntimeHost, HostInteractions,
SessionHandle, SessionEventHub, StreamStatusService). Growth since 2026-06-01
(`009daed64`): CLI 18→35 (1.94x), desktop 17→27 (1.59x), extension 36→49
(1.36x) — ~2.5 new deep entry points per host per week, no gate. Total
shared-src specifiers: extension 267, CLI 126, desktop 136. Core→host
violations in prod: **0** (all 41+15 host-alias imports from `src/` sit in
`src/test-kernel`, by design).

**Host-port surface.** `Platform` = 16 ports (12 required, 4 optional
single-implementer; optional-consumption contagion = 5 sites total).
`NodePlatformServices` requires 9 host inputs; defaults supply ~fs +
toolAvailability + 2 wrappers. uiHosts = 4 ports / 12 members / 128 LoC.
`AgentRuntimeHost` = 1 emit over 16 event keys (11 interaction + 5
presentation; 6 interaction arms never host-emitted). `HostInteractions` = 10
members, 7 doubly-optional request kinds; 4 production impls at 297/247/321/651
LoC each with its own pending bookkeeping. Settings host contract = 102 typed
leaf actions in 16 groups (desktop marks 25 `unsupported(...)`). Composition
roots: CLI `initPlatform.ts` 350 LoC + ~1,016 LoC bootstrap total + 1,675 LoC
per-run plumbing; desktop `platform/index.ts` 226; shared node defaults 928.

**Plane element census.** SessionFact 10 arms; RunFactPayloads 6 keys (+
`'runFact.'` prefix protocol, dated v0.41); RuntimeInteraction 11;
RuntimePresentation 5; AppSignals 10 keys; AgentEvent 20 arms (recounted at
HEAD `4363b4089`, post-pin: 3 arms landed after the `4b402d75a` review pin);
CliProgressEventPayloads 22 keys (frozen, no deprecation clock started);
legacy `STREAM_STATUS` cluster 94 references / 24 prod files. Element census:
peak ~43 → now ~38 → honest floor **~31-33**, not the promised ~26 (§6).
Status reaches host projectors on a **split dual rail** (trace arm in-run,
session fact out-of-run): 10 production apply-sites for one fact.

**Store inventory.** ~12 durable formats: executions KV (loud `readValidated`),
streamLogs (union-shimmed + #7464 loud reads), streamData sidecars
(schemaVersion'd), flow records (v2), external-inquiry storage (versioned),
workspace/global Memento (30 + 44 typed keys, one registry), CLI input-history
(documented lossy-by-design), config.json (dated legacy transform), taskRuns
(one fallback probe fn), index.json pre-KV migration (undated), legacy
conversation.json/todos.json (D3-scheduled), **goal store** — the one store in
the wrong consistency domain (stream-lifecycle data in the preferences Memento,
unversioned, silent read-drop). `SessionStores` facade: 128 LoC, atomic
delete/sweep, ~70% landed; goals are the only stream-scoped store it cannot
reach. FS stack: 1,157 LoC / 8 modules / max 3 inheritance hops — sound.

**External surfaces.** VS Code Marketplace + OpenVSX (VSIX), npm CLI 0.39.3
(frozen JSON rail + 3 `@deprecated` fields with no changelog clock), desktop
installers ×3 OSes (publish input-gated; **no updater, no launch smoke on any
release lane**), Supabase relay (Deno; billing constants hand-mirrored from
`sharedConfig.ts` with a rotted pointer comment; llm-zoo pinned ^1.11 vs
workspace ^1.12; zero CI involvement in deploys), public agent-YAML authoring
surface (19 definition fields, 10 settings fields), `texra.*` command catalog
(67 unique ids, SSOT + satisfies-checked), then-vendored `ink@7.1.0` patch (164
lines, exact-version keyed; now carried unchanged as `patches/ink@7.1.1.patch`).

**Test architecture.** 613 suites; 83% mock nothing; 306 mock sites in 104
suites; 52 host-side mock sites in 32 suites pin runtime-internal module
layout (`@agent/storage` = #1 target, 23 sites). **Zero suites execute the
real `executeAgent`** (6 mock sites on the seam); a self-bootstrapping
deterministic real-runtime validator (`validate:run` +
`TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER`) exists and is wired into no workflow.

**Growth (07-07..08, post-rulings).** Net +16,315 LoC/2 days excl. lockfile
(+8.2k/day vs campaign +8.8k/day); test-kernel +11,467 (+5.7k/day, 70% of
net); ~96 merged PRs/day (218 first-parent landings); fix-titled share 27%
(down from 34%, not halved); files net −56 — the knip ratchet works; the
judgment-only rules bend weakly. Ledger #6981: ~44 rows, exactly 2 carry
future calendar dates.

---

## 2. Scorecard

| Subsystem / concern                    | Verdict                | One-line reason                                                                                                      | Carrying cost                                                                         |
| -------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Workspace topology (packages, aliases) | misshapen              | 3 hand-synced alias maps; boundary fence never built while host deep-imports grow 1.4-1.9x/5wk                       | 3-edit alias tax + ~2.5 uncurated SDK migration sites/host/week                       |
| Subsystem layering (`src/` graph)      | misshapen              | ~97%-real layering held only by convention; 16-node SCC; audits demonstrably don't stick                             | 7-8 fresh violations per audit round; every macro audit re-derives the matrix         |
| `src/shared` identity                  | misshapen              | wire contract + UI kit + a whole progress backend under one alias; source of the largest inversion (shared→agent 23) | zone rule unwritable; Stage 5 deepens the miscategorized subtree                      |
| `agent/` internal shape                | misshapen              | provider-neutral contracts live under provider implementations (core→modelHandlers/types 17×)                        | new handlers written against sibling internals; no internal zone rule expressible     |
| agent↔tools pair                       | sound                  | runtime-composes-registry / tools-consume-runtime is the SDK shape; 13 wiring files, 2 core/flows strays             | near zero; fence the wiring list                                                      |
| Three-host shape (ports, wiring)       | sound / accepted-debt  | contract sharing landed; per-host interaction registries are the deliberate post-#7316 resting state                 | ~5 touch points per new interaction kind; 250-650 LoC per new host                    |
| Platform composition root              | sound                  | 16 ports, 1 commit since April, optional contagion contained to 5 sites                                              | n/a — fence                                                                           |
| Runtime end-state accounting           | decision-needed        | honest floor ~31-33 elements, not the promised ~26; six unpriced drivers                                             | phantom-reduction campaigns if unamended; 94 legacy status refs tax every status PR   |
| Run-data lifecycle (hops)              | decision-needed        | per-host chains are earned; the one defect is the split status dual rail (10 apply-sites for 1 fact)                 | every new consumer must know the invisible trace-attached split rule                  |
| Interface design (ports/IPC/YAML)      | misshapen (edges)      | HostInteractions 7× doubly-optional vs 6 runtime-hard-required; 16/106 settings commands dead                        | throw-site archaeology per kind; 5-file dead chains taxing every union audit          |
| Leaked conventions                     | misshapen              | 3 unowned grammars (delivery tags, template tokens, output naming) with 2 live silent bugs                           | silent corruption/rendering drift per new producer                                    |
| Fallback chains                        | mixed; 6 of 11 masking | storage/config reads are loud; session-resolution and fact fan-out mask silently (shipped A1, A4 classes)            | cross-session bugs and dropped facts discoverable only by manual audit                |
| Agent flow taxonomy                    | sound (needs ruling)   | two real families + shared 955-LoC kernel; reflection is the batch-document contract, not legacy                     | 93-179 flat branch lines; zero per-provider cost                                      |
| Flow engine width                      | misshapen              | BatchNode loop + entire params channel provably dead (18 signature sites, always-`{}` persisted field)               | copied 3-type boilerplate per node; frozen forever if SDK ships first                 |
| Storage macro                          | sound / finishing      | facade 70% landed, loud reads, one store in the wrong medium (goals)                                                 | hand-paired goal forgets; CLI delete leaks sidecars                                   |
| Test architecture                      | accepted-debt + 1 hole | 83% mock-free, memfs core, R7 measurably working; but merge gate never runs the runtime                              | composition bugs reach main; 3 broken-main incidents in one overnight window          |
| Delivery & growth                      | decision-needed        | relay is comment-enforced money; test plane has no detector; desktop has no update surface                           | silent billing drift; +100k test LoC/month; stale-install triage                      |
| SDK consumability                      | misshapen              | run API is SDK-shaped (runAgent 92 LoC); the tax is a ~20-import, 9-registration undocumented bootstrap incantation  | measured host drift (agent-dir bootstrap already diverged); 1-2 days per new embedder |
| Release verification                   | decision-needed        | signed 3-OS installers with zero launch check while the smoke script sits built and unwired                          | emergency re-release risk, paid by external users                                     |

---

## 3. Strategic findings

Thirteen strategic survivors. Decisions first (each: options → recommendation
→ what it unblocks), then misshapen-with-direction, then the two strategic
items already covered by existing design where only the delta is new.

### 3.1 Decisions (zero or near-zero code; make them this week)

#### D1. Fence the SDK boundary now, in both directions (MONO-1, decision-needed, CONFIRMED)

**Measurement.** #7099 demoted the `@texra/core` package; the plan's second
half — the import lint gate — was never built (`2026-05-30-agent-sdk-readiness.md:148`,
verbatim: "the deferred no-restricted-imports lint gate never existed").
Result at HEAD: host deep-imports into `src/agent` grew monotonically, CLI
18→35 / desktop 17→27 / extension 36→49 distinct specifiers in 5.4 weeks
(~2.5 new entry points per host per week); union 62; the all-three-hosts
intersection is exactly 15 modules — Stage 5 is converging on a natural
session-shaped surface without anyone freezing it. Meanwhile the inbound
direction (core importing host aliases) is at a genuine **zero** violations —
one careless swarm PR away from becoming a grandfathered baseline. Enforcement
census: one eslint boundary rule repo-wide, none covering this.

**Verdict.** The structure is not wrong; it is unfenced in the one direction
that compounds. Every uncurated specifier is a future SDK-surface migration
site; at measured migration economics (~34% correction share on consumer
sweeps) every ~30 stray specifiers ≈ one extra batched sweep PR later.

**Options.** (i) Recreate the package/barrel now — rejected (#7099: an
unenforced package rots; a barrel now freezes mid-rename Stage-5 vocabulary).
(ii) dependency-cruiser — rejected; the repo's proven eslint+vitest+baseline
pattern suffices. (iii) **Two ratchets, no new tooling**: R-a (now, free —
zero-violation baseline): forbid `src/**` except `src/test-kernel/**` from
importing the 9 extension-homed aliases plus `@cli/*`/`@desktop/*` — one
`no-restricted-imports` block + ~30 lines in `dependencyDirection.vitest.ts`.
R-b (Stage-5 exit criterion): freeze host deep-import **width** with a
checked-in per-host baseline list (the `config/ratchets/knip-baseline.json` /
`check-dead-code-ratchet.mjs` pattern); new specifiers require consciously
extending the list.

**Recommendation.** (iii): R-a this week, R-b as a Stage-5 exit gate.
**Unblocks:** surface curation (barrel seeded from the 15-module intersection)
after R-b holds; packaging when an external consumer exists. This is step 1 of
the §7 trajectory. **Migration cost:** R-a one small PR, zero code moves; R-b
~50-line script + generated baseline. **Trap:** any barrel before Stage 5
settles (InterruptRegistry already at 0 references; SessionFacts/
HostInteractions still moving).

#### D2. Give the merge gate a real runtime path (QA-1, decision-needed, CONFIRMED)

**Measurement.** Zero of 613 suites execute the real `executeAgent`: 6 mock
sites across 5 suites pin the seam (`DelegationHeadless:37`,
`NativeToolUseStrategy:18`, `DesktopAgentExecution:270/461`,
`resumeToolUseSnapshot:5`, `SetupAssistantRouting:191`); everything below
fakes the flow (`AgentRunLifecycle.vitest.ts:205ff` injects lambdas). PR CI
(typecheck/lint/ratchets/tests/TUI-fixture-smoke/webview-smoke/VSIX) never
crosses the seam. Meanwhile `validate:run` + `internalValidationOverride`
(`ModelFactory.ts:10`; routing unit-pinned at
`ModelFactoryRouting.vitest.ts:349-373`) drives the real packed CLI with a
deterministic fake provider, self-builds its bundle, and is invoked by **zero
of 17 workflows**. Context: 107 merges in the 2-day window; the overnight-loop
record shows 3 broken-main incidents, all "two individually-correct PRs
compose badly" in the run path.

**Verdict.** The pyramid is missing its capstone at exactly the seam the SDK
designates as the external contract. Built-and-unwired is the worst resting
state.

**Options.** (A) Wire `pnpm --filter @texra-ai/cli validate:run` into
`ci.yml` — ~10 workflow lines, zero new code, transitively gates the CLI
bundle (the keepNames bug class). (B) One consumer-contract vitest suite
through FakePlatform + internalValidationOverride — R7-legal (executeAgent has
no path-mirrored suite), honest cost **300-600 test LoC** (agent resources +
workspace scaffolding), and it becomes the executable SDK-surface definition.
(C) Status quo — rejected.

**Recommendation.** A now; B as the §7 surface-definition artifact.
**Unblocks:** safe Stage-5 cadence; the SDK's first consumer-level behavioral
contract. **Trap:** any second fake-model system (cassettes, scripted-model
frameworks) — `internalValidationOverride` already is the fake provider at
the correct boundary; a second one is an R1 dual.

#### D3. Re-baseline the end-state ledger to parity (~32), and say what the campaign actually bought (TD-1, decision-needed, CONFIRMED)

**Measurement.** The §8 fewer-elements target ("~26, genuinely below the
pre-campaign ~30") is already falsified: the coordinator fold that was
supposed to take ~32→~26 **landed** (grep `BasePromiseCoordinator|
RunCoordinatorBridge|InterruptRegistry` = 0) and the floor is still ~31-33,
held by six verified drivers: frozen 22-key CLI rail (no deprecation clock:
CHANGELOG has zero notes, version 0.39.3), reimplemented 1000-event
presentation buffer (`extensionPresentationEvents.ts:19` — contradicting the
design doc's "never reimplemented" at :612), permanent interaction/
presentation vocabulary split (11+5), justified ApprovalRequestHandler replay,
3 justified host-interaction impls, triple-channel status until D1. Legacy
`STREAM_STATUS`: 94 refs / 24 prod files. Both designated decision venues
(Checkpoints A/B) closed without recording decisions; #6982 still gates on the
failed venue.

**Verdict.** The three-plane migration succeeded architecturally at **element
parity**; its real purchase is scoping/typing/multi-window correctness. If the
plan of record keeps promising ~26, the next quarter mints phantom-reduction
campaigns.

**Options / recommendation.** (a) Execute R2(3) this release: one changelog
line deprecating CLI JSON `status`/`terminalStatus`/`endGroupStatus` in 0.40,
delete in 0.41 — the named external consumer gating D1 Sweep 2. (b)
Calendar-date D1 (#6982) in the issue itself, bypassing the failed checkpoint
venue. (c) Amend fewer-elements §8 to ~32 and record "parity, bought
correctness" as the official accounting. All three ≈ 0 LoC. **Unblocks:**
Sweep 2 (~590 LoC), honest planning. **Trap:** launching a new
element-reduction campaign to close the 6-element gap — measured economics say
it costs more than it keeps.

#### D4. Finish the status rail: one fact, one channel per consumer (HOP-1, decision-needed, CONFIRMED)

**Measurement.** `StreamStatusService.publishStatus`
(`StreamStatusService.ts:288-321`) emits a trace `'status'` arm when
`options.trace` exists, an `updateStreamStatus` session fact only under
`!trace && events`, and always notifies in-process listeners. Every shared
consumer must wire **both** arms: 10 production apply-sites for one fact
(ProgressFactApplier ×2, desktop bridge ×2, CLI subscription ×3, plus the
sanctioned in-process rail ×3). The split rule (trace-attached in-run vs not)
is invisible in types. Corrected reader-set **as measured at the pinned
`4b402d75a`**: the trace `'status'` arm had **zero persistence/replay
consumers** — the recorder's arm was a bare `case 'status': return;`,
`replayTrace.ts:94-121` derives status elsewhere; after deleting the three
projector trace-arms the arm would have been consumer-less.

> **Amended 2026-07-25 — the zero-persistence-consumer premise no longer holds
> at HEAD, and option (i)(b) is withdrawn.** #9127 (`d93885e6e4`, 2026-07-24)
> replaced the recorder's no-op arm with a load-bearing persistence consumer:
> `src/transcript/TexraTranscriptRecorder.ts:389-426` reads the trace
> `'status'` arm and, on `WAITING` or any terminal outcome phase, closes the
> transcript boundary, flushes every open stream, and settles still-open tool
> rows as failed ("The stream ended before this tool completed."); `RUNNING`
> reopens the boundary. Covered by
> `src/test-kernel/transcript/TexraTranscriptRecorder.vitest.ts:284` ("assigns
> source settlement order before terminal status projection"). Deleting the
> trace arm now silently drops those durable settlements, so retaining it is
> forced rather than the documented bet the recommendation argued for.
>
> The rest of the measurement still holds at HEAD, with line drift only:
> `publishStatus` is `StreamStatusService.ts:291-324`, and its two
> cross-process arms are mutually exclusive — `options.trace?.emit(event)`
> (`:309`) whenever a trace is attached, the `updateStreamStatus` session fact
> only under `!options.trace && options.events` (`:312-320`) — while
> in-process listeners are notified either way (`:321-323`). That asymmetry is
> the "D4 status dual rail" the trackers reference and it is real. The three
> projector trace-arms are `ProgressFactApplier.ts:124-130`,
> `sessionProgressSubscription.ts:76-87`, and `runProgressRenderer.ts:197-199`;
> the recorder is a **fourth** reader and is not a projector — a diff that
> deletes "the three consumer trace-arms" must leave it alone. Re-measure
> before acting on D4.

**Verdict.** Stage 5 landed the emitter but left every shared projector
dual-wired; the design doc's "make updateStreamStatus a projection"
(:826-829) never ruled on the consumer side.

**Options.** (i) Delete the three consumer trace-arms + the emitter guard so
the session fact is the sole cross-process status channel (net −30..−40 LoC),
**and** rule explicitly on the then-consumer-less trace arm: (a) retain as the
per-run SDK contract (a documented bet, tolerating an unconsumed arm) or ~~(b)
delete the arm too~~ (withdrawn 2026-07-25 — the recorder consumes it).
(ii) Status quo — rejected: silent-miss class with
works-in-extension-broken-elsewhere lineage.

**Recommendation.** (i)+(a) — the per-run trace is the natural SDK
subscription shape (§7), but the retention must be argued as that bet, not on
false replay grounds. **Amended 2026-07-25:** (a) is now the only surviving
option and needs no bet — the trace arm has a persistence consumer, so
retention is forced. The atomic-PR constraint below still binds, and the diff
must not touch `TexraTranscriptRecorder`'s arm.
**Constraint:** guard-drop + projector-arm deletion in
ONE atomic PR (both arms currently project onto the same public CLI event —
any dual window duplicates headless NDJSON output, a parity invariant).
**Unblocks:** the "new consumer wires one channel" rule; removes the last
dual-wiring in the fact plane. Rail C (`onDidChange`) stays as the in-process
synchronous rail — do not unify.

#### D5. Rule on the four SDK-surface deltas as one package (TD-2, decision-needed, CONFIRMED)

**Measurement.** The landed quartet (SessionHandle / SessionEventHub /
HostInteractions / AgentRuntimeHost) is ~80% consumer-worthy (qualitative:
the run/config/event/result surfaces pass the embedder test as-is; the four
named residue deltas are the remainder). Four migration
residues an external consumer trips on: (a) 7 doubly-optional request methods
returning `Promise|undefined`, with the `context?.toolEditApprovalHandler ??
platform().toolEditApproval` fallback reachable only via the test-only noop
host (all 4 production hosts implement `requestToolEditApproval` — micro A2);
(b) the `'runFact.'` string-prefix protocol (dated v0.41 in-source); (c) 6 of
11 RuntimeInteraction arms never host-emitted — but reused as CLI-internal
discriminator types at ~20 sites, so narrowing is a **net-neutral relocate**
into CLI-owned types (micro A6), not a −40 delete; (d) three delivery surfaces
for one status fact (= D4). Plus: `SessionHandle.flushers` is a public
mutable `Set`; `hostChannel` is consumed by exactly 2 desktop files.

**Verdict.** All four are deletions or contract-tightening on the existing
surface; none needs a new element. **Recommendation:** ride (a) with micro
A2's staged −300..−450 deletion (re-pin A2's ~10 propagation sites against
post-RunScope origin/main, #7658-#7666 touched the same plumbing); execute (c)
as the relocate; (b) executes at v0.41; (d) = D4. Reconcile (a)'s decline
semantics with A2's throw-prescription before landing. **Unblocks:** IF-1's
6/7 required-member conversion (§4); the honest SDK contract doc. **Trap:**
an SDK facade layer over SessionHandle (R4 new plane; the F6 lesson: +987 LoC,
5 follow-ups).

#### D6. Rule the flow taxonomy: both families are first-class (TAX-1, decision-needed, CONFIRMED)

**Measurement.** Reflection 1,349 LoC + reflection-only ResponseCycleFlow 632;
tooluse 1,492 + toolUseRound 1,418; shared kernel 955 of core/flows' 3,005
(one `ModelInvocationNode`, exactly 2 instantiation sites). Shipped agents: 7
workflow vs 18 tool-use; workflow callable from orchestrators via
`delegate_workflow`; CLI headless batch maps to Workflow. Reflection-exclusive
(corrected — the tool loop DOES have media input at
`ToolUsePrepareNode.ts:96-113`): the LatexMediaManager figure-extraction /
per-round media-reprocessing pipeline, atomic whole-document `<documents>`
output with latexdiff/compile gating + one-shot compile-repair (#7077),
scripted deterministic multi-round userRequests, and non-tool-calling-model
execution. Category branch cost: 93-179 flat lines / 56-82 files; zero per new
provider.

**Verdict.** Reflection is the deterministic batch-document contract, not a
legacy mode; the real overlap is already factored into the shared kernel.

**Options.** (1) Deprecate reflection into "tool-use + edit tools" — rejected:
rewrites 7 shipped + user YAMLs, retires `delegate_workflow` and the CLI run
mode, rebuilds the document-emit path, thousands of net-added lines, and
permanently loses the non-tool-calling-model path. (2) **Both first-class** —
zero migration; record the ruling; fences: new capabilities land in the shared
kernel only; ResponseCycleFlow moves under `implementations/flows/reflection/`
when next touched. **Recommendation:** (2). **Unblocks:** SDK surface docs can
name two run contracts without a unification caveat. **Trap:** a parameterized
super-cycle merging the two loops — it smears contract-level differences
(output atomicity, round determinism, model-capability floor) into flags.

#### D7. Fence the relay: one equality test, one exact pin, one script (S1, decision-needed, CONFIRMED)

**Measurement.** The only money-moving external surface is enforced by
comments whose pointer has rotted across a file split:
`src/auth/sharedConfig.ts:97-102` cites "relay/models.ts lines 143-145" but
tier strings now live in `relay/tierConstants.ts`; `TIER_SPENDING_LIMITS`
{free:10, Max:50, Ultra:300} at `models.ts:167-171` mirrors
`RELAY_TIER_SPENDING_LIMITS` with **zero** equality tests (grep of test-kernel
= 0; yet 3 existing relay suites already vitest-import relay `.ts` directly —
the fix needs no new plumbing). Live skew: relay `deno.json` pins
`npm:llm-zoo@^1.11.0` vs workspace `^1.12.0` — CI exercises 1.12 semantics
against a possibly-1.11 deployment. Zero `supabase` hits in 17 workflows; the
`--no-verify-jwt` requirement is documented (RELAY_SETUP.md:33,135-138) but
encoded nowhere. (#7468 under-billing class: real, closed 07-07.)

**Options.** (a) Minimal fence: one ~30-LoC vitest deep-equal
(sharedConfig ↔ relay exports), exact-pin llm-zoo and bump it in the same PR
as workspace bumps, ~15-line checked-in deploy script wrapping the documented
command. (b) Codegen/shared-JSON — rejected (R4 machinery for 3 constants).
(c) CI-driven deploys — rejected for now (credentialed pipeline).
**Recommendation:** (a). **Unblocks:** deletes the "you MUST also update"
comments' job; makes SDK-era billing drift a CI failure instead of a user
report. **Trap:** treating closed #7468 as an open bug; the codegen float.

#### D8. Give R7 a detector, or amend it honestly (S2, decision-needed, CONFIRMED)

**Measurement.** Post-rulings window (07-07..08): net +16,315 LoC/2 days;
test-kernel +11,467 = 70% of net (+5.7k/day; doubles in ~25 working days at
rate); ~96 merged PRs/day. Detector-vs-judgment split, sharpened by
recomputation: the mechanically-detected rule bent its curve (knip ratchet →
files net **−56**, first time negative); judgment-only rules bend weakly —
correction share 34%→27% (not halved), R7's test budget has no detector while
tests are 70% of growth, and R3's dating target is ~40 rows short (2 of ~44
ledger rows carry future dates).

**Options.** (a) Extend the existing `check-dead-code-ratchet.mjs` pattern
with a per-PR test-kernel LoC budget failing CI absent a stated
Stage-5-acceptance exemption (~60-100 LoC, zero product code). (b) Formally
amend R7 to accept test growth as the Stage-5 acceptance price and stop
pretending the budget exists. **Recommendation:** (a) — the evidence says
detectors bend curves here. Separately: R3's owner dates the ~40 undated rows
this week or fewer-elements records the slip. **Unblocks:** the growth story
for the SDK quarter. **Trap:** reading +8.2k/day gross as "rulings failed" and
launching a consolidation campaign — files went net-negative; the gap is one
missing detector.

### 3.2 Strategic, misshapen — direction set, no decision required

#### M1. One 16-node SCC, zero enforced layering (LAY-1, CONFIRMED)

**Measurement.** §1 map numbers; Tarjan-verified. Layering is ~97% real by
weight but exists only as convention; audit history (layering rounds 1-10:
7-8 fresh violations per pass) proves convention-only defense loses at swarm
cadence. The proven `no-vscode` custom rule shows the ratchet mechanism is
culturally viable. **Verdict:** unfenced, not misdesigned. **Direction
(enforcement-led, zero code motion):** freeze the measured edge list as a
grandfathered baseline (exact from→to pairs, **including** transcript→agent 16
and latex→agent 8, which any honest baseline must name); every NEW
cross-subsystem edge type = CI error; ratchet by deleting baseline entries in
the fix PR; mark the genuinely type-only edges (utils→agent, skills→agent) —
but not telemetry→agent or housekeeping→agent, which are value edges (LAY-3).
**Migration cost:** one eslint-config PR, ~100-150 config lines, 0 prod LoC.
**Trap:** DAG-ification by code motion (agent↔tools and agent↔latex are
accept-and-fence); premature `@texra/core`; heavyweight boundary frameworks.

#### M2. `src/shared` is three subsystems; the progress backend inside it is the graph's largest inversion (LAY-2, CONFIRMED)

**Measurement.** shared = 22,773 LoC: schemas 9,338 (clean, 772 importers,
zero back-imports) + UI kit (~4.4k) + `shared/progressView/backend` 3,386 —
which is host-neutral orchestration matching `controllers/`' declared identity
verbatim and accounts for 22 of the 23 shared→agent imports and all 3
shared→transcript. External prod importers of the backend: ~14 files.
**Verdict:** the single largest top-of-graph inversion; pure relocation to an
existing home that already imports it. Corrected honesty: the move zeroes
shared→agent/transcript and kills the inversion but shared **stays in the
SCC** via shared↔utils/common/logger/platform — the prize is the writable
"shared may not import agent/transcript" zone rule, not SCC exit.
**Direction (deletion-led):** land the `mapToRecord` extraction first
(transcript's only backend import), then relocate backend →
`controllers/progressView` in one atomic PR (~14 prod + 8 test path rewrites);
land LAY-3 item 1 alongside so the inversion doesn't move up one level
(controllers→agent grows 28→~51). **Trap:** a new top-level `src/progress/`
(R4); a three-alias rename campaign (only the backend move removes cycles).

#### M3. The SDK tax is the bootstrap incantation, not the run API (NS-1, CONFIRMED)

**Measurement.** A minimal consumer needs ~20 deep-path module imports and
**9-10 ordered post-`initPlatform` module-global registrations**
(`initPlatform.ts:204-341`: output channel, initNodeAgentRuntime, git author,
usage log, auth, model access, goal prompts, agent-dir bootstrap, skill
sources), three welded to a packaged `resourcesPath`. None discoverable from
types; the ordering trap is documented only in a code comment
(`runExecution.ts:218-224`). Empirical tax: 1,016 LoC bootstrap + 1,675 LoC
per-run plumbing in the CLI. Reference-SDK equivalent: 1 import. The drift is
not hypothetical: the agent-dir bootstrap duplicated across CLI+desktop has
**already diverged** (different `GlobalStateKey`, CLI-only re-entrancy guard),
and desktop silently lacks runtime skill sources entirely — the exact class
`nodeHost.ts`'s own doc comment ("so the hosts cannot drift") was written to
prevent. Contrast fences verified: `runAgent` = 92 LoC, AgentEvent = 20 arms
(recounted at HEAD `4363b4089`, post-pin: 3 arms landed after the
`4b402d75a` review pin), AgentConfigPayload requires only {agent, model} —
the run surface is genuinely SDK-shaped.

**Verdict.** Boundary-completion inside an existing element (`nodeHost.ts`,
142 LoC, already half-owns the sequence). **Direction:** fold the agent-dir
bootstrap into nodeHost (parameterize channel + state key, keep the guard) —
mechanical dedup; the skill-source fold is **not** mechanical (it changes
desktop behavior or needs an opt-out — small product decision first). Acceptance
metric: one embedder smoke test (shared with D2's option B — ONE test, not
two). **Migration cost:** low-moderate; ~40-60 LoC across 2 call sites; net
~0. **Trap:** recreating `@texra/core` now (#7099); `BootstrapConfig`
parameter-object threading (no-deep-injection ruling).

### 3.3 Strategic, covered by existing design — only the delta is new

#### C1. The `defaultSession()` chain is sanctioned; its masking direction is not observed (FB-1, CONFIRMED, covered by session-scoped design + D1 sweep)

**Delta worth keeping:** `currentSession() = tryUseRunContext()?.session ??
defaultSession()` with 9 explicit `??` seams and ~72 direct call lines has
**zero detection** on the masking direction: an internal path that drops
`session:` under a non-default session silently cross-wires to the process
default — the exact shipped micro-A4 class, and desktop is now a genuinely
non-default-session host (`new SessionHandle({hostChannel})` at
`desktopAgentExecution.ts:249`). The design prescribes loud reads for storage
only. **Direction (instrument, don't accelerate):** ~5-10 LoC in
`SessionHandle.ts` — set a module flag when any non-default SessionHandle is
constructed; `defaultSession()` warns once per call-site channel when the flag
is set. Honesty: desktop has legitimate default-session paths through shared
modules — the warns are a triage worklist (which IS the D1 sweep input), not a
pure bug list. **Traps:** deleting `defaultSession()` or making `session`
required across ~72 lines (micro A10: alias load-bearing; measured
parameter-object net-add); throwing instead of warning.

#### C2. SessionStores facade: ~70% landed; the punch list is smaller than believed (DS-1, CONFIRMED, covered by session-scoped design §Persistence + #7246/#6981)

**Delta worth keeping:** (1) goal-forget into the facade via the existing
injected-callback pattern (NOT a direct shared→tools import — that edge
doesn't exist anywhere today and shouldn't be minted); 5 of 8 forget-pairings
removable now. (2) **Genuinely new:** the CLI execution-first delete
asymmetry — `deleteCliHistory` clears only `executions/{id}` + goal entries
while the CLI writes streamLogs/streamData and runs no sweep: sidecars leak.
Fix: `SessionStores.deleteByExecutionId` (+~30 LoC). (3) The reader-corpus'
"KV projections still written" bullet is **stale**: #7246 Decision 1 executed
the tool-use half; the todos freshness arm is #6981-ledgered — do not jump its
D3 trigger (that dual already cost an 8-PR correction tail); reflection's
conversation.json write has 4 live readers — verify coverage before deleting.
(4) Two missing dated rows: index.json pre-KV migration; taskRuns fallback
(one function, one caller). **Trap:** format merge; a retention daemon.

---

## 4. Notable findings

Tighter treatment; same fields (measurement / verdict / cost / direction /
migration / trap). Grouped by theme.

### Topology and graph

**MONO-2 — Alias-map triplication (misshapen).** One conceptual map as three
hand-synced copies: root 44 / extension 39 (missing exactly `@cli/*`,
`@desktop/*`, `@extensionSchemas/*`, `@test/*`, `vscode-jsonrpc/node`) /
desktop 44 (byte-identical). Builds follow only the root (`aliasUtils.mjs:21`
takes `values[0]`; all six build configs consume it); failure mode "tsc green,
esbuild can't resolve" is documented in a comment, checked by nothing. The
dead dual-mapped `@/*` alias has 0 imports repo-wide. `packages/cli` already
proves `extends` works. **Direction:** delete `@/*` from all three maps; make
extension/desktop extend the root (fallback: 20-line sync-check script).
**Cost:** ~85 JSON lines deleted, zero import churn, gated by existing
typecheck+build CI. **Trap:** renaming the lying aliases (`@common/state` →
`@extCommon/...`) — R4 rename churn across hundreds of sites (#7347: 3
correction PRs); MONO-1 R-a solves the honesty problem instead.

**MONO-3 — Shared resources + progress-UI frontend homed in the extension
package (accepted-debt, dated trigger).** `packages/extension/resources` is
consumed cross-package at exactly 8 build-level sites (CLI copy script + 3 dev
fallbacks, electron-builder extraResources, desktop paths, 2 trace-viewer vite
configs); core prod references it 0 times (runtime access via
`AgentDirectoriesPort`). Desktop's main renderer imports the extension's
progress webview wholesale (18 named handlers). Binding constraint: vsce packs
only files under `packages/extension` (machine-enforced by
`verify-extension-package-invariants.mjs` (`REQUIRED_PACKAGED_PATHS`/`findExtensionPackagePath`)). Debt is flat, not
compounding. **Direction:** accept-and-fence with a dated trigger — resources
move OUT in the SAME change that creates the SDK package (first moment a
better home exists); until then list the 8 sites as a comment block in
`copy-resources.mjs`. **Trap:** an assets package now; extracting
`@progressView/frontend` (textbook +94-where-−180-predicted extraction).

**LAY-3 — SCC back-edges are a finite burn-down list (PLAUSIBLE,
corrected).** Honest list: 6 one-file decision edges
(AgentRunLifecycle→onboardingFunnel, ApplyTeamTool→controllers ×3,
gitAuthorSettings→worktreeConfig, nodeHost wiring, model↔auth 2/1,
housekeeping→workflowOutputLayout) + 2 pure type-only fences (utils→agent 3/3,
skills→agent 1/1) + 3 **value** edges needing decisions (logger's `noopTrace`
value import; telemetry→agent Zod-schema/category values; housekeeping→agent
naming helpers — none may ride a "type-only, esbuild strips it" fence) + 2
pair-fences the original list omitted (transcript↔agent 16 imports / 7 files,
latex→agent 8 / 6 files — both value-heavy, both plausibly by-design per the
session-history architecture, both mandatory baseline entries or the M1 lint
cannot be written). ~8 small PRs/decisions total, under one swarm-day.
**Trap:** a `@contracts/` home for the type edges — `src/agent/types` (92 LoC)
already exists if a value must move.

**LAY-4 — Provider-neutral contracts live under provider implementations
(PLAUSIBLE, mechanics corrected).** core→modelHandlers/types: 17 imports / 9
files (15 type-only). But `modelHandlers/types` is NOT pure types: ~55% of its
938 LoC is provider **value** code (ServerToolTypes 513 LoC with ~15
Anthropic/OpenAI parsing helpers, stop-code const maps, a Zod schema +
normalizer) consumed outside modelHandlers. A verbatim move into
`core/contracts` would relocate provider parsing INTO core — worse.
**Direction:** move the 5 files sideways into the existing `src/agent/types`
(already imported by modelHandlers 15× and core 6×), or split type-decls from
value-helpers in the move; then the "modelHandlers may import core, never the
reverse" rule becomes writable with ≤2 grandfathered exceptions. **Cost:**
one PR, 34 importers — but either a name/content mismatch accepted consciously
or a small split with TS init-order care. **Trap:** per-provider packages;
handler-plugin frameworks; touching implementations↔runtime (23/9,
PocketFlow-idiomatic).

### Hosts, runtime, interfaces

**HOST-2 — Per-host interaction registries are the deliberate resting state;
the proposed conformance suite is redundant (accepted-debt).** The port is the
widest per-host obligation (250-650 LoC/impl), and the "unwritten behavioral
spec" premise is false: three per-host suites already assert the exact
semantics (kind-mismatch, cancel selectors, timeout-vs-reject, dispose sweep;
desktop and extension share verbatim test names), plus the ApprovalAdapter
suite. Of the 3 cited bugs only DUAL-9 is registry mechanics. **Direction:**
keep accept-and-fence; downgrade "build a 300-500 LoC conformance suite" to
"optionally parameterize existing suites when touched; add the missing dated
#6981 row for DUAL-9". **Trap:** re-extracting the pending-registry base
(tried, deleted, #7316); a parameterized shared harness across 3 divergent
fakes is itself a mini extraction.

**HOST-3 — Publish the host-obligation surface as four lifetime tiers, never
one options bag (covered-by-design; tier framing is the add).** Verified
tiers: process-frozen `Platform` (16 ports; ~9 host-supplied inputs — not "7
free"); parameter-injected view ports (uiHosts 4/12/128); per-session
`AgentRuntimeHost` (16 event keys, corrected from 18) + HostInteractions (7
kinds); opt-in webview plane (102 actions / 16 groups). Minimal-embed proof:
CLI `initPlatform.ts` = 350 LoC. **Direction:** docs-only addition to
agent-sdk-readiness; the anti-flattening fence is the content. **Trap:** a
flat `RunOptions` superset (no-deep-injection); packaging before the D1/M1
gates.

**TD-3 — `defaultSession()` is permanent-by-economics; declare it and invert
the alias (decision-needed).** 40 occurrences / 24 prod files. The "transitional
shim" costume invites perpetual re-litigation (third audit corpus running);
the deletable debt is the module-level `Shared*`/`StreamStatusService` exports,
not the function. D1 bullet 5 is satisfiable-but-pointless for single-session
hosts (a host-owned explicit SessionHandle at activation would satisfy it with
zero behavior change) — sanction the function instead; invariant becomes "no
session-scoped MUTABLE exported at module level". **Direction:** posture
sentence + micro-A10 inversion (construct singletons inside `defaultSession()`,
delete the exports, 16 call-site edits — a rename-with-alias-retirement, which
R4 classifies as deletion). **Trap:** explicit SessionHandle threading through
every command/tool path.

**IF-1 — HostInteractions: convert 6 of 7 request members to required; the
7th is load-bearing dispatch (covered-by-design; scope correction is the
add).** All 4 production impls implement 7/7; the runtime hard-requires 6 (six
`throw new Error('HostInteractions.X is required')` sites) — the port's
doubly-optional shape misinforms both directions, and the Plane-2 spec already
rules the fix. But `requestToolEditApproval` has NO throw site: its
`undefined` return is the live routing signal to the legacy
handler/platform-port channel (#6890). **Direction:** one mechanical PR for
6/7 (bare Promise returns, noop returns decline arms, delete the 6 throws and
NonNullable gymnastics; −25..−50 LoC); `openExternalInquiry` gets a typed
UnsupportedInteractionError arm; toolEdit stays optional until #6890 retires
the parallel channel — do not fold that into the mechanical PR. **Trap:**
making toolEdit required with a `{accepted:false}` noop — it silently turns
every legacy-channel host's edits into denials.

**IF-2 — Settings IPC: 16 of 106 inbound commands have zero senders
(misshapen).** A dead pull-protocol alongside the live `webviewReady` push
(handler verified: `SettingsViewMessageHandler.ts:242` → `sendAllData`).
16/16 re-verified senderless with key+literal greps, method validated against
a live command; desktop renderer = 0 hits. **Direction:** end-to-end deletion
sweep, ~5 files per command, −200..−400 LoC (shared action functions survive —
they serve the push path); handle the `GET_MEMORY_ENABLED` cross-vocabulary
alias explicitly (delete the settings arm only; MEMORY_VIEW needs its own
census). Re-verify sender census at PR time (swarm cadence). **Trap:** a
generic request/response RPC layer to "activate" the pull protocol.

### Leaked conventions and fallbacks

**MIL-1 — Delivery-envelope tag vocabulary (11 tags) has no owning list;
webview lists have silently drifted (misshapen).** Producers mint tags in 5
modules; `UserMessage.ts` hand-lists 9 (+7-subset for XML escaping);
`claude-agent-result/error` missing from every render list since the tool
merged (37ba7e562) — such messages render as raw entity-escaped XML in a plain
bubble, silently. **Direction:** consume-don't-relocate — one exported
`DELIVERY_TAGS` const (with escaped-subset flag) from a `@shared` sibling of
`subagentFollowup.ts` (NOT `deliveryEnvelope.ts`; src/tools isn't
webview-importable); producers and UserMessage derive from it; the fix ships
as two list entries in the same PR. Net ~0 LoC, ~3 files. **Trap:** a tag
registry with per-tag renderer plugins; forcing the CLI to render all 11 (its
subagent-only terseness is deliberate).

**MIL-2 — Prompt-template token vocabulary triple-listed; one drift is a live
data-corruption bug (misshapen).** `AGENT_RUNTIME_TOKENS` (11 tokens) still
lists retired `ADDITIONAL_INPUTS` and lacks `ALL_CONTEXTS`; the divergent
`WORKFLOW_VARS`/`TOOL_USE_VARS` sit in agentCreatorFlow; **bug (settings
create-from-template path only):** `workflowSingle.yaml`'s bare
`{{ ALL_CONTEXTS }}` renders to empty string at creation time (nunjucks,
throwOnUndefined unset) — every workflow agent created there is corrupted.
The wizard path is unaffected (caller vars win). **Direction:** ship the
one-line `ALL_CONTEXTS` fix immediately; then one exported runtime-token list
from `userVars.ts` (the value owner), both render sites passthrough it, delete
both hand-lists; `throwOnUndefined:true` only after the list provably covers
the full alias family (else silent drift becomes spurious hard failures). Net
~0 LoC. **Trap:** template-linting frameworks; merging the two nunjucks
Environments (the isolation comments are load-bearing autoescape hygiene).

**MIL-3 — Workflow output-naming grammar: 3 frozen eras, 3 partial owners,
~10-11 stray re-encodings across 6-7 subsystems (misshapen, worse than first
measured).** Verified strays include two modules that import the owner and
still hand-build the grammar (taskRunStorage, housekeeping) plus
compiledPdfArtifacts, pack.ts, diffResult label-stripping. A 4th-era change
silently misclassifies everywhere. **Direction:** consume-don't-relocate —
point strays at `parseWorkflowOutputRoundDir` / `workflowOutputPath`; add ONE
tiny exported diff-suffix builder to `diffFileNameManager` (no such export
exists today); treat `fileListingRules` separately (its end-anchored `_r{N}`
grammar has no owner function — widen the owner, don't force-fit
`extractLastRoundMatch`, whose regex doesn't match). Legacy/mid-era grammar
stays read-only. 1-2 mechanical PRs. **Trap:** a unified OutputPathOracle over
all 3 eras — fights the deliberate frozen-strata design.

**FB-2 — SessionFact fan-out: 0 of 4 consumers are compile-loud; the class
already shipped bug A1 (misshapen; strengthened on recount).** All four
switches (ProgressFactApplier, desktop bridge, CLI TUI, CLI headless) silently
drop a new fact (`default: return`, void no-default, or implicit-undefined —
`noImplicitReturns` is off). The in-repo exhaustive-`never` exemplar sits one
vocabulary over (TexraTranscriptRecorder, over AgentEvent). A1 re-verified
live: core emits `removeStream` (`childStream.ts:272`); the desktop bridge has
no arm → persisted snapshot leaks → ghost tab on restore. **Direction:**
propagate the `never`-check pattern into the 4 switches (+15-20 LoC total);
warn-in-default for the 2-3 genuinely-masking AgentEvent defaults; one
CLAUDE.md loud-degradation line. Cheapest per-bug-prevented fix in the audit.
**Trap:** a fact-router/auto-forwarding hub (hosts legitimately ignore facts —
the explicit ignore arm IS the feature); flipping `noImplicitReturns`
repo-wide.

### Engine, storage, tests, delivery

**TAX-2 — Engine dead width: BatchNode's loop and the entire params channel
are provably unused (misshapen).** BatchNode: 21 LoC, one subclass whose
`_exec` override is total, zero direct instantiations — the loop never runs in
production. `setParams` callers outside the engine: zero; `FlowParams`
threads through 18 subclass signatures in 13 files; every persisted FlowRecord
carries `params: {}` in a closed write-read loop. Both external parse sites
are `z.looseObject` and tolerate absence. **Direction:** one mechanical PR —
delete BatchNode (ToolUseDispatchNode extends Node), delete the P generic +
setParams/_params + FlowParams, stop writing the field and make it optional in
the same PR. −80..−120 LoC, zero semantics. Do it **before** any SDK doc
freezes the width. **Trap:** replacing the PocketFlow engine — replay cursor +
retry machinery are load-bearing daily (compile-repair #7077, WAITING resume).

**DS-2 — Goal store: stream-lifecycle data in the preferences Memento
(decision-needed).** The medium mismatch generated the index key, the mutex,
the second lookup surface (`forgetByExecutionIds` — CLI-only), and the
distributed-forget class; unversioned, read-side silent drop (delete-side
self-cleans). **Direction:** rung A = DS-1 item 1 (facade via injected
callback, ~20-40 LoC wiring, −~25 pairing LoC); rung B (relocate to
`streamData/{id}/goal.json`) = a dated decision row tied to SDK packaging —
correctly deferred, correctly priced net-positive-for-one-release. **Trap:** a
generic "stream-scoped Memento namespace with lifecycle hooks" (no other
feature needs it).

**QA-2 — 52 host-side mock sites pin runtime-internal module layout
(misshapen).** 52 sites / 32 suites under
test-kernel/{cli,desktop,frontend,progressView,controllers} target
`@agent/@transcript/@tools/@model`; whole-corpus 306 sites / 104 suites (17%);
`@agent/storage` = 23 sites despite FakePlatform being memfs-backed (the real
module could run against the fake fs). Simultaneously: brittleness under
daily Stage-5 moves, and a free measurement of what the SDK boundary must
export or cut. **Direction:** baseline-ratchet in the existing
check:dead-code-ratchet CI slot — no NEW host-side mocks of those aliases;
convert on touch only (storage→memfs is the biggest win). ~30 lines of
tooling. **Trap:** a TestKit facade (freezes today's internals into a support
API with 32 consumers); a 96-suite rewrite campaign.

**S3 — CLI JSON freeze (R2(3)) remains unexecuted; contortions are live
(covered-by-design; escalation evidence is the add).** Two checkpoint venues
missed; the R2(3) vehicle itself (next minor's changelog) is still open —
no minor has shipped since the ruling. Three 07-08 Stage-5 PRs
(#7574/#7588/#7627) each kept a compatibility adapter alive for the frozen
surface. Note: the frozen fields gate D3 (#6984), not D1 — the tier-3 mapping
(row 11) is what gates D1. **Direction:** put the deprecation paragraph in
[Unreleased] now (= D3 here, §3.1); or record "frozen for SDK-era stability"
in ledger row 33 and re-classify the boundary as an owned public projection.
Either beats the unmade state.

**S4 — Build system: no orchestrator change; two placement defects
(misshapen).** (1) `scripts/desktop-package-targets.mjs` (42 LoC) is dead prod
code kept alive solely by a self-referential test that pins it against
hardcoded literals while production uses the parallel
`inferCodexPlatformKeys` — the "test asserts a cause that can't occur" class.
Delete script + .d.mts + test block; ~−80 LoC. (2) `check:package-contributes`
runs only in release.yml — a drift gate firing at release cut instead of on
the offending PR, at a shop shipping three trains off one commit. Add to
ci.yml (~1 line, ~1-2 min). **Trap:** adopting turbo/nx/moon for a ~15-min
uncached CI; relocating root desktop scripts for ownership aesthetics
(electron-builder resolution is load-bearing).

**S5 — Desktop: the one distribution channel with no update surface
(decision-needed).** No updater, no version check, no staleness signal
(`packages/desktop/src`: zero updater hits) — while electron-builder.yml
already declares the GitHub publish target and the CLI has a full
updateChecker with opt-out. At ~96 shared-core PRs/day, a 3-version-stale
desktop is a materially different product. **Direction:** arm (b) — a
lightweight version-check toast reusing the CLI pattern against the
releases-repo latest tag (~100-150 LoC, no auto-install), sequenced after
Stage-5 close-out; product work, not campaign work. **Trap:** full
electron-updater now — a new externally-consumed feed contract (latest.yml) +
signing/rollback surface minted mid-moratorium, to solve what a toast solves.

**NS-3 — Per-run host ceremony: 265-LoC ordering-sensitive skeleton with 6
paired detaches (covered-by-design; the census + exit metric are the add).**
`runExecution.ts`: 9 ordered steps, 6 paired detaches, nested flush
choreography, a documented "load() must be last or transcripts are lost
entirely" trap; 3 of its 12 core imports are the runtime's own persistence
bookkeeping. Covered by the session-runtime design (§Persistence facade,
`session.transcripts`) + checkpoint row + #7560. **Add:** treat "host run loop
≤ ~40 lines, zero ordering sensitivity" as the acceptance metric to drive
toward (aspirational — ~80 with zero ordering sensitivity also satisfies the
north star). **Trap:** a `runSession()` wrapper over un-migrated internals
(strangler middle; matches the readiness doc's own facade rejection).

**NS-4 — "Load agent X from a YAML" is not a supported public sentence
(decision-needed).** Definitions resolve only through the disk-directory
registry (`loadAgents` → `platform().agentDirectories` scan). Corrections that
make the cheap answer cheaper: an embedder injecting its own
`AgentDirectoriesPort` (custom() → own dir, builtIn() → empty) never needs the
bundled tree at all; and definitions-as-values already exist internally
(RemoteAgentLoader). **Direction:** option (a) — zero code; document
port-injection as the embedding path (including the empty-builtIn trick);
defer (b) agents-as-options until a real external consumer exists.
**Residual unknown:** whether any runtime feature hard-requires a specific
built-in agent name. **Trap:** `defineAgent()` now — a parallel delivery path
with zero consumers that can never delete the directory path.

### Minor findings (compact)

| Finding                           | Key measurement                                                                                                                                     | Verdict / direction                                                                                                                                             | Trap                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| HOST-4 platform-edge accretion    | 4 optional VS-Code-only ports; toolEditApproval sole reader + throw-stub default                                                                    | Ride micro A2 exactly as specified (A2's fix text already deletes the port member + stub + factories); notification-port merge is ~net-zero, do only if in-file | HostCapabilities sub-record                                   |
| TD-5 four streamId module guards  | 4 admission/dedup guards outside the sanctioned process-global list; stream-owned, no reachable cross-session divergence                            | Accept-and-fence, one ledger note; fold into session.runs/followUps on touch                                                                                    | a "finish the globals purge" sweep                            |
| HOP-2 LogMessageData copy         | types-only Zod sibling of StreamLogEntry, never parsed, 16 consumer files, 1 identity-copy fn                                                       | Fold into a derived type; ~−10 LoC; frontend takes `text?: string` honestly                                                                                     | typing `StreamLogEntry.data` as a giant union                 |
| IF-3 AgentDefinition dark fields  | Resolved 2026-08-02: repository definitions use only the current strict schema                                                                      | Removed unused fields, compatibility stripping, warnings, and compatibility-only tests                                                                          | Reintroducing a YAML migration framework                      |
| MIL-4 binary agent category       | 38 literal comparisons / 30 files; schema-owned enum; agentCreator exempt by design                                                                 | Accept-and-fence; record "category is permanently binary" in agent-sdk-readiness                                                                                | predicate farm; folding agentCreator in                       |
| FB-3 config double-defaults       | 28 inline getConfig defaults, 27/28 byte-agree with DEFAULT_CORE_SETTINGS; the 1 drift is retry maxAttempts (micro EP-1)                            | Sound + one CLAUDE.md fence line: inline defaults reference `DEFAULT_CORE_SETTINGS.<path>` or a shared constant                                                 | migrating all 28 to getValidatedConfig; a typed config facade |
| FB-4 compatibility-key sniff tier | key-first ?? Google-gated shape-sniff; read-failure warns, sniff-success traceless; module 115 LoC (~65-90 deletable)                               | Accept + dated #6981 row (calendar, not version — executions/ has no TTL) + 1 `logger.info` when the sniff decides                                              | deleting the sniff now; a persisted-schema-version framework  |
| TAX-3 agentCreator                | 505-LoC host-side YAML wizard, one VS Code caller, zero runtime touchpoints; 15% the size of a real family                                          | Accept-and-fence: OUT of any SDK surface; flatten to a plain fn when touched (−80 LoC)                                                                          | promoting it to a third category                              |
| DS-3 schema governance            | Non-compliance census corrected 5→~1-2 of 12 formats (goal records; config.json version prong); repo converging without the rule                    | One-sentence "born versioned + loud" rule + checklist row (~10 doc lines); drop the census test                                                                 | versioned-store library; standalone census test file (R7)     |
| DS-4 FS stack                     | 1,157 LoC / 8 modules; real class chain is 3 hops (the "5-hop chain" doesn't exist — leaf modules sit on node:fs directly)                          | Sound; fence against unification; two touch-time micro-folds only                                                                                               | injected-FS DI accretion                                      |
| QA-3 R7 is working                | Net −7 suites over 107 merges; all 11 replacement folds rode module deletions; 3.3k pinned cohort died on schedule; expiry-marker adoption = 1 file | Covered-by-design; reviewer nudge: scheduled-scaffolding suites must carry their #6981-row comment                                                              | treating 297 micro-suites as a fold backlog                   |
| QA-4 release-path smoke           | 3-OS signed installers, zero launch verification on any lane; `desktop:package:smoke` built and unwired; validate:pack manual-only                  | Wire smoke into desktop-package.yml per-OS jobs + validate:pack into the CLI lane (~1-3 lines each; gate macOS/Windows if Linux flakes)                         | a full post-release E2E matrix (E2E budget belongs on D2)     |
| S6 ink patch                      | 164 lines, exact-version keyed (loud on bump); zero tracker artifacts state permanence                                                              | Write the permanent-until-upstream ruling into the patch header/proposal; nothing else ever                                                                     | forking ink; re-litigating v1/v2/v3 resize history            |
| NS-5 vocabulary leaks             | StreamTabId: 229 files / 1,593 occurrences, single-sourced; 6 of 11 `show*` arms are dead (micro), live ones die with A2                            | Accept under R4; alias-at-boundary at package time (one line); dead arms ride the micro deletion                                                                | a clean-vocabulary sweep (maximal churn vs in-flight Stage 5) |
| MONO-4 test-kernel carve-out      | All 41+15+2 host-package imports from src/ live in test-kernel (85k-LoC by its own count; design-intentional single kernel)                         | Sound; MONO-1 R-a scopes `ignores: ['src/test-kernel/**']` and must cover @cli/@desktop too                                                                     | relocating/splitting test-kernel (fractures shared fakes, R7) |

**Already covered — existing programs own these; do not re-open:** HOST-1
(desktop-as-second-extension-host: superseded by landed host-contract sharing;
residual instances = micro A1/DUAL-10/EP-4/UICPL-04; the "retire the factory"
decision is vacuous — no factory proposal exists), HOP-3 (representation-count
trend: fewer-elements R1/R4 + DUAL census + the in-code CLI freeze comment own
every scheduled shrink), IF-4 (AgentRuntimeHost emit width: micro A5/A6 own
it; ship IF-1's slice together with A5), NS-2 (tool-edit triple approval
surface: session-runtime Becomes-table + micro A2 + #7633 already name the
precedence and schedule the deletion).

---

## 5. Interface, leakage & fallback registers

### 5a. Contract surfaces

| Surface                | Width                                  | Optionality                                | Ownership                                     | Verdict                                                                       |
| ---------------------- | -------------------------------------- | ------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `HostInteractions`     | 10 members / 7 request kinds           | 7 doubly-optional; 6 runtime-hard-required | port + 4 per-host impls (297/247/321/651 LoC) | convert 6/7 required (IF-1); toolEdit optionality is load-bearing until #6890 |
| `Platform`             | 16 ports                               | 4 optional, contagion = 5 sites            | composition roots per host                    | sound — fence; A2 deletes toolEditApproval member → 14 ports                  |
| uiHosts                | 4 ports / 12 members / 128 LoC         | required at call sites                     | parameter-injected                            | sound                                                                         |
| `AgentRuntimeHost`     | 1 emit / 16 event keys                 | partial-host contract                      | per-session                                   | 6 phantom arms → relocate to CLI types (TD-2c / micro A6)                     |
| `SessionFact`          | 10 arms                                | consumers may ignore                       | SessionEventHub                               | sound vocabulary; 0/4 consumers compile-loud (FB-2)                           |
| Settings host contract | 102 actions / 16 groups                | desktop: 25 explicit `unsupported()`       | one shared handler table                      | sound — the reference pattern                                                 |
| Settings inbound IPC   | 106 commands                           | —                                          | schema union (102 members)                    | 16 dead pull commands → delete (IF-2)                                         |
| Agent YAML definition  | 19 fields (10 settings)                | strictObject + legacy strip                | AgentDataclass                                | lean; 2 dark fields need a dated ruling (IF-3)                                |
| `ITool`/`defineTool`   | 3 members / 4 spec fields / 52 callers | parallelSafe? only                         | ToolTypes.ts                                  | flagship DEEP — ship as-is                                                    |
| CLI JSON/NDJSON        | 22-key rail + 3 `@deprecated` fields   | frozen                                     | sessionProgressSubscription boundary          | start the R2(3) clock (D3)                                                    |
| `texra.*` catalog      | 67 unique ids                          | —                                          | catalog.ts SSOT, satisfies-checked ×2 hosts   | sound                                                                         |
| Relay tier constants   | 3 constants ×2 runtimes                | —                                          | comments (pointer rotted)                     | fence with equality test (D7)                                                 |

### 5b. Leaked conventions (ranked: sites × change-likelihood × silent-failure)

| Rank | Convention                            | Owner?                      | Stray sites                                    | Failure mode                                      | Action                                    |
| ---- | ------------------------------------- | --------------------------- | ---------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| 1    | Template tokens (MIL-2)               | none (3 rotted lists)       | 2 TS lists + N templates                       | **live bug**: silent agent corruption at creation | fix now + one exported list               |
| 2    | Delivery tags (MIL-1)                 | structure yes, tag-set no   | 5 producer modules, 2 render hand-lists        | **live drift**: raw XML rendered silently         | one DELIVERY_TAGS const                   |
| 3    | Output naming grammar (MIL-3)         | 3 partial owners            | ~10-11 strays / 6-7 subsystems                 | silent misclassification on any 4th-era change    | point strays at owners + 1 tiny export    |
| 4    | Legacy STREAM_STATUS                  | tracked (D1)                | 94 refs / 24 prod files                        | two vocabularies on every status PR               | execute Sweep 2 (dated by D3 decision)    |
| 5    | Agent category binary (MIL-4)         | schema-owned                | 38 comparisons / 30 files                      | latent only (3rd value misroutes)                 | one recorded sentence: permanently binary |
| 6    | `ei_` id length (leakage fence check) | hexId12 owner + 1 re-encode | 1 file (`inquiry.ts:23`) + stale owner comment | 2-file edit on length change                      | derive or annotate; fix "8-char" comment  |

### 5c. Fallback-chain inventory

Headline: **6 of 11 inventoried chains mask** (silent on the failure/divergence
path); the loud ones are all in storage/config, the masking ones are all in
session/fact routing.

| Chain                                                         | Loud or masking                                      | Verdict / action                                   |
| ------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `?? defaultSession()` session resolution (9 seams, ~72 lines) | **masking** (zero detection; shipped micro-A4 class) | sanctioned alias; add the 5-10 LoC tripwire (C1)   |
| SessionFact fan-out defaults (4 switches)                     | **masking** (shipped A1, live at HEAD)               | never-checks, +15-20 LoC (FB-2)                    |
| toolEditApproval 3-channel dispatch (`undefined` as routing)  | **masking-adjacent** (precedence in one comment)     | dies with micro A2 + #6890 (IF-1)                  |
| Status dual rail (trace arm vs fact)                          | **masking** (wiring one arm compiles clean)          | D4 atomic completion                               |
| Goal-record reads (safeParse→null)                            | **masking**                                          | DS-2 rung A; version on relocation                 |
| compatibility-key sniff success                               | **masking** (traceless guess)                        | +1 log line; dated retirement row (FB-4)           |
| ExecutionKVStore.readValidated                                | loud (warn + #6966/#7210 citations)                  | fence; fix readChildren's 2-line warn gap on touch |
| getValidatedConfig                                            | loud where it matters (warn iff explicitly set)      | fence                                              |
| StreamLog reads post-#7464                                    | loud + raw-preserving                                | fence                                              |
| Inline config defaults (28 sites)                             | benign (27/28 byte-agree)                            | one fence line; EP-1 already ticketed              |
| CLI input-history line skip                                   | documented lossy-by-design                           | none                                               |

---

## 6. The end-state ledger

What the session-runtime program should now promise honestly, so the next
quarter plans against reality. Ruling per unbuilt promise:

| Promise (fewer-elements / design doc)                    | Status at HEAD                                                    | Ruling                                                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| End-state element census ~26                             | falsified: coordinator fold landed, floor is ~31-33               | **amend §8 to ~32; record "parity, bought correctness"** (D3)                                              |
| Coordinator fold (−4 classes, −5 maps)                   | **landed** (#7316 lineage; grep = 0)                              | done — credit it                                                                                           |
| "Buffer never reimplemented" (design :612)               | false: ExtensionPresentationEventBus has a real 1000-event buffer | keep the buffer; amend the mapping table line                                                              |
| Interaction/presentation vocabulary split (11+5)         | permanent                                                         | keep; narrow the 6 phantom arms via relocate (TD-2c)                                                       |
| HostInteractions conformance obligations                 | 3 per-host suites already encode the spec                         | **drop** the proposed 300-500 LoC suite; parameterize on touch only (HOST-2)                               |
| Required request methods (Plane 2)                       | unbuilt                                                           | build as 6/7 (IF-1); 7th gated on #6890                                                                    |
| CLI 22-key rail deletion                                 | frozen, clock never started                                       | keep rail; **start the 3-field deprecation clock now** (D3/S3)                                             |
| Triple-channel status                                    | live (10 apply-sites)                                             | complete via D4 in one atomic PR                                                                           |
| `defaultSession()` as transitional shim                  | permanent by economics (40 uses / 24 files)                       | **sanction it**; invariant = "no session-scoped mutable module export"; execute micro A10 inversion (TD-3) |
| D1 bullet 5 ("hosts construct sessions explicitly")      | satisfiable but zero-value for single-session hosts               | reword; do not let it stall or fake-close Sweep 2                                                          |
| `ProgressEventPayloads` types-zombie rule                | 4 prod files remain, 0 test refs                                  | on track; enforce at Sweep 1 (#6968)                                                                       |
| 3 host interaction impls + ApprovalRequestHandler replay | justified divergence                                              | keep; fence                                                                                                |
| Four streamId module guards                              | outside the sanctioned global list, no reachable divergence       | ledger note; fold on touch (TD-5)                                                                          |

Net: the honest end-state is **~32 elements at parity with pre-campaign**,
with the campaign's purchase being session isolation, one emit rail, typed
vocabularies, and multi-window correctness. Anyone selling a path to ~26
must name which of the six floor drivers they intend to delete and price it
against the measured extraction economics.

---

## 7. The SDK trajectory

Maintainer decision (2026-07-09): the runtime becomes an **external
(multi)agent SDK**; the VS Code extension, desktop app, and CLI become
reference examples. Everything in this section is sequenced against that.

**Ranked friction list (sdk-consumability area, verified):**

1. **The bootstrap incantation** (NS-1, strategic): ~20 deep imports + 9-10
   ordered untyped registrations, 3 welded to resourcesPath; already drifted
   between hosts. The run API itself is fine (runAgent 92 LoC, AgentEvent 20
   arms — recounted at HEAD `4363b4089`, post-pin: 3 arms landed after the
   `4b402d75a` review pin — 2-required-field config).
2. **The per-run ceremony** (NS-3): 265-LoC skeleton, 6 paired detaches,
   documented ordering traps; the runtime's persistence bookkeeping leaks into
   every host.
3. **Contract residue on the quartet** (TD-2/IF-1): doubly-optional request
   methods, phantom event arms, prefix protocol, triple status channel.
4. **Status dual rail** (HOP-1/D4): a consumer must learn an invisible split
   rule before a working host.
5. **Definitions are never public values** (NS-4): the port-injection answer
   exists but is undocumented.
6. **Vocabulary etymology** (NS-5): StreamTabId as runtime-wide identity —
   cosmetic, alias at package time.

**Sequenced path — each step gated on named preconditions:**

**Step 0 — Enforcement ratchet (now; no preconditions).** MONO-1 R-a
(core→host lint at zero baseline) + LAY-1 edge baseline + QA-2 host-side mock
ratchet + D8's test-LoC detector. All reuse the proven
eslint+vitest+baseline-script patterns; all are config-only. _Existing
trackers:_ agent-sdk-readiness "lint gate" step (the never-built half of
#7099); #7152 for the readiness program. _New decision needed:_ none — these
are the already-ruled gates, finally built.

**Step 1 — Surface definition (gate: Stage-5 interactions/session work
settles, i.e. #6968 Sweep 1 merged).** MONO-1 R-b freezes host deep-import
width per host; the 15-module all-three-hosts intersection is the empirically
derived surface seed. Execute the TD-2 quartet: IF-1's 6/7 required
conversion riding micro A2's −300..−450 deletion; the phantom-arm relocate;
D4's atomic status completion; v0.41 prefix retirement. D2 option B lands the
consumer-contract suite as the **executable** surface definition (one suite,
shared with NS-1's embedder smoke). _Existing trackers:_ #6968 (Stage-5
close-out), #6890 (toolEdit channel), #6982/#6984 (sweeps), micro A2/A5/A6
rows in #7636's follow-up set. _New decision needed:_ ~~the D4 trace-arm
ruling (one paragraph, this week)~~ — settled by fact 2026-07-25: #9127 gave
the trace `'status'` arm a persistence consumer
(`TexraTranscriptRecorder.ts:389-426`), so it is retained. See the D4
amendment.

**Step 2 — CLI as the canonical example (gate: Step 1's port shape frozen).**
NS-1's nodeHost consolidation (agent-dir bootstrap folded; skill-sources fold
behind its small desktop-behavior decision); NS-3's ceremony compression
toward the ≤~40-line host run loop as SessionHandle absorbs
attach/load/flush/toast (the #7560 train); QA-1 option A keeps `validate:run`
green in CI throughout. Acceptance: the embedder smoke test constructs a
working host from documented steps only. _Existing trackers:_ session-runtime
§Persistence bullets (#6966 Stage 3c), readiness checkpoint's runSession
strategic row (as the metric, not the wrapper). _New decision needed:_ the
desktop-skill-sources question (small, product-level).

**Step 3 — Packaging (gate: an actual external consumer exists AND R-a/R-b
have held).** Only now: the barrel seeded from the (by then stable)
intersection; `packages/extension/resources` moves out in the **same change**
that creates the SDK package (MONO-3's dated trigger); NS-5's
StreamTabId alias at the boundary; HOST-3's four-tier publication shape
(never a flat options bag). The #7099 lesson is the standing gate: no package
without the import gate already enforcing its boundary. _Existing trackers:_
agent-sdk-readiness packaging step; #7152. _New decision needed:_ none until
the consumer exists.

---

## 8. Sound structure — fenced

Verified fences (every one independently recomputed under adversarial attack;
corrected numbers folded in). Swarm agents: do not churn these.

- **`tools/` internal layering:** 22 subdirs, zero internal cycles
  (Tarjan-verified twice). No ToolContext facade, no ISP splits.
- **`shared/schemas`:** 9,338 LoC, **zero** real back-imports (in-file
  comments consciously maintain the boundary), 772 importer files. The wire
  contract is clean.
- **Leaf layers:** `types`, `hosts`, `eventBus` have zero outgoing alias
  edges. `src/utils` and `src/common` are vscode-free (the CLAUDE.md
  "utils/config is VS Code-allowed" note is stale doc).
- **`ITool`/`defineTool`:** 3 members / 4 spec fields / 52 caller files / 6
  commits since April; parallelSafe's barrier semantics are documented on the
  member. Flagship deep interface — ship as SDK surface.
- **Platform composition root:** 16 ports, `interfaces.ts` 1 commit since
  April; optional-port contagion = 5 sites total (count both `platform()` and
  `tryPlatform()?.` when re-auditing). Go-forward rule: new optional port ⇒
  documented absence semantics + single consuming helper.
- **Settings write path:** one typed 102-action/16-group handler table
  consumed by both hosts; desktop's 25 `unsupported()` are explicit. No
  works-here-broken-there class. (Corrected: handlers file 533 LoC;
  controllers/settingsView 3,411.)
- **Session-fact fan-out shape:** 10/10/10+5 across shared/CLI/desktop
  projectors — numerically exact; the desktop `removeStream` hole is micro A1,
  disclosed, and FB-2's never-checks close the class.
- **Three-host shape overall:** ~3-5k LoC glue per host, zero core
  duplication; anchors exact (CLI initPlatform 350, desktop platform 226,
  defaults 928). Corrected: 16 event keys, ~9 host-supplied tier-1 inputs.
- **Tool-call payload decode:** ONE owner (ToolUseLogSchema +
  normalizeToolUseData), 4 consumers, zero re-declarations. The
  `data: unknown` + shared-normalizer envelope demonstrably works.
- **Status vocabulary economics:** 6 status-like enums in ONE file with
  single-owner colocated projections — the projections ARE the consolidation;
  merging enums would break scheduled legacy windows.
- **executionId minting:** single owner (`generateExecutionId`/`hexId12`),
  permissive schema = 1-file format changes. Narrowed: the `ei_` namespace
  re-encodes the 12-hex length in `inquiry.ts:23`, and the owner's "8-char
  current" comment is stale — fix both, keep the fence.
- **`texra.*` command grammar:** catalog.ts SSOT, satisfies-checked in the
  extension, runtime-verified in desktop; **67** unique ids (not 79). The
  reference pattern for MIL-1/2/3 convergence.
- **Storage read discipline:** `readValidated` (quiet-on-missing,
  warn-on-corrupt) and `getValidatedConfig` (warn iff explicitly set) both
  hold; `readChildren`'s silent corrupt-drop is a 2-line opportunistic fix.
- **`deriveResumability`:** landed as the single predicate; 10-value cause
  taxonomy; 5 consumers + barrel; no divergent predicate exists.
- **Memento/state layer:** 30 workspace + 44 global typed keys, one registry.
  `restartRepair` genuinely shared by both restart-capable hosts (270 LoC).
  `SessionStores` = 128 LoC, atomic, sweep wired.
- **Test kernel:** FakePlatform 549 LoC memfs-backed + FakeHosts 210; 83% of
  613 suites mock nothing (corrected from 85%); per-merge churn ratio spot
  check exact (0.41 test lines per prod line); real total ~145.7-146.6k LoC
  (not the ledger's ~85k). Architecture ratchet: 5 grep suites (the fifth is
  `agentRuntimeProgressEventsBoundary.vitest.ts`, not
  hostProgressEvents…) + the CI dead-code ratchet.
- **Shared model-call kernel:** 955 of core/flows' 3,005 LoC; one
  ModelInvocationNode, exactly 2 instantiation sites; provider variation flows
  through capability flags only — per-new-provider cost of the two-family
  taxonomy is zero.
- **Agent YAML surface:** 10 settings fields (not 13), all read; legacy strip
  via the CLAUDE.md union pattern at one entry point. Do not "clean up".
- **agent↔tools pair (LAY-5):** tools→agent 160 wholesale is allowed;
  agent→tools pinned to the 13-file wiring baseline, with the 2 core/flows
  imports (CommonCycleTypes→subagentResults,
  ResponseCycleFlow→approvalGatedTools) annotated invert-when-touched, not
  blessed.
- **`src/test-kernel` carve-out:** the sole src/ area importing host packages,
  by design; every future src-side boundary rule carries the one-line ignore.

---

## 9. What NOT to do

The aggregated rejected traps, deduplicated. Each was argued and rejected with
evidence in its area; re-proposing one requires beating the cited grounds.

**Packaging & boundaries.** No `@texra/core` or any barrel before Step 3
gates (#7099: unenforced packages rot; Stage-5 names still moving). No
dependency-cruiser or boundary frameworks (proven eslint+vitest+baseline
pattern suffices). No alias renames (R4; #7347 = 3 correction PRs for zero
element delta). No assets/resources package now; no `@progressView/frontend`
extraction. No relocating or splitting `src/test-kernel`.

**Graph surgery.** No DAG-ification by code motion (agent↔tools, agent↔latex,
transcript↔agent are accept-and-fence pairs). No `@contracts/` subsystem for
type-only edges. No per-provider packages or handler-plugin frameworks. No
breaking implementations↔runtime (PocketFlow-idiomatic).

**Runtime & ports.** No re-extraction of a shared pending-registry base
(tried, deleted, #7316). No `pending()` on the port. No flat RunOptions
superset / BootstrapConfig threading / deep session injection (maintainer
ruling; measured net-add). No `capabilities()`/`supports()` discovery on
HostInteractions; no HostCapabilities record. No SDK facade over SessionHandle
and no `runSession()` wrapper over un-migrated internals (F6 lesson: +987 LoC,
5 follow-ups). No making `requestToolEditApproval` required with a noop
decline (silently denies edits for legacy-channel hosts). No new
status-subscription facade; no session-level synthesized trace; do not justify
the trace status arm on replay/persistence grounds (it has no such readers).

**Vocabularies & data.** No fact-router/auto-forwarding hub (explicit ignore
arms are the feature). No full enumeration forced onto AgentEvent switches; no
repo-wide `noImplicitReturns` flip. No giant discriminated union for
`StreamLogEntry.data`. No status-enum consolidation. No clean-vocabulary
rename sweep (229-file StreamTabId churn). No deleting CLI frozen JSON fields
without the deprecation window.

**Storage & config.** No format merge across the transcript stores; no
retention daemon; no versioned-store library; no standalone schema-census test
file (R7). No jumping the #6981 D3 triggers (the todos dual already cost an
8-PR tail). No deleting the compatibility sniff now; no
persisted-schema-version framework. No getValidatedConfig migration campaign;
no typed config facade. No FS-wrapper unification (~40 importers churned for
net-positive LoC). No deleting `defaultSession()`; no throw in its tripwire.

**Tests & delivery.** No second fake-model system (cassettes/scripted-model
frameworks) — `internalValidationOverride` is the fake provider at the right
boundary. No TestKit harness facade. No fold campaign against the 297
micro-suites. No full post-release E2E matrix (E2E budget belongs on
`validate:run`). No relay codegen/shared-JSON pipeline and no pulling the
relay into the workspace build graph. No turbo/nx/moon. No electron-updater
auto-update now (a toast solves it). No ink fork; no count-based-erase
re-litigation.

**Process.** No new element-reduction campaign to reach ~26 (D3 re-baselines
instead). No reading gross LoC growth as "rulings failed" (files went
net-negative; the gap is one detector). No treating closed #7468 as open. No
single-caller extractions anywhere in the above (standing ban).

---

## 10. Sequenced recommendation

### This week — decisions, zero code

| #   | Decision                                                                                               | Owner / tracker                                                                  |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 1   | R2(3): CLI JSON deprecation paragraph into [Unreleased] (D3/S3)                                        | release PR; #6981 row 33                                                         |
| 2   | Calendar-date D1 in #6982 itself, bypassing the failed checkpoint venue                                | #6982                                                                            |
| 3   | Amend fewer-elements §8: end state ~32, "parity, bought correctness"; fix design-doc :612 buffer line  | 2026-07-07-fewer-elements.md                                                     |
| 4   | HOP-1 trace-arm ruling: retain-as-SDK-per-run-contract (recommended) or delete with the projector arms | **new decision paragraph** on #6968 (no new issue needed)                        |
| 5   | TAX-1 ruling: both flow families first-class; kernel-only capability rule                              | 2026-05-30-agent-sdk-readiness.md                                                |
| 6   | MIL-4 sentence: agent category permanently binary                                                      | 2026-05-30-agent-sdk-readiness.md                                                |
| 7   | TD-3 posture: `defaultSession()` sanctioned; invariant = no session-scoped mutable module export       | 2026-07-03-session-scoped-runtime-architecture.md + #6982                        |
| 8   | QA-1 option A approved (validate:run into ci.yml)                                                      | ci.yml PR — **new, genuinely needs a decision** (no QA-gate row exists anywhere) |
| 9   | S1 option (a): relay equality test + exact pin + deploy script                                         | **new small issue** (no tracker owns the relay surface)                          |
| 10  | S2 arm (a): R7 detector; R3 owner dates the ~40 undated ledger rows                                    | fewer-elements R7/R3; #6981                                                      |
| 11  | S5 arm (b): desktop version-check toast, post-Stage-5                                                  | **new product issue** (surface has no owner)                                     |
| 12  | DS-2 rung B dated row (goal-store medium, trigger = SDK packaging); DS-3 one-line rule + checklist row | #6981; `.claude/skills/code-review/SKILL.md` §13/§14                             |
| 13  | S6 permanence paragraph on the ink patch                                                               | ink-practices proposal / patch header                                            |
| 14  | NS-4 option (a): document port-injection as the embedding path                                         | 2026-05-30-agent-sdk-readiness.md                                                |

Per R4, only three genuinely new issues are warranted (8, 9, 11); everything
else lands as rows, paragraphs, or comments on existing trackers.

### Next — enforcement ratchets (cheap tooling, config-only)

1. MONO-1 R-a: core→host `no-restricted-imports` + vitest lines, zero-violation
   baseline, test-kernel carve-out incl. `@cli/@desktop` (MONO-4). —
   agent-sdk-readiness lint-gate step / #7152.
2. LAY-1 edge baseline: ~100-150 eslint-config lines freezing the ~95 measured
   edge pairs (incl. transcript→agent, latex→agent); new edge type = CI error;
   delete entries in fix PRs. — same PR family as (1).
3. QA-2 mock-baseline ratchet in the check:dead-code-ratchet slot (52 sites
   frozen; convert on touch). — extends #7448's mechanism.
4. D8 test-LoC budget detector (~60-100 LoC in the same script family). —
   fewer-elements R7.
5. QA-1 option A: `validate:run` step in ci.yml (~10 lines). QA-4: desktop
   smoke + validate:pack lines in the release lanes.
6. S4(2): `check:package-contributes` into ci.yml. S1(a): relay equality
   test + llm-zoo exact pin + deploy script.
7. FB-1 tripwire (+5-10 LoC) and FB-2 never-checks (+15-20 LoC) — not
   ratchets, but the same "make masking loud" family; land with the above.

### Then — deletion-led moves (each net-negative or net-zero, no middles)

| Move                                                                            | Size                        | Tracker                                       |
| ------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------- |
| MIL-2 `ALL_CONTEXTS` one-line bug fix (ships first, alone)                      | +1 line                     | new small bug issue — user-visible corruption |
| IF-2 dead settings-command sweep                                                | −200..−400                  | standalone PR                                 |
| TAX-2 BatchNode + params channel                                                | −80..−120                   | standalone PR (before any SDK doc freezes it) |
| S4(1) dead desktop-package-targets script + self-test                           | ~−80                        | standalone PR                                 |
| MONO-2 alias dedup (delete `@/*`, extend root ×2)                               | ~−85 JSON lines             | standalone PR                                 |
| HOP-1 status-rail completion (after decision 4)                                 | −30..−40, ONE atomic PR     | #6968                                         |
| IF-1 6/7 required conversion + micro A2 ride-along (re-pin sites post-RunScope) | −25..−50 (+A2's −300..−450) | #7636 follow-ups / Stage 5                    |
| TD-2c phantom-arm relocate                                                      | net ~0, −6 contract arms    | micro A6 row                                  |
| LAY-2 backend relocation (mapToRecord first; LAY-3 item 1 alongside)            | ~22 path-rewrite files      | standalone PR after Sweep-1 window            |
| LAY-4 types sideways move to `agent/types`                                      | 1 PR, 34 importers          | when-touched or paired with M1 baseline       |
| LAY-3 burn-down (~8 small edges)                                                | sub-PR each                 | fold into touching PRs                        |
| TD-3 singleton inversion (micro A10)                                            | 16 edits, −3 exports        | #6982                                         |
| DS-1 items 1-2 (goal-forget injection; CLI deleteByExecutionId)                 | ~+50/−25                    | #6966 Stage 3c                                |
| MIL-1 tag list + claude-agent fix; MIL-3 stray sweep                            | ~0 net each                 | standalone small PRs                          |
| HOP-2 LogMessageData fold                                                       | ~−10                        | opportunistic                                 |
| NS-1 nodeHost agent-dir fold (skill-sources behind its decision)                | ~net 0                      | Stage-5 / readiness Step 6-7                  |

The through-line: this review found **no rotten core**. The run API, the tool
contract, the schema layer, the test kernel, and the storage read discipline
are sound and fenced. What it found is one unfenced boundary compounding
weekly (D1/M1), one missing capstone test (D2), one accounting fiction (D3),
three unowned grammars with two live silent bugs (MIL-1/2), and a dozen
decisions that cost a paragraph each. Spend the week on §10's table before
anyone writes another abstraction.
