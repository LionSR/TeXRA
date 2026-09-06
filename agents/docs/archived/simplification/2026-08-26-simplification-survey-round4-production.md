# Simplification survey, round 4B: production surfaces

Status: implemented
Archived: 2026-09-06

**Date**: 2026-08-26 · **Net**: -325 LoC · **Findings**: 24 actionable, 8 keep rulings, 0 refuted

## 0. Method

The fourth pass over production code, run alongside [round 4A](./2026-08-26-simplification-survey-round4-tests.md) (the test budget).

Rounds 1-3 swept production by directory, by cross-cutting pattern, and by subsystem architecture. That ground is largely worked out, so this round took four angles none of them could: what the ~10,000 lines of round 1-3 _collapses_ left half-done in the **absorbing** owner, internal repetition **inside** the largest single files, masking catches and silent fallbacks (a defect hunt), and the Zod schema corpus. Six further audits covered dependencies, product surface, build and CI config, the docs tree, prompts and resources, and second-order cascade orphans.

**Read this round for the defects, not the line count.** The net is small — a fourth pass over the same code should produce a small net, and it did. The value is elsewhere: four findings are genuine **defects**, not simplifications.

CLAUDE.md treats these as a first-class bug class: "Silent degradation is a defect. A fallback that masks a failure must be loud — log the cause at `warn` and surface it — or not exist." For those findings the proposal is _make it loud_ (`amend`), never _delete it quietly_. Several therefore have a **positive** net LoC, which is the correct outcome.

|                          | Count  |
| ------------------------ | ------ |
| Findings produced        | 34     |
| **Actionable, verified** | **24** |
| Keep rulings             | 8      |
| Refuted                  | 0      |

Every actionable finding went to an independent adversarial verifier. Surveyors and verifiers deduplicated against a 234-title index of everything rounds 1-3 shipped, refuted, or ruled worth keeping, plus six items that were **overturned at validation** during round 3 and are now policy-protected.

## 1. Findings

| Surface                   | Finding                                                                                                                                                                                                               | Kind        | Risk   | Net LoC  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | -------- |
| `cascade-orphans`         | StreamLogStore.reload/executeReload lost their only production callers in #11452 — now a test-only surface                                                                                                            | delete      | medium | -255     |
| `prod-large-files`        | StreamSnapshotStore: fold the three round-keyed fact mutators (addOutputFiles / updateMissingOutputs / updateCompileFailures) into one table-driven method                                                            | consolidate | low    | -35      |
| `prod-post-merge`         | ToolDefinition.parameters lost its last producer in #11454; the two converter fallback arms are dead                                                                                                                  | delete      | medium | -20      |
| `prod-post-merge`         | SessionHandle restart repair still threads a storage generation that can never change                                                                                                                                 | amend       | low    | -18      |
| `prod-post-merge`         | WorkspacePathSource keeps the lazy-callable arm the storage transition needed, and both remaining lambdas close over constants                                                                                        | delete      | low    | -12      |
| `build-config`            | No-op include/exclude rows in root and extension tsconfigs (excludes that match nothing the include covers)                                                                                                           | amend       | low    | -11      |
| `prod-post-merge`         | Stream approval teardown is split across two owners: forgetStreamAncestry documents a clearing step that lives in its only caller                                                                                     | consolidate | low    | -5       |
| `build-config`            | Four uninvoked npm scripts in packages/agent restate the build.mjs recipe and have already drifted                                                                                                                    | delete      | low    | -4       |
| `prompts-resources`       | The creator retry prompt has three owners and has already drifted: identical 2-line retryPrompt blocks in both agentCreator templates plus a differently-worded DEFAULT_RETRY_PROMPT fallback that is statically dead | consolidate | low    | -4       |
| `dependencies`            | Two stable-stringify dependencies for one job: drop fast-json-stable-stringify onto safe-stable-stringify                                                                                                             | consolidate | low    | -3       |
| `dependencies`            | dotenv: one config() call that process.loadEnvFile now covers                                                                                                                                                         | delete      | low    | -2       |
| `cascade-orphans`         | Four comments still describe the deleted workspace-storage transition as live behavior                                                                                                                                | amend       | low    | -2       |
| `prompts-resources`       | CLI npm bundle ships docs/agent-creation that the CLI host cannot serve to anything — round 1's recorded keep-premise is already refuted by round 2's own evidence                                                    | amend       | low    | -1       |
| `prod-silent-degradation` | OpenAI streaming totalUsage() fallback failure logs at debug, silently under-counting run cost (accounting)                                                                                                           | amend       | low    | 0        |
| `prod-schemas`            | inputHistory persists corrupted timestamps as epoch-0 via Zod .catch(0) on a whole-file-rewritten JSONL                                                                                                               | amend       | low    | 0        |
| `docs-tree`               | texra-cli-checkout.md still claims the repository is not open source and points at a CLAUDE.md section that no longer exists                                                                                          | amend       | low    | 0        |
| `docs-tree`               | The CLI round-trips architecture note's mermaid diagrams cite one renamed and one deleted symbol, contradicting the doc's own prose                                                                                   | amend       | low    | 0        |
| `docs-tree`               | docs/README.md's public-surface summary omits half the published root pages that publicDocs.js declares                                                                                                               | amend       | low    | 1        |
| `prod-schemas`            | Two schema files re-declare vocabularies their documented shared owner already exports (inquiry status enum, line-count field)                                                                                        | amend       | low    | 2        |
| `prod-silent-degradation` | Run-workspace preparation failure is swallowed at debug and its promise has no rejection owner (M1 + crash window)                                                                                                    | amend       | medium | 6        |
| `prod-silent-degradation` | Approval preview readFileWithFallback swallows all read errors without the FNF predicate, silently previewing stale content                                                                                           | amend       | low    | 7        |
| `product-surface`         | Add the missing commandPalette gate for texra.auth.grok.signIn — the one hand-maintained palette row #9709 never wrote                                                                                                | amend       | low    | 8        |
| `product-surface`         | PRODUCT DECISION: changeReviewer is offered in the agent dropdown on every host, but its only reporting channel works solely inside a review started by texra.agentReview.run                                         | consolidate | medium | 10       |
| `dependencies`            | date-fns: a full date library imported for exactly two calls, both natively coverable                                                                                                                                 | delete      | low    | 13       |
|                           | **Total**                                                                                                                                                                                                             |             |        | **-325** |

## 2. Findings in detail

### prod-post-merge

#### ToolDefinition.parameters lost its last producer in #11454; the two converter fallback arms are dead

- **Kind**: delete · **Risk**: medium · **Net**: -20 LoC (proposer claimed -15; verifier figure governs)
- **Files**: `src/shared/schemas/toolDefinition.ts`, `src/agent/modelHandlers/toolConversion.ts`

**Evidence**

#11454 (a2bf9049d1) deleted `toToolParameters` and the `parameters:` write in defineTool (src/tools/core/define.ts), stamping the new rationale "The Zod schema is the tool's only parameter representation". After the merge, `git grep '\.parameters'` over production src/packages finds exactly two reads of ToolDefinition.parameters: the `def.parameters ?? null` fallbacks in convertToolSchema (toolConversion.ts:193) and convertGoogleToolSchema (:245). Producers: zero. defineTool sets only zodSchema; structuredOutput.ts:158 passes {name, zodSchema}; resolveAgentTools now pushes `registered.definition` (registry-owned, always defineTool-built), and normalizeAgentSettingTools reduces YAML declarations to bare `{name}` — so a YAML-carried `parameters` can never reach a converter. Nothing persists resolved definitions: the round-3 verifier confirmed "Nothing serializes a resolved definition… kv.writeRunRecord persists AgentConfig, not AgentSetting, so zodSchema is never lost across a boundary" (round3 doc line 830), and resume re-resolves through executeAgent → runToolUseFlow:180. Defeating the recorded keep-reason: step (5) of the shipped proposal kept `parameters` "purely for definitions that arrive without one" (round3 doc line 835) — that population is now empty, because the same PR's step (2) routed every model-facing definition through the registry, and the reflection family gained the same resolver (resolveWorkflowSettingTools, runReflectionFlow.ts:89). External surfaces checked: ToolDefinition crosses no NDJSON wire and no texra-action field; ToolDefinitionSchema is looseObject, so any old persisted blob carrying `parameters` still validates after the field is dropped — it just stops being typed, and no reader remains. The @texra-ai/agent SDK is fenced and unpublished, so no embedder can be handing converters a parameters-only definition.

**Proposal**

Drop `parameters` from ToolDefinitionSchema, delete both `def.parameters ?? null` else-arms (a definition without zodSchema converts to null exactly as a definition with neither field does today), and fix the stale docstring "Converts a Zod schema to JSON Schema, or returns the pre-converted parameters" (toolConversion.ts:178). Update the handful of test literals that still construct definitions with `parameters` (e.g. ToolConversion.vitest.ts:58) to zodSchema form. Medium risk only because this touches a shared schema; every consumer class was walked above.

**What we give up**

The escape hatch of feeding a provider a pre-converted JSON-Schema tool without a Zod schema. No production path has used it since #11454, and z.fromJSONSchema (already used by structuredOutput) is the sanctioned way back in if one appears.

**Verifier corrections — these override the evidence and proposal above**

1. FACTUAL ERROR: "normalizeAgentSettingTools reduces YAML declarations to bare {name}" is wrong. It converts only STRING entries to {name}; object-form declarations pass through unchanged (src/agent/runtime/agentSettingTools.ts:42-45). The dead-arm conclusion survives anyway because run-time resolution (agentToolResolution.ts) uses only config.name and substitutes the registry's definition, so an object-carried parameters never reaches a converter. 2. MISSED GUARD TEST: src/test-kernel/agent/runtime/agentLoad.vitest.ts:431-466 ("preserves runtime schemas in object-form tool definitions") deliberately pins that parameters survives load; the proposal must trim or delete that pin (it would still typecheck via looseObject's index signature, but it guards the behavior being retired). 3. TEST CHURN UNDERSTATED: beyond ToolConversion.vitest.ts:58 (the READ_FILE_DEF fixture, used 4x as "the baseline shape every provider gets"), parameters-only input defs at ~:484 and ~:507 with the fallback pass-through assertion at :521 pin the deleted arm and need zodSchema rewrites or deletion; src/test-kernel/tools/structuredOutput.vitest.ts:249,254 also construct parameters:{} literals. Roughly 7-8 sites across 3 suites. 4. MINOR: structuredOutput lives at src/tools/structuredOutput.ts (not src/agent/runtime/); the defineTool handoff is at :189-195, with :157 the fromJSONSchema normalization. 5. Consistency note: round3's third read (registry.ts overridesContract:228) was already deleted by #11454, matching the finding's two-read count.

<details><summary>Verifier reasoning</summary>

Verified against origin/main (local main is stale; #11454 merged 2026-08-26). Walked every ToolDefinition producer and consumer: defineTool writes zodSchema only; the two flows are the only paths that hand tools to ModelInvocationNode and both substitute registry-resolved lists; the two convertToolSchema/convertGoogleToolSchema else-arms are the sole production reads and their input population is provably empty. Removing them changes behavior only for a parameters-but-no-zodSchema definition, which nothing can construct or deliver. External surfaces (hosts, SDK, wire contracts, persisted looseObject blobs) all clear. The finding's one wrong claim (normalize reduces objects to {name}) does not change the conclusion because run-time resolution discards object-carried contracts regardless; it does add one guard test to the churn list. Risk stays medium: shared schema edit plus ~8 test sites in 3 suites, all mechanical.

</details>

#### SessionHandle restart repair still threads a storage generation that can never change

- **Kind**: amend · **Risk**: low · **Net**: -18 LoC
- **Files**: `src/agent/runtime/SessionHandle.ts`
- **Note**: Found independently by both the prod-post-merge and cascade-orphans audits ("SessionHandle's repair-generation machinery is frozen at zero: #11452 deleted its only writer"). Merged; the two descriptions agree.

**Evidence**

#11452 (e9ceffbd62) deleted reloadAfterStorageRootChange, the only writer of `storageGeneration += 1`. On origin/main, `private storageGeneration = 0` (SessionHandle.ts:159) has no remaining writer — `git grep storageGeneration` in src/ hits only SessionHandle.ts, and every hit is a read or the initializer. Consequences: (a) `isRepairSuperseded(generation)` (:293-297) — its `generation !== this.storageGeneration` disjunct is statically false, so the function is exactly `this.restartRepairAbort.signal.aborted`; (b) the `generation` parameter threaded through repairStoresAfterRestart and runRestartRepair (checkpoints at :303, :305, :350, :387, :447) is the constant 0 at every call; (c) `restartRepairQueue` (PQueue concurrency 1, :157) + `enqueueRestartRepair` (:270-273) now serialize at most ONE task ever, because `ensureRestartRepair` (:279-286) memoizes `restartRepairPromise` and the deleted reload path was the only other enqueuer. The round-3 survey itself made the keep conditional: step (4) of the workspace-transition proposal says keep `storageGeneration`/`isRepairSuperseded` "only if the restart-repair path still needs them" (agents/docs/archived/simplification/2026-08-26-simplification-survey-round3.md:1256), and the verifier's "ensureRestartRepair still reads storageGeneration" (line 1278) described the pre-merge shape. Post-merge it provably does not need them. Dedupe: `storageGeneration` appears in the round-3 doc only inside the shipped #11452 item; not in the rounds123 index as a keep; the ProgressBackend twin (`ProgressBackend.storageGeneration`) was fully removed by #11452, leaving this the last copy.

**Proposal**

Delete `storageGeneration`, drop the `generation` parameter from repairStoresAfterRestart/runRestartRepair, and collapse `isRepairSuperseded(generation)` to a parameterless abort check (keep every checkpoint — they still guard session-teardown abort, which is real). Replace `restartRepairQueue`/`enqueueRestartRepair` with a direct call inside `ensureRestartRepair`, whose memoized `restartRepairPromise` is already the single-flight guard. Rewrite the two docstrings that still describe the deleted design ("for the current storage generation", "a later storage generation owns the stores").

**What we give up**

The generation fence would have to be reintroduced if a second storage-root-swap path ever returns; the round-3 ruling settled that hosts answer a workspace move with a restart, so that path is closed by policy. The abort-signal checkpoints — the part that still matters — are all kept.

**Verifier corrections — these override the evidence and proposal above**

1. The finding missed a prior dated KEEP ruling: agents/docs/archived/simplification/2026-08-16-define-out-of-existence.md:299 lists storageGeneration as 'refuted-as-deletable and stays (it IS the per-pass cancellation token; supersede lands mid-await)', and 2026-08-16-overdefensive-top10.md:465/:553 lists it among sanctioned defenses. All three predate #11452, which removed the only supersede writer; the amend PR must cite and retire these mentions, not silently contradict them. 2. Line numbers are slightly off against origin/main: isRepairSuperseded spans :293-298 (not :293-297), enqueueRestartRepair spans :270-272 (not :270-273), and the checkpoint list omits the read at :282 (repairStoresAfterRestart(this.storageGeneration) inside ensureRestartRepair) — the last remaining read, which also disappears. 3. 'Round 3 is open as #11452-#11460' is stale: all nine PRs are MERGED as of 2026-08-26; verification must run against origin/main (local main at 91b9b49444 predates #11452 and still shows the old writers — a trap for the implementer). 4. Implementation note the finding should carry: the SessionRestartRepair.vitest.ts:480 'generation recheck' test pins status.getGeneration (StreamStatusMachine per-stream generation), not storageGeneration — do not touch that mechanism. 5. Minor timing nuance: replacing PQueue.add with a direct call starts repairStoresAfterRestart synchronously up to its first await instead of on p-queue's deferred start; safe because ensureRestartRepair runs at the end of the constructor after all read fields are assigned, but worth a sentence in the PR.

<details><summary>Verifier reasoning</summary>

Verified every load-bearing claim against origin/main HEAD (dce7d7e862), since the local checkout predates #11452. Confirmed: (a) storageGeneration has no remaining writer — the += 1 at old :330 was inside reloadAfterStorageRootChange, deleted by merge commit e9ceffbd62 (#11452, merged 2026-08-26T17:38Z), and the ProgressBackend twin is fully gone; (b) isRepairSuperseded's generation disjunct is statically false, reducing it to restartRepairAbort.signal.aborted; (c) the generation parameter threaded through repairStoresAfterRestart/runRestartRepair is the constant 0 at every call; (d) restartRepairQueue + enqueueRestartRepair serialize at most one task ever because restartRepairPromise memoizes and is never reset, and the deleted reload path was the only other enqueuer. Dedupe clean: not in the rounds123 index, not claimed by any other merged round-3 PR, and the round-3 survey's own verifier left exactly this as a conditional follow-up ('keep only if the restart-repair path still needs them' — it does not, post-merge). The one prior KEEP ruling (2026-08-16 define-out-of-existence: storageGeneration 'IS the per-pass cancellation token; supersede lands mid-await') is premised on a supersede path that #11452 deleted, so it is superseded rather than binding — but it must be cited and retired in the amend PR. Confirmed the abort-signal checkpoints being kept are the real remaining guard (teardown at constructor line ~236 aborts them), and that the test suite's 'generation recheck' is the unrelated per-stream status generation. Recomputed net: field (1) + isRepairSuperseded def with docstring (~11) + raw compare at :303 (1) + enqueueRestartRepair helper, queue field, PQueue import (~6) + docstring trims, offset by inlined abort checks staying line-for-line — approximately -18, matching the claim. Risk low: constant-fold refactor, behavior-identical, no test references any deleted symbol.

</details>

#### WorkspacePathSource keeps the lazy-callable arm the storage transition needed, and both remaining lambdas close over constants

- **Kind**: delete · **Risk**: low · **Net**: -12 LoC (proposer claimed -10; verifier figure governs)
- **Files**: `src/platform/defaults/workspaceStorage.ts`, `src/platform/defaults/nodeStorage.ts`, `packages/cli/src/runtime/cliStateStores.ts`, `packages/cli/src/runtime/initPlatform.ts`, `packages/extension/src/extension.ts`
- **Note**: Found independently by both the prod-post-merge and cascade-orphans audits ("WorkspacePathSource's function arm is residue of the retired dynamic workspace source"). Merged; the two descriptions agree.

**Evidence**

Before #11452, WorkspaceStorageProvider stored `getWorkspacePath` and re-invoked it on demand (resolveTargetWorkspacePath) because the in-place transition could move the root under a live provider. #11452's diff collapsed that to one construction-time read: `this.activeWorkspacePath = typeof workspacePath === 'function' ? workspacePath() : workspacePath` (workspaceStorage.ts:172-178), under a new docstring saying the root "is pinned once, at construction". Yet the callable arm survives in three type declarations: `WorkspacePathSource = string | undefined | (() => string | undefined)` (workspaceStorage.ts:28), `NodeStorageProviderOptions.workspacePath` (nodeStorage.ts:34), and `CliStateStoresInit.workspacePath` (cliStateStores.ts:16). Exactly two callers still pass a function, and both are value-equivalent lambdas: the extension's `() => workspace.getWorkspacePath()` (extension.ts:271, invoked synchronously in the constructor two lines before the same value is read directly for createExtensionTexraConfig) and the CLI's `() => cliWorkspaceCwd` (initPlatform.ts:242, one line after `cliWorkspaceCwd = context.cwd` is assigned). Desktop (packages/desktop/src/main/platform/index.ts:76), the SDK (packages/agent/src/node.ts:53), and updateChecker (no arg) already pass plain values. Not in the rounds index; `WorkspacePathSource` appears in none of the three survey docs.

**Proposal**

Narrow all three declarations to `string | undefined`, delete the `typeof === 'function'` branch in the constructor, and pass `workspace.getWorkspacePath()` / `cliWorkspaceCwd` (or `context.cwd`) directly at the two lambda call sites. The laziness was the transition's requirement; keeping the callable shape falsely advertises that a later read could observe a different value.

**What we give up**

Nothing observable — the constructor already collapses the callable immediately, so behavior is bit-identical. A future host that genuinely needs deferred resolution would re-widen the parameter, which is a two-line change made honest by an actual caller.

**Verifier corrections — these override the evidence and proposal above**

1. Caller count 'exactly two' is production-only: a third function-passing caller exists in tests — src/test-kernel/platform/WorkspaceStorage.vitest.ts:103 ('pins the workspace storage root at construction' constructs with () => workspacePath and mutates it after). That test's premise disappears with the callable arm; delete or rewrite it as part of this change. 2) 'Both remaining lambdas close over constants' is imprecise for the CLI: () => cliWorkspaceCwd closes over a module-level mutable `let` (initPlatform.ts:41), not a const — value-equivalence holds only because the assignment at :232 precedes the synchronous constructor read at :242. Also cliWorkspaceCwd stays alive (used at initPlatform.ts:252 and :283), so only the lambda goes, not the variable; pass context.cwd (or cliWorkspaceCwd) directly. 3) Minor line drift on merged main: the construction-time read is workspaceStorage.ts:174-175 (docstring 161-166), extension lambda at extension.ts:271 inside the call at :270-272, and the direct read for createExtensionTexraConfig is at :275 (after, as the finding's phrasing implies). 4) The finding's evidence base (#11452 'open') is now merged; verified against post-merge origin/main (dce7d7e862), where every claim holds.

<details><summary>Verifier reasoning</summary>

Verified against post-merge origin/main since #11452 merged after the local HEAD snapshot. Confirmed: constructor collapses the callable immediately and nothing re-invokes it (resolveTargetWorkspacePath and all commit/rollback machinery deleted by #11452); the callable arm survives in exactly three type positions; production function-passing callers are exactly extension.ts:271 and initPlatform.ts:242, both value-equivalent to direct arguments; desktop, SDK, and updateChecker already pass plain values. No duplicate in rounds 1-3, no dated ruling, no defending comment, no external consumer (SDK unpublished, wire/persisted formats untouched per #11452's own audit), not a ratchet. This is a textbook half-done collapse leftover: the type advertises deferred resolution that the implementation can no longer honor.

</details>

#### Stream approval teardown is split across two owners: forgetStreamAncestry documents a clearing step that lives in its only caller

- **Kind**: consolidate · **Risk**: low · **Net**: -5 LoC (proposer claimed -8; verifier figure governs)
- **Files**: `src/agent/runtime/streamApprovalQueue.ts`, `src/tools/approval/index.ts`

**Evidence**

#11456 (1ea59fa1ee) collapsed the three per-kind ancestry maps into one `parentOf` graph inside createSessionApprovals. Post-merge, `forgetStreamAncestry`'s docstring promises "Direct children are first promoted… preserving their effective values before the torn-down parent's own values are cleared" (streamApprovalQueue.ts:234-238) — but the value-clearing it references is not in the function: it is three `clearForStream` calls in the sole caller, cleanupApprovalsForStream (src/tools/approval/index.ts:79-82: forgetStreamAncestry, then toolEdit/bash/proposal clearForStream). Repo-wide grep: `forgetStreamAncestry` has exactly that one production caller and `clearForStream` exactly those three production call sites plus its definition; no test touches clearForStream. The ordering is load-bearing — clearing a parent's explicit values before its children are promoted would resolve the children's inherited bypasses to false and silently revoke them, the exact trap the round-3 verifier flagged for the graph collapse (round3 doc line 668) — yet it is enforced only by call order in a different file. The `bypasses` array the fold needs is already in scope in createSessionApprovals (:280). Dedupe: the round-3 finding and its verifier discuss registerStreamParent/detach/forget but never propose moving the clearForStream calls; not in the rounds123 index.

**Proposal**

Fold the three per-kind value-clears into the ancestry owner: have forgetStreamAncestry (arguably renamed releaseStream) end with `for (const bypass of bypasses) bypass.clearForStream(streamId)` after promoting children, then drop `clearForStream` from the exported StreamApprovalBypass interface (4 methods → 3) and shrink cleanupApprovalsForStream to cancel-interactions + one session.approvals call. The promote-before-clear invariant becomes unrepresentable outside the module that owns the graph.

**What we give up**

The ability to clear one kind's per-stream value without touching the others — a capability with zero callers today. If a future feature needs it, the per-kind bypass objects still exist internally and re-exposing a method is trivial.

**Verifier corrections — these override the evidence and proposal above**

1. netLoc -8 is optimistic. Removing clearForStream from the exported StreamApprovalBypass interface requires an internal typing adjustment: `bypasses` is typed `readonly StreamApprovalBypass[]` (:294) and createStreamApprovalBypass's return is annotated `: StreamApprovalBypass`, so the internal `bypass.clearForStream(streamId)` call needs either an inferred/wider internal return type or an internal interface (~+1 to +3 lines). Honest tally: index.ts -4 (three calls plus the now-unused `const { toolEdit, bash, proposal }` destructure), streamApprovalQueue.ts -1 interface line +2 loop +1-3 typing, docstring tweaks ~0. Net ≈ -5. 2. The `bypasses` array is at streamApprovalQueue.ts:294 on origin/main, not :280 (the finding's :280 matches neither version). 3. "clearForStream ... plus its definition" undercounts by one: interface declaration (:45) AND implementation (:104). 4. Evidence line refs "streamApprovalQueue.ts:234-238" for the docstring are right for origin/main but the working checkout on this machine was 11 commits behind origin/main and still showed the pre-#11456 three-map shape; the implementing agent must work from a tree containing 1ea59fa1ee. 5. Cosmetic: after the fold, cleanupApprovalsForStream's own docstring ("clears stream-scoped bypass state") and forgetStreamAncestry's docstring both need updating to name the new ownership, and a rename (releaseStream or similar) should also update the interface jsdoc; not counted as LoC but required to avoid recreating the exact comment-drift being fixed.

<details><summary>Verifier reasoning</summary>

Verified against origin/main (true HEAD; local main was 11 commits behind and pre-#11456). All factual claims check out: #11456 merged the single parentOf graph; forgetStreamAncestry's docstring promises "preserving their effective values before the torn-down parent's own values are cleared" but the clearing is three clearForStream calls in the sole caller cleanupApprovalsForStream in a different file; git grep confirms exactly one production forgetStreamAncestry caller, exactly three clearForStream call sites, zero test usage. The promote-before-clear ordering is genuinely load-bearing (clearing parent values first would resolve children's inherited bypasses to false during promotion — the same trap the round-3 verifier flagged at doc line 668, and which the shipped detachStreamFromParent guards with a read-before-delete comment), yet it is enforced only by call order across a module boundary. Folding the clears into the ancestry owner makes the invariant unrepresentable outside streamApprovalQueue.ts and shrinks the exported interface. What is given up (per-kind per-stream clear) has zero callers. No duplicate, no ruling, no external consumer, no ratchet. Only correction of substance is the LoC estimate (-5, not -8) due to the internal typing needed once clearForStream leaves the public interface.

</details>

### prod-large-files

#### StreamSnapshotStore: fold the three round-keyed fact mutators (addOutputFiles / updateMissingOutputs / updateCompileFailures) into one table-driven method

- **Kind**: consolidate · **Risk**: low · **Net**: -35 LoC (proposer claimed -45; verifier figure governs)
- **Files**: `src/transcript/StreamSnapshotStore.ts`

**Evidence**

src/transcript/StreamSnapshotStore.ts:920-1000 — three private methods, 80 lines, structurally identical: each runs parseRoundPatch (with a per-field Zod normalizer), early-returns on an empty patch, then calls mutateWithOverlay(stream, <field>, patch, mergeRoundPatch, applyRoundPatch((r)=>r.<field>,...), writeRoundKeyedField(stream,'<field>')). jscpd flags 925:50-933:14 vs 976:54-984:14 as an exact clone; the third copy differs only by field name and schema. The only differences are (a) the overlay key, and (b) the normalizer: OutputFileInfoListSchema with empty→null (:927-931), z.array(z.string()) keeping [] (:951-952, deliberate — an empty missing-outputs list clears the round via applyRoundPatch's null-vs-value branch at :834), CompileFailureSchema.array() with empty→null (:978-982). All three are private with exactly one caller each: the run-fact switch arms in attachSessionEvents at :656-663. writeRoundKeyedField (:843) already takes the 'outputFiles'|'missingOutputs'|'compileFailures' union and OVERLAY_TO_SIDECAR_KEY (:245) already tables the field→sidecar mapping with a satisfies guard. Dedupe checked: rounds123-index has no entry for these symbols (adjacent shipped items are the workspace-snapshot hydration collapse and the skipProgressViewClear/clearMissingOutputs deletion — different code); round-3 KEEP 'do not merge the twin stream stores' concerns the store split, not this in-file triple; grep of docs/proposals/2026-08-25 and 2026-08-26 survey docs for mutateWithOverlay/writeRoundKeyedField/updateMissingOutputs/addOutputFiles: no proposal hit (only a round-2 aside naming updateMissingOutputs as a channel).

**Proposal**

Add a module-level ROUND_FIELD_NORMALIZERS table typed { [K in 'outputFiles'|'missingOutputs'|'compileFailures']: (raw: unknown) => ElementOf<K>[] | null } holding the three existing normalize closures verbatim (preserving the empty→null vs keep-[] difference per field — the missingOutputs [] is load-bearing: it overwrites the round instead of deleting it), then replace the three methods with one generic applyRoundFieldFact(stream, field, filesByRound) that does the parse/early-return/mutateWithOverlay sequence once, reading the normalizer and record field by key. The three switch arms in attachSessionEvents each call it with their field literal. No public surface changes; the suite at src/test-kernel/transcript/StreamSnapshotStore.vitest.ts drives these through session facts and stays untouched (zero new tests per Testing discipline).

**What we give up**

The per-field methods stop being individually greppable by name; a reader must resolve one generic through the normalizer table. The mapped-type plumbing for K→element type costs a few lines of type machinery inside the file.

**Verifier corrections — these override the evidence and proposal above**

1. Line span/count: the three methods occupy :920-996 (77 lines), not "920-1000 / 80 lines". 2) Evidence phrasing error: "an empty missing-outputs list clears the round via applyRoundPatch's null-vs-value branch at :834" is wrong in mechanism — the [] from z.array(z.string()).parse takes the VALUE branch (:834 assigns rounds[round] = []), i.e. it overwrites the round with an empty list; only null (never produced by this normalizer) takes the delete branch (:833). The proposal's own restatement ("it overwrites the round instead of deleting it") is the correct one; the fold must preserve it verbatim, as proposed. 3) Net LoC: -45 is optimistic. Deleting 77 lines but adding: a documented 3-entry normalizer table (~14 lines), the K→element type mapping (~3 lines, derivable via OverlayPatches[K] extends Map<number, (infer T)[] | null>), and one documented generic applyRoundFieldFact (~22 lines); switch arms stay same length. Honest net is about -35. 4) Minor: applyRoundPatch has a second live consumer group at :2085-2091 (post-hydration overlay replay) that must stay — the fold covers only the fact-mutator triple, not that replay.

<details><summary>Verifier reasoning</summary>

The duplication is real and mechanical: three private methods differing only in field literal and normalizer closure, each called from exactly one switch arm, with the field-union plumbing (writeRoundKeyedField's union param, OVERLAY_TO_SIDECAR_KEY satisfies-table, uniform Map<number, T[] | null> overlay types after the shipped clearMissingOutputs collapse) already in place — the codebase has been converging toward this fold across #9590 Stage 5 and the round-2 cascade, and the in-file mergeRoundPatch doc endorses the shared-shape premise. No naming ruling, wire contract, or open/merged PR claims this territory. The one behavioral subtlety (missingOutputs keeps [] while the other two map empty→null) is preserved by carrying the normalizers verbatim in the table, and the suite pins behavior through session facts, unchanged. Risk is low: single file, private surface, type machinery is straightforward mapped types over an already-uniform shape.

</details>

### prod-silent-degradation

#### OpenAI streaming totalUsage() fallback failure logs at debug, silently under-counting run cost (accounting)

- **Kind**: amend · **Risk**: low · **Net**: 0 LoC
- **Files**: `src/agent/modelHandlers/openai/modelHandlerOpenAI.ts`

**Evidence**

modelHandlerOpenAI.ts:417-429: when the streamed final response carries no usage, `stream.totalUsage()` is the fallback; its catch logs at `this.logger.debug('totalUsage() fallback failed; usage unavailable', ...)` and leaves usage unset. Downstream, ModelHandler.extractNormalizedResponse (src/agent/modelHandlers/ModelHandler.ts:1240-1247) maps null usage to `usage: undefined`, so no NormalizedUsage is recorded for the round and RunUsageAccumulator totals (src/agent/core/usage/RunUsageAccumulator.ts) silently omit the round's tokens and cost. The site's own comment says the log exists 'so missing token accounting is traceable' — at debug level it is not traceable in production logs, defeating the comment's stated purpose. Checklist section 15 flags sub-warn logging where the degrade zeroes usage, and the surface brief weights accounting. Dedupe: no rounds-index or survey-doc entry mentions totalUsage; round-1 item 51 (log-usage wire fields) and round-2 item on computePrice are unrelated to this seam.

**Proposal**

One-word amend: raise the log to `warn` (keeping the structured error data), honoring the comment's own intent that missing token accounting be traceable. The degrade itself (usage stays unset rather than fabricated) is correct and stays — this is a loudness fix, not a behavior change. Optionally note the abnormal-stream-end condition in the message so support can correlate with the retry that usually follows.

**What we give up**

Give up if the maintainer rules the abnormal-stream-end case is always accompanied by a louder failure elsewhere (handleStreamingFailure at :438 classifies genuine stream errors — but the totalUsage catch is reachable on streams that completed enough to yield a final response, where no other error surfaces), or that debug is the deliberate level for all handler-internal fallbacks.

**Verifier corrections — these override the evidence and proposal above**

1. "At debug level it is not traceable in production logs" is overstated: writeLine (src/logger/logUtils.ts) writes the message line to the Agent output channel UNCONDITIONALLY — there is no level filter on the message; only the structured data payload is gated by texra.logger.debugMode. What debug actually loses is (a) the persisted run-transcript entry — shouldEmit in src/transcript/TexraTranscriptRecorder.ts:91-95 drops debug unless debugMode — and (b) the error cause on the channel. The finding is right for the persisted record, wrong for the live channel. 2. Checklist §15's "No downgrade below warn ... zeroed usage" bullet is scoped to resume/persisted-state READ failures; this is a provider-stream boundary, so cite the CLAUDE.md silent-degradation guardrail ("log the cause at warn and surface it") instead. 3. this.logger is an AgentTrace (TraceEmitter), not a host logger; raising to warn also changes progress-view/CLI severity rendering and adds the entry to the persisted transcript — slightly more than a "loudness" tweak, still behavior-neutral for the run. 4. History nuance: the site survived two dedicated error-logging passes (#5506 introduced debug, #6886 kept it) — not a ruling, but the maintainer question in "what we give up" is live. 5. Noise caveat: an OpenAI-compatible provider that never sends usage would warn every round; each warn corresponds to a real per-round under-count, so frequency matches actual accounting loss.

<details><summary>Verifier reasoning</summary>

The masking is real and the amend is the minimal correct fix. Verified end-to-end: catch at modelHandlerOpenAI.ts:417-429 leaves usage unset; extractNormalizedResponse maps null usage to undefined; RunUsageAccumulator omits the round with no user-visible signal. include_usage: true is always requested, so the catch is reachable only when the provider genuinely returned no usage — every firing is a true under-count of run cost, the exact accounting-degrade class the surface brief weights. The comment's stated purpose (traceability of missing token accounting) is defeated where it matters most in this repo's diagnostic practice: persisted streamLogs (the MEMORY-documented post-hoc diagnosis path) never receive debug entries by default, and the error cause is suppressed even on the live channel. Raising to warn puts the entry in the transcript, surfaces severity in progress views, and un-gates nothing sensitive. The degrade itself (no fabricated usage) correctly stays. One-word change, net 0 LoC, no contract impact.

</details>

#### Run-workspace preparation failure is swallowed at debug and its promise has no rejection owner (M1 + crash window)

- **Kind**: amend · **Risk**: medium · **Net**: 6 LoC (proposer claimed 8; verifier figure governs)
- **Files**: `src/agent/implementations/flows/reflection/output/outputFileExtraction.ts`, `src/agent/implementations/flows/reflection/runReflectionFlow.ts`, `src/agent/implementations/flows/reflection/output/snapshotResolution.ts`

**Evidence**

runReflectionFlow.ts:171 assigns `outputState.runPreparation = fileService.prepareRunWorkspace(...)` with no `.catch` attached; the ONLY awaiter is prepareRunWorkspaceIfNeeded (outputFileExtraction.ts:33-49), which runs minutes later inside extractFilesFromXml (:151) after the model call. Two defects: (a) the catch at :41-45 logs `deps.logger.debug('Failed to prepare run workspace', ...)` and continues, and the finally at :47 sets `state.runPreparation = null`, so a failed preparation is never retried and never surfaced above debug; (b) between assignment and the lazy await, a rejection is an unhandled promise rejection — grep shows the only global `process.on('unhandledRejection')` handlers are packages/extension/src/extension.ts:163 and packages/desktop/src/main/fatalStartupError.ts:34/84 (startup window only); packages/cli has none, so on the CLI (Node default --unhandled-rejections=throw) a disk-full/EACCES during preparation crashes the process mid-run. Consequence of the swallow: taskRunStorage.captureOriginalSnapshot (src/utils/files/taskRunStorage.ts:96-117) deliberately throws on non-ENOENT failures, and snapshotResolution.ts:1-9 documents that a missing `original/` snapshot makes in-place workflows diff live-vs-live yielding 0/0 stats — resolveBaseFilesForDiff (:18-38) silently passes the live path through when the snapshot is absent, so the wrong-diff has no visible cause. Dedupe: rounds index has no entry for this seam; 2026-08-25 survey lines 901-913 discuss deleting setActiveRun's dead `runPreparation = null` reset (a different, refuted-adjacent shape) and line 983 confirms prepareRunWorkspaceIfNeeded is a no-op only in tests. No in-code comment defends the swallow — the docstring only says it 'waits for workspace preparation', not why failure is safe to ignore.

**Proposal**

Make it loud, not delete it (M1 -> loud read + rejection owner): (1) at runReflectionFlow.ts:171, attach a synchronous rejection observer that records the failure into outputState (e.g. `runPreparation.catch(err => { state.runPreparationError = err; })` folded into the stored promise) so the CLI/desktop never hit the unhandled-rejection crash; (2) in prepareRunWorkspaceIfNeeded, raise the log to warn with the cause and emit through the run's existing warn surface (the same recoverWarn channel OutputNode already uses at its :95 tryOperation), so an un-snapshotted run and its coming 0/0 diffs are attributable; keep the continue-without-workspace behavior itself — extraction can still salvage the model's output, which is the fallback's legitimate half.

**What we give up**

Give up if the maintainer rules that prepareRunWorkspace failures are practically ENOENT-only (captureOriginalSnapshot already swallows ENOENT, so a rejection requires EACCES/ENOSPC/mkdir failure) AND that hosts are expected to install global rejection handlers instead; or if a planned reflection-flow rework replaces the lazy-await seam entirely.

**Verifier corrections — these override the evidence and proposal above**

(1) Desktop is NOT 'startup window only': packages/desktop/src/main/fatalStartupError.ts:21 installPostStartupRejectionHandler is installed for the whole app lifetime at packages/desktop/src/main/bootstrap.ts:14, and it FORCE-QUITS the app on any post-startup unhandled rejection ('TeXRA hit an unrecoverable error after startup and must close', forceQuit: true). So on desktop the current code turns a preparation failure into a full app quit mid-run — the crash-window half of the finding is stronger than claimed, but the evidence sentence citing fatalStartupError.ts:34/84 as startup-only is factually wrong. Only the extension host (extension.ts:163 report) merely logs. (2) Proposal mechanics bug: 'folded into the stored promise' would make prepareRunWorkspaceIfNeeded's await never reject, dead-coding the very catch being upgraded to warn. Correct shape: keep the stored promise unfolded and attach a side observer (e.g. `const p = fileService.prepareRunWorkspace(...); outputState.runPreparation = p; void p.catch(() => {})`), or record the error into state and have prepareRunWorkspaceIfNeeded read it — either way the lazy path must still observe the failure to warn loudly. (3) Anchor provenance: the kickoff at runReflectionFlow.ts:171 is post-#11457 (merged); the filed issue should cite #11457 as the commit that inlined setActiveRun, and cite agents/docs/archived/bug-fix/2026-01-30-code-review-fixes.md §4 as superseded context so a reviewer does not conflate the two. (4) Minor: OutputNode's recoverWarn call is at nodes/OutputNode.ts:93-103 (tryOperation at :93, recoverWarn at :102), not exactly :95.

<details><summary>Verifier reasoning</summary>

Every load-bearing fact re-derived from HEAD: bare promise assignment with a single lazy awaiter, debug-level swallow with no defending comment or ruling, real non-ENOENT rejection paths, no CLI rejection handler (crash), desktop handler that force-quits (worse than claimed), and the documented 0/0-diff consequence of a missing snapshot with no attributable cause. Not duplicated by #11457 or any round 1-3 item, not protected by the 2026-01-30 PRD (which governed the deleted GC-reset only), and the fix direction (loud warn + rejection owner, keep continue-without-workspace) matches both the M1 loudness doctrine and the existing recoverWarn surface one level up. The two evidence errors (desktop handler scope, fold-vs-side-observer) change the mechanics of the fix but not its necessity.

</details>

#### Approval preview readFileWithFallback swallows all read errors without the FNF predicate, silently previewing stale content

- **Kind**: amend · **Risk**: low · **Net**: 7 LoC (proposer claimed 5; verifier figure governs)
- **Files**: `src/tools/approval/latexPreview.ts`

**Evidence**

latexPreview.ts:124-133: `readFileWithFallback` catches every error (`.catch(() => fallback)`) — no isFileNotFoundError distinction, no log, no comment saying why failure is safe. Callers: :209-212 (previewProposedLatex) and :240-243 (runLatexdiff). The read exists to pick up the user's hand edits to the temp proposal files that tempFileManager.ts:55-68 wrote for this approval; on EACCES or a cleanup race the preview/diff silently renders the original in-memory `entry.proposedContent`/`entry.originalContent` instead — the user approves against a preview that dropped their edits, with zero trace. The checklist bullet is explicit: 'A catch defaulting a persisted read must distinguish isFileNotFoundError from everything else. ENOENT->default is fine; EACCES/corrupt-JSON->default is masking.' The apply path is independently loud (src/controllers/approval/ToolEditApprovalController.ts:356-360 reports 'Approval failed because the edited document could not be read'), which bounds the damage to the preview surface — hence low risk, but the site is an undocumented M2 on the approval surface the brief weights. Dedupe: no rounds-index entry or survey-doc mention of readFileWithFallback or latexPreview.

**Proposal**

Amend, not delete: keep the fallback for isFileNotFoundError (a settled/cleaned entry racing the preview is genuinely benign), and for any other error either route through the entry's existing loud channel (`entry.onError`, already used by withLatexOperation at :118) or at minimum log.warn with the path and cause before falling back. Add the one-line best-effort comment the checklist requires stating why FNF is safe.

**What we give up**

Give up if the maintainer rules the temp files are so short-lived that non-ENOENT failures are unobservable in practice, or prefers to delete the disk re-read entirely and always preview the held content (which would also end the silent divergence, at the cost of dropping the hand-edit affordance — that choice is theirs, not this audit's).

**Verifier corrections — these override the evidence and proposal above**

Minor only. (1) The controller apply-path error report is at ToolEditApprovalController.ts:349-360 (reportError at ~357), not exactly 356-360 — same code, off-by-a-few citation. (2) Nuance the finding misses but that does not weaken it: the approve path reads via entry.preview.readProposedContent() (can capture the live editor document), while the preview path reads the saved temp file from disk — so the preview only ever reflects _saved_ hand edits regardless; the masking issue is strictly about non-ENOENT read failures silently dropping saved edits. (3) Claimed net 5 LoC understates slightly: FNF predicate branch + debug/warn log + best-effort comment + @common/errors import is ~+7 lines, a net ADD — fine here because this is a loudness amend on the masking-catch surface, not a LoC-reduction claim. (4) Supporting evidence the finding didn't cite: the same file already follows the loud best-effort convention at silentDelete (:66-69) and registerCleanup (:93-98), both with a why-safe comment and a debug log; readFileWithFallback is the lone silent outlier, making the amend a consistency fix, not a new pattern.

<details><summary>Verifier reasoning</summary>

No dedupe hit (rounds index and survey docs clean; doc mentions of latexPreview.ts are about the openBuildDisplay DI seam only). No dated ruling. The catch carries no why-failure-is-safe comment — only a behavior docstring — so kill-criterion 3 fails; the file's own sibling helpers (silentDelete, registerCleanup) demonstrate the expected loud pattern. Checklist §15 bullet verified verbatim at review-checklist.md:141. Mechanism verified end-to-end: proposedUri.fsPath = writeApprovalTempFiles output (controller :185), so the disk re-read exists to pick up saved hand edits and a swallowed EACCES/race silently previews content without them; apply path is independently loud, bounding damage to the preview surface. isFileNotFoundError and entry.onError both exist, making the amend mechanical. Only open PR (#11326) is unrelated.

</details>

### prod-schemas

#### inputHistory persists corrupted timestamps as epoch-0 via Zod .catch(0) on a whole-file-rewritten JSONL

- **Kind**: amend · **Risk**: low · **Net**: 0 LoC
- **Files**: `packages/cli/src/chat/tui/history/inputHistory.ts`

**Evidence**

packages/cli/src/chat/tui/history/inputHistory.ts:17 `const HistoryRecordSchema = z.object({ t: z.number().catch(0), v: z.string() })` parses the persisted per-user JSONL history file. This is exactly the persisted-data .catch trap: a record whose `t` is corrupted validates to 0 silently, and `serializeRecords` (:38-40) rewrites the ENTIRE file atomically on every compaction (push path, :74-80), making the substitution permanent. The file's own docstrings defeat the tolerance: the header (:1-5) states the policy is 'the session reader skips malformed lines silently', and serializeRecords' comment says records keep their original timestamp specifically 'in case anything ever reads the file externally' — .catch(0) violates both by fabricating a timestamp instead of skipping the row. loadInputHistory (:43-57) already has the skip mechanism (`parseJsonWith(...).unwrapOr(undefined)`), so a strict `t: z.number()` degrades a corrupt row to a skipped row with zero new code. Dedupe: not in rounds123-index.md (grepped inputHistory/HistoryRecord — zero hits); IS already recorded as a confirmed 'Partial — real problem' lead in agents/docs/archived/simplification/2026-08-07-prod-structural-leads-triage.md:26-29 with the same fix spec ('drop .catch(0) so a record with a corrupt timestamp fails validation and is skipped by the existing unwrapOr(undefined) line-skip'), and verified still unfixed on HEAD today — this finding consolidates into that record rather than filing anew.

**Proposal**

Change line 17 to `t: z.number(), v: z.string()` (delete `.catch(0)`). A record with a missing or corrupt `t` then fails HistoryRecordSchema, is skipped by the existing `unwrapOr(undefined)` line-skip in loadInputHistory, and is therefore dropped from the next compaction rewrite instead of being rewritten with a fabricated epoch-0 timestamp — matching the file's documented malformed-line policy. Do NOT delete the `t` field itself: the JSONL is a persisted user file whose format the serializeRecords docstring reserves for external readers. Consolidate with the open 2026-08-07 triage entry (line 26) rather than filing a new issue.

**What we give up**

The `v` text of a line whose timestamp bytes were corrupted is no longer salvaged into history (previously kept with t=0); it is skipped like any other malformed line. Nothing in production reads `t`, so no behavior beyond that one recovery path changes.

**Verifier corrections — these override the evidence and proposal above**

Minor precision issues, none fatal: (a) The .catch(0) is only reachable for a line that is syntactically valid JSON with a valid `v` but a missing/non-number `t` — the header's partial-write scenario (torn line) already fails JSON.parse and is skipped by unwrapOr, so the practical exposure window is narrower than "corrupted timestamps" suggests. (b) The substitution becomes permanent only when a compaction rewrite actually fires (history exceeds MAX_LINES=1000 on push); ordinary pushes append and a plain load never rewrites. (c) Triage entry is at lines 26-28, not 26-29. (d) `.catch` also fires on a missing `t` (making the field effectively optional-with-default today), so the strict schema additionally drops records that omitted `t` entirely — same skip outcome, worth stating in the amend.

<details><summary>Verifier reasoning</summary>

The finding is factually verified against HEAD: line 17 carries the .catch(0), serializeRecords (:38-40) rewrites the whole file on compaction (:72-80 via writeAtomic, added in #11017), and loadInputHistory's parseJsonWith(...).unwrapOr(undefined) (:48-50) already implements the documented skip-malformed-lines policy, so a strict `z.number()` degrades a corrupt row to a skipped row with zero new code. This is the exact persisted-data .catch trap CLAUDE.md and the review checklist name explicitly, on a low-stakes surface (nothing in production reads `t`, so risk is genuinely low). The finding's dedupe work is honest and correct: it found the pre-existing 2026-08-07 triage record with the identical fix spec and shaped itself as an amend/consolidation rather than a new filing, which is the right disposition. The give-up (corrupt-t rows no longer salvaged with a fabricated epoch-0 timestamp) is accurately stated and aligned with the file's own documented policy.

</details>

#### Two schema files re-declare vocabularies their documented shared owner already exports (inquiry status enum, line-count field)

- **Kind**: amend · **Risk**: low · **Net**: 2 LoC (proposer claimed 0; verifier figure governs)
- **Files**: `src/tools/inquiry/externalInquiryStorage.ts`, `src/shared/schemas/inquiry.ts`, `src/shared/schemas/workflowScriptDelivery.ts`

**Evidence**

(a) src/shared/schemas/inquiry.ts:31 declares `InquiryThreadStatusSchema = z.enum(['open','answered','dropped'])` (only the inferred type is exported, :32). src/tools/inquiry/externalInquiryStorage.ts:98 re-declares the identical `z.enum(['open','answered','dropped'])` inline in the persisted manifest's ManifestBaseShape — in a file that already imports `type InquiryThreadStatus` from the shared module (:18) and types its query filter with it (:580). A status added to the shared enum would be silently rejected by the persisted-manifest parser. (b) src/shared/schemas/lineChanges.ts:7 documents `LineCountSchema` as 'shared by tool results, approvals, and output diff statistics'; prompts.ts:34-35 and output.ts:171-172 (`added: LineCountSchema.nullable()`) both consume it, but sibling workflowScriptDelivery.ts:5-6 hand-spells the identical `z.int().nonnegative().nullable()` for the same added/removed semantics. Both are drift-guard reuse fixes, not new abstractions — the owners already exist and are already documented as owners. Dedupe: rounds123-index.md grepped for InquiryThreadStatus/externalInquiryStorage/WorkflowScriptDelivery/LineCountSchema — zero overlapping items; round 2's shipped ToolResult.lineChanges deletion (survey-round2.md:747) explicitly preserved LineChangesSchema/LineCountSchema as the surviving owners, which this finding routes onto; the round-3 actionable ExternalInquiryPermission item and the policy-protected CLI-inquiry-surface exclusion touch different symbols. The externalInquiryStorage items in the 08-25 survey (thread mirror) and 08-07 triage (listOpenThreads) are different surfaces.

**Proposal**

Batch as one micro-PR: (1) export InquiryThreadStatusSchema from src/shared/schemas/inquiry.ts and use it at externalInquiryStorage.ts:98 (`status: InquiryThreadStatusSchema` — same accepted values, so persisted manifests parse identically; the new export gains its consumer in the same PR per the exports-are-contracts rule). (2) In workflowScriptDelivery.ts, import LineCountSchema from './lineChanges' and replace lines 5-6 with `added: LineCountSchema.nullable(), removed: LineCountSchema.nullable()`. Wire compatibility: both edits are value-identical schemas, so the frozen CLI NDJSON payloads and persisted manifests are byte-unaffected.

**What we give up**

Nothing behavioral. Cost is one new exported symbol on the shared inquiry module (with an immediate consumer) and one new intra-directory import edge in shared/schemas — both the directions the corpus's own docstrings already prescribe.

**Verifier corrections — these override the evidence and proposal above**

All cited line numbers verified exact at HEAD: inquiry.ts:31-32 (schema const unexported, type exported), externalInquiryStorage.ts:18/:98/:580, lineChanges.ts:7, prompts.ts:34-35, output.ts:171-172, workflowScriptDelivery.ts:5-6. Two minor precision notes, neither invalidating: (a) claimed net 0 LoC is slightly optimistic — the honest count is about +2 (one new import line in workflowScriptDelivery.ts, one new specifier line in externalInquiryStorage.ts's one-per-line import block; the `export` keyword on inquiry.ts:31 adds no line); (b) the proposal should have externalInquiryStorage import InquiryThreadStatusSchema from '@shared/schemas' (the barrel it already uses at :9-22), not from the file path — the barrel re-exports it automatically via index.ts:54. Also worth stating in the PR body: prompts.ts:34-35 uses LineCountSchema non-nullable (addedLines/removedLines), so only output.ts:171-172 is the exact `.nullable()` precedent for the workflowScriptDelivery edit.

<details><summary>Verifier reasoning</summary>

Verified the duplication is real and directional: externalInquiryStorage.ts already type-couples to the shared vocabulary (imports type InquiryThreadStatus at :18, types listThreadsByStatus with it at :580, and manifestToSummary at :541 feeds manifest.status straight into InquiryThreadSummary, whose schema is built on InquiryThreadStatusSchema) — the inline value-level enum at :98 is the only remaining unshared copy, and a widened shared enum would indeed make the persisted-manifest parser reject a status the type system accepts. For workflowScriptDelivery, lineChanges.ts's docstring names itself the shared owner and two sibling files in the same directory already consume it for the same added/removed semantics; the hand-spelled copy is drift by omission, not design (no strictObject interaction — only the leaf int schema is reused). Both edits are the exact pattern the corpus docstrings prescribe, are value-identical so no persisted or wire behavior changes, and the exports-are-contracts rule is satisfied by the same-PR consumer. This is a drift-guard amendment, not a consolidation claiming LoC wins, so the ~+2 net is acceptable under the checklist's cost lens.

</details>

### dependencies

#### Two stable-stringify dependencies for one job: drop fast-json-stable-stringify onto safe-stable-stringify

- **Kind**: consolidate · **Risk**: low · **Net**: -3 LoC
- **Files**: `src/logger/logUtils.ts`, `src/utils/core/idHash.ts`, `src/agent/workflowScript/checkpointKey.ts`, `src/agent/workflowScript/runWorkflowScript.ts`, `src/agent/core/flows/toolCallParsing.ts`, `src/tools/registry.ts`, `src/common/errors/sdkError/providerErrorFormat.ts`, `package.json`, `packages/agent/package.json`, `packages/extension/package.json`

**Evidence**

safe-stable-stringify: 1 import (src/logger/logUtils.ts:18, comment at :168-171 defends it: circular-safe, replaced a hand-rolled walker — so it must stay). fast-json-stable-stringify: 6 imports (idHash.ts:5, checkpointKey.ts:2, runWorkflowScript.ts:51+846, toolCallParsing.ts:47, registry.ts:213, providerErrorFormat.ts:197). Both declared in root + packages/agent manifests; extension additionally declares fast-json. Byte-identity verified live: safe-stable-stringify@2.5.0 output === fast-json-stable-stringify output on nested objects, flat string records (the deriveExecutionId/checkpointId shape), and arrays. Dedupe: no mention in rounds123-index.md or the three survey proposals; 2026-07-29-open-source-readiness.md §deps only ruled on hoisting placement, not duplication.

**Proposal**

Point the 6 fast-json-stable-stringify imports at safe-stable-stringify (its default deterministic mode is a strict superset: same sorted-key JSON.stringify-compatible output, plus circular tolerance) and delete the fast-json-stable-stringify rows from root, packages/agent, and packages/extension package.json. Hash-stability gate: idHash.ts feeds persisted executionIds and checkpointKey.ts/runWorkflowScript.ts feed durable workflow-script replay journals, so the PR must carry a one-off equivalence assertion over the actually-hashed shapes (flat string/number records and JSON-serializable checkpoint payloads — verified identical here). Worst case if an exotic payload ever diverged: a one-time journal-replay cache miss, which checkpointKey.ts's own docstring defines as safe ('a changed call re-executes, an unchanged one is free').

**What we give up**

The theoretical speed edge of fast-json-stable-stringify on hot paths (irrelevant: all six sites hash small identity records or run at most once per tool call), and one npm package name people may grep for.

**Verifier corrections — these override the evidence and proposal above**

1. Cited line numbers registry.ts:213, toolCallParsing.ts:47, runWorkflowScript.ts:51+846, providerErrorFormat.ts:197 are USE sites; the imports are at registry.ts:2, toolCallParsing.ts:1, runWorkflowScript.ts:3, providerErrorFormat.ts:1 (idHash.ts:5 and checkpointKey.ts:2 are correct as stated). 2. "Strict superset" overclaims: (a) BigInt — fast-json throws ("Do not know how to serialize a BigInt", verified) while safe-stable-stringify silently serializes it as a number literal (default bigint:true); a loud failure becomes silent. No current site can receive a BigInt (JSON-parsed or hand-built records), but the PR body should say so. Same for circular: loud TypeError becomes silent "[Circular]" — cite the silent-degradation guardrail and why it cannot fire here. (b) Type surface — safe-stable-stringify's stringify returns string | undefined, so this is not a pure import rename: the sites feeding truncatedHexId (idHash.ts:19, checkpointKey.ts:24-31, runWorkflowScript.ts:50 and :846) need `?? ''` or a non-null assertion to pass typecheck; the two !== comparison sites need nothing. 3. packages/extension/package.json:1077 is not load-bearing (fast-json is bundled, not external; repo-root src resolves it from root node_modules), so it is deleted, not swapped — no safe-stable-stringify row needs adding to the extension manifest. 4. The proposed "one-off equivalence assertion" must NOT land as a committed test (tests-are-a-budget rule); run it as a throwaway script recorded in the PR body, or netLoc goes positive by ~15 lines.

<details><summary>Verifier reasoning</summary>

Genuine dual-system: two packages doing the same deterministic-stringify job, one imported once with a defending comment, the other imported six times with none. Byte-identity on every actually-hashed shape was re-verified live in this repo's node_modules, so the two persistence-facing consumers (executionIds, workflow-script journal keys) are unaffected, and even a hypothetical divergence downgrades to a re-execution per checkpointKey.ts's own docstring. The two real divergences found (BigInt, string|undefined return type) are handleable at the call sites and unreachable at runtime today. This is the rare consolidation that actually deletes a dependency and nets negative.

</details>

#### dotenv: one config() call that process.loadEnvFile now covers

- **Kind**: delete · **Risk**: low · **Net**: -2 LoC
- **Files**: `packages/extension/src/extension.ts`, `package.json`, `packages/extension/package.json`

**Evidence**

Exactly 1 import repo-wide: packages/extension/src/extension.ts:6, called once at :241-243 as dotenv.config({ path: join(workspaceRoot, '.env') }). Declared in root and extension manifests. process.loadEnvFile ships since Node 20.12; the VS Code ^1.125 extension host runs Node 22, and every other host floor is node >=22.9 (nothing else imports it anyway). Semantics match: both leave already-set environment variables untouched. Bonus: dotenv v17 prints its promotional tip line to the console on every activation. Dedupe: 2026-07-29-open-source-readiness.md:410 mentions dotenv only as a hoisting-placement observation ('nothing to delete' about where it is declared) — it never examined replacing the call; absent from rounds123-index.md.

**Proposal**

Replace the call with process.loadEnvFile(envPath) guarded for the expected-absent file (fs.existsSync or catching only ENOENT — not a bare catch {}, per the silent-degradation guardrail; a malformed .env should still surface loudly, which is stricter than dotenv's swallowed-error object today). Delete the import and both manifest rows. Caveats an implementer must check: loadEnvFile is still stability-1.1 in Node 22 docs, and Node's parser skips dotenv's exotic forms (backtick quotes, some multiline shapes) — fine for the KEY=VALUE API-key .env files this path targets, but confirm no documented .env format promises more.

**What we give up**

dotenv's tolerance of exotic .env syntax and its never-throws contract; if the maintainer judges the stability-1.1 marker disqualifying, the fallback is a 10-line KEY=VALUE parser, at which point keeping dotenv is the better trade — that judgment call is the only thing between this and trivial.

**Verifier corrections — these override the evidence and proposal above**

One factual error: the proposal claims a malformed .env would "surface loudly" under loadEnvFile, "stricter than dotenv's swallowed-error object." Empirically false — process.loadEnvFile also silently tolerates malformed lines (verified: no throw on garbage input); the only throws are filesystem errors (ENOENT, EACCES). So the implementer needs only the ENOENT-only catch (or existsSync guard) and gains no extra strictness. Minor implementation note: extension.ts has no existing node:fs import, so prefer the try/catch-on-ENOENT form (rethrow other codes) over existsSync to avoid adding an import. Also, Node 22+ handles quoted multiline values, so even that dotenv edge case is covered at the actual runtime floor; the "backtick quotes" gap is real but promised nowhere.

<details><summary>Verifier reasoning</summary>

Single import, single call site, two manifest rows — all verified at HEAD. Runtime floors (VS Code ^1.125 extension host on Node 22, all other hosts node >=22.9) comfortably exceed loadEnvFile's 20.12 introduction, and nothing else imports dotenv anyway. Semantics match on the one axis that matters (existing env vars take precedence in both), verified by running Node locally. The documented .env contract is plain KEY=VALUE API keys, well within Node's parser. Deleting the dependency also removes dotenv v17's console tip line on every activation and shrinks the extension bundle. The stability-1.1 marker on loadEnvFile is the only residual judgment call and is acceptable for a dev-convenience path whose failure mode (ENOENT-guarded, lenient parse) is benign.

</details>

#### date-fns: a full date library imported for exactly two calls, both natively coverable

- **Kind**: delete · **Risk**: low · **Net**: 13 LoC (proposer claimed 10; verifier figure governs)
- **Files**: `src/logger/logUtils.ts`, `src/utils/text/stringUtils.ts`, `package.json`, `packages/agent/package.json`, `packages/trace-viewer/package.json`

**Evidence**

Exactly 2 imports repo-wide (rg over src, packages/*/src, scripts, supabase): logUtils.ts:17/:140 uses format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS') for the log-line timestamp, and stringUtils.ts:1/:312 uses intlFormatDistance(timestamp, Date.now()) for cosmetic 'X ago' labels (consumers: StreamTabs last-seen, MemoryTool mtimes, inquiryContinuation). Declared in three manifests including the published @texra-ai/agent package; packages/trace-viewer declares it with zero imports in its own src (it reaches it only through the aliased stringUtils). stringUtils.ts:300 already builds Intl.DateTimeFormat natively in the same file. Dedupe: absent from rounds123-index.md and all three survey proposals.

**Proposal**

Replace the format() call with a ~6-line local-time pad formatter (fixed numeric pattern, no locale or calendar logic) and formatRelativeTime with Intl.RelativeTimeFormat plus the standard threshold ladder (~15 lines) — stringUtils is one of the six browser-reachable @utils modules and Intl keeps it dependency-free in both worlds. Then delete date-fns from root, packages/agent, and packages/trace-viewer package.json. Net code is ~+14 lines against -1 dependency in three manifests (one of them the published SDK package). Honest caveat: intlFormatDistance is calendar-aware ('yesterday'), the ladder is duration-based ('23 hours ago'); AGENTS.md 'the new behavior is still reasonable and easier to explain' covers this for display-only labels.

**What we give up**

Calendar-boundary phrasing at unit edges in relative labels, and date-fns as an already-present option for any future date math (none exists today — v4 is tree-shaken so the bundle-size win is small; the win is install/audit/upgrade surface).

**Verifier corrections — these override the evidence and proposal above**

1. 'the published @texra-ai/agent package' overstates: packages/agent is built and fenced but deliberately NOT published (CLAUDE.md: 'npm publication is deliberately held until a named external consumer exists'). The manifest win is prospective SDK-hygiene, not a live published surface. 2. 'Claimed net: 10 LoC' has the wrong sign if read as a reduction: honest net is roughly +13 LoC (~+7-line pad formatter in logUtils, ~~+14-line ladder in stringUtils, -2 import lines, -3 manifest lines; pnpm-lock shrinkage not counted). The proposal body's '~~+14 lines' is the honest figure; the header should not read as a reduction. 3. The formatRelativeTime docstring must be rewritten in the same PR to drop 'Calendar-aware' — leaving it would be a lying comment. 4. Minor framing: 'v4 is tree-shaken so the bundle-size win is small' is right for bundles, but the install-footprint win is larger than the finding implies since pnpm why shows no transitive dependent keeps date-fns — the package disappears from node_modules entirely.

<details><summary>Verifier reasoning</summary>

Verified every factual claim at HEAD: exactly two import sites (src/logger/logUtils.ts:17/140, src/utils/text/stringUtils.ts:1/312), exactly three manifest declarations (package.json:123, packages/agent/package.json:67, packages/trace-viewer/package.json:19, all ^4.4.0), trace-viewer has zero own-src imports, stringUtils already uses Intl.DateTimeFormat natively at line 301, and the three consumers are as listed. The replacement is mechanical and low-risk: the log timestamp keeps the identical fixed pattern, and the relative labels degrade only from calendar phrasing ('yesterday') to duration phrasing ('23 hours ago') on display-only strings no test or contract pins. This is a dependency deletion sold as dependency-surface reduction, not an LoC win, and the finding is honest about the LoC cost — so checklist section 13 does not kill it, but the netLoc I report is the honest positive number, not a reduction.

</details>

### product-surface

#### Add the missing commandPalette gate for texra.auth.grok.signIn — the one hand-maintained palette row #9709 never wrote

- **Kind**: amend · **Risk**: low · **Net**: 8 LoC (proposer claimed 4; verifier figure governs)
- **Files**: `packages/extension/package.json`, `src/shared/commands/catalog.ts`

**Evidence**

contributes.commands has 50 rows (derived from src/shared/commands/catalog.ts by scripts/sync-package-contributes.mjs, which owns ONLY contributes.commands and contributes.keybindings — scripts/sync-package-contributes.mjs:13,61-62); contributes.menus.commandPalette has 49 hand-maintained rows. The one command with no palette row is texra.auth.grok.signIn (verified by diffing the two lists), added by #9709 ('feat: experimental Grok (xAI SuperGrok) OAuth login', git log -S on package.json). Every sibling auth command carries `when: texra.activated`; VS Code shows an ungated contributed command in the palette of every window, so 'TeXRA: Sign In with Grok Subscription' is the only TeXRA command visible before activation and in non-TeXRA workspaces, and invoking it force-activates the extension. No verifier covers this: grep commandPalette in scripts/verify-extension-package-invariants.mjs and grok in scripts/extension-package-invariants.snapshot.json both return nothing. Dedupe: round-1 REFUTED 'Derive contributes.menus.commandPalette from the command catalog' — but that verification (agents/docs/archived/simplification/2026-08-25-simplification-survey-49-candidates.md:2673) itself confirms 'The underlying drift IS real and verified, but it is a 4-line bug fix, not a tech-debt simplification'. This finding files exactly that 4-line fix as a product-surface amend and does NOT re-propose the refuted derivation mechanism.

**Proposal**

Add one commandPalette entry to packages/extension/package.json: { "command": "texra.auth.grok.signIn", "when": "texra.activated" }, placed with the other auth rows. Do not build the catalog-derivation machinery — that design was examined and refuted in round 1 (nets +LoC, adds elements, needs a second snapshot-gate regeneration). User-facing consequence: the Grok sign-in entry behaves like ChatGPT sign-in — hidden until TeXRA activates.

**What we give up**

Nothing; the walkthrough deliberately omits Grok (experimental), and that stays as is.

**Verifier corrections — these override the evidence and proposal above**

1. "No verifier covers this" is wrong where it matters for landing the fix: scripts/extension-package-invariants.snapshot.json:210-211 pins the full contributes.menus.commandPalette (all 49 current rows) under its `manifest` key, and check:extension-package-invariants (.github/workflows/ci.yml:214) diffs against it. The grep for "grok" returns nothing only because the snapshot faithfully pins the buggy palette. Adding the row without running `npm run sync:extension-package-invariants` fails CI — the round-1 refutation the finding itself quotes named this second gate. 2) Paths wrong: src/shared/commands/catalog.ts needs no edit (palette rows are hand-maintained; scripts/sync-package-contributes.mjs owns only contributes.commands and contributes.keybindings, per its own header comment). Real edit set: packages/extension/package.json plus regenerated scripts/extension-package-invariants.snapshot.json. 3) Claimed net 4 LoC understated: ~+8 (4-line JSON row in package.json plus ~4 mirrored lines in the regenerated snapshot).

<details><summary>Verifier reasoning</summary>

Ran every kill-check with fresh evidence at HEAD. (1) Dedupe: index line 92 and the round-1 survey doc cover only the refuted derivation mechanism; that refutation explicitly carves out the 4-line fix as a real bug worth fixing, which is exactly what this amend files; round-2 doc and round-3 PRs #11452-#11460 (all merged, titles checked) do not cover it, and git log on packages/extension/package.json shows no fix landed. (2) The only dated ruling (round-1 refutation) affirms the drift. (3) No comment or guard defends the missing row; omitting a commandPalette entry makes the command MORE visible (VS Code shows ungated contributed commands everywhere), so a "deliberately hidden because experimental" theory is mechanically impossible — the walkthrough omission the finding mentions is a separate surface and stays untouched. (4) No external consumer of VS Code manifest menus. (5) Settled surfaces untouched; the derivation machinery is explicitly not proposed; snapshot gate preserved. (6) Cost recomputed: ~+8 LoC across two generated/hand JSON files — acceptable for kind=amend (a user-facing bug fix, not a claimed reduction), but the finding's +4 and its two-path list are corrected above. (7) No churn: two-file, ~8-line change. Verdict: survives with three corrections.

</details>

#### PRODUCT DECISION: changeReviewer is offered in the agent dropdown on every host, but its only reporting channel works solely inside a review started by texra.agentReview.run

- **Kind**: consolidate · **Risk**: medium · **Net**: 10 LoC (proposer claimed 8; verifier figure governs)
- **Files**: `packages/extension/resources/tool_use_agents/changeReviewer.yaml`, `src/tools/ReportReviewIssueTool.ts`, `packages/extension/src/frontend/review/AgentReviewService.ts`, `packages/extension/src/progressView/extensionHostInteractions.ts`, `src/agent/runtime/HostInteractions.ts`, `docs/guide/built-in-agents.md`

**Evidence**

changeReviewer.yaml is a normal bundled tool-use YAML (packages/extension/resources/tool_use_agents/changeReviewer.yaml:1) with no host or visibility gating — AgentDefinitionSchema has no hosts/hidden field (grep 'hosts' in src/agent/core/definition/AgentDataclass.ts and src/agent/index/agentYamlScanner.ts: 0 hits), and roster visibility default is show-all (src/agent/index/agentRegistry.ts:417-424, 'undefined means never configured (show all)'; CLI hides only 'agents hidden by workspace visibility settings', packages/cli/src/commands/agents.ts:92). Its sole output tool report_review_issue is sink-gated: src/agent/runtime/HostInteractions.ts:354 declares the sink optional; the ONE wiring in the repo is packages/extension/src/progressView/extensionHostInteractions.ts:39 (repo-wide grep for reportReviewIssue excluding tests: 4 hits, no CLI or desktop wiring), so on CLI and desktop the tool returns 'Agent review is not available in this host.' (src/tools/ReportReviewIssueTool.ts:29-35). Even on the extension, AgentReviewService.addIssueReport rejects any report unless this.reviewRuns.collection is active — i.e. a session started via runReview from the texra.agentReview.* commands (packages/extension/src/frontend/review/AgentReviewService.ts:390-401, reason text: 'Findings can only be reported from a review started via "Run Agent Review".'). So a dropdown launch of changeReviewer can never land a finding anywhere, yet docs/guide/built-in-agents.md:420 documents it as a pickable dropdown agent ('Best for: Reviewing uncommitted changes before you commit'). Dedupe: rounds123-index has no changeReviewer/agent-review-roster item (R2 shipped only the ReviewIssueReport schema fold); grep of both survey proposals for changeReviewer/report_review: only the unrelated ReviewIssueReport fold. The YAML's own comment (deliberately no bash, read-only for run-on-commit) explains the tool list, not the roster exposure, so no stated rationale is being reasoned past.

**Proposal**

This is a user-visible product decision, not a cleanup: the working home for this action is the Agent Review surface (texra.agentReview.run / the SCM 'Find Issues' button), and the dropdown row is a second entry point that silently degrades — the agent runs, burns tokens, and every finding is politely rejected, leaving at best a prose summary in the transcript. Options, in order of preference: (a) keep one home — default-hide changeReviewer from the user roster (an internal/hidden marker on the YAML honored by getVisibleAgents, or exclude-by-name where the bundled dirs are scanned), leaving it resolvable by the AgentReviewService launch path and by `--all`; update the built-in-agents doc section to say it is driven from Source Control; (b) if the maintainer wants dropdown reviews to work, wire addIssueReport to accept ad-hoc sessions instead (larger, extension-only). Either way, fix the rejection copy 'Run Agent Review' — no command with that title exists (the palette title is 'Find Issues (Agent Review)'). User-facing consequence of (a): changeReviewer disappears from the default agent dropdown and default `texra agents` listing on all hosts; the Find Issues button behavior is unchanged.

**What we give up**

Option (a) adds one small mechanism (a hidden/internal marker) that rounds 1-3 would normally count against the change, and it removes a documented — if non-functional — dropdown row, so it needs the maintainer's product sign-off, not just a reviewer's.

**Verifier corrections — these override the evidence and proposal above**

1. The docs quote is incomplete in a way that slightly overstates the doc problem: docs/guide/built-in-agents.md line ~~422 already says the agent 'reports confirmed findings to the Agent Review (Find Issues) panel in Source Control', so the coupling is partially documented today; the residual doc fix is only the 'Best for' framing plus a 'launch it from Source Control' pointer. 2. Sink accessor citations: HostInteractions.ts declares the field at :354 AND exposes the getter at :526-527 (finding cited only :354; immaterial). 3. Missing caution the implementer must honor: hiding must apply only to getVisibleAgents/listing, never to launch resolution — CLI launch goes through resolveAgentForLaunch (packages/cli/src/runtime/agents.ts:122), a separate path, and AgentReviewService launches by name (REVIEW_AGENT = 'changeReviewer', AgentReviewService.ts:53); if the hidden marker leaks into name resolution, `texra run --agent changeReviewer` and the Find Issues button both break. 4. Cost sign: option (a) is a net ADD (~~+10 lines: schema field, filter, YAML line, copy fix; doc edit roughly neutral), so 'net 8 LoC' is right in magnitude but must be read as cost, not saving — defensible only because this is a correctness/product fix, not a simplification.

<details><summary>Verifier reasoning</summary>

Every load-bearing fact reproduced against HEAD: single sink wiring at extensionHostInteractions.ts:39 (repo grep), optional sink at HostInteractions.ts:354, host-rejection text at ReportReviewIssueTool.ts:31-33, reviewRuns.collection gate with stale 'Run Agent Review' copy at AgentReviewService.ts:394-400, no hosts/hidden field in AgentDataclass/agentYamlScanner (0 grep hits), show-all default in agentRegistry.ts, CLI ships the YAML (packages/cli/dist/resources/tool_use_agents/changeReviewer.yaml present, copy-resources.mjs:19), desktop has no wiring and cannot import the extension sink. The degradation is real and worse than claimed (no diff input on ad-hoc launch, no bash to synthesize one). Dedupe and rulings checked and clean. This is a genuine one-home product decision requiring maintainer sign-off, correctly flagged as such.

</details>

### build-config

#### No-op include/exclude rows in root and extension tsconfigs (excludes that match nothing the include covers)

- **Kind**: amend · **Risk**: low · **Net**: -11 LoC (proposer claimed -8; verifier figure governs)
- **Files**: `tsconfig.json`, `packages/extension/tsconfig.json`

**Evidence**

Root tsconfig.json include is [src/**/\*.d.ts, src/**/_.ts, src/\**/_.tsx, packages/extension/src/**/\*.ts(x)]. Of its exclude rows, only node_modules and src/test-kernel are load-bearing; "supabase", "packages/desktop", "packages/extension/vite.config.ts", and "packages/extension/esbuild.config.mjs" match no include pattern, so they exclude nothing (TS exclude only filters include globs; imported files are pulled in regardless, and esbuild reads tsconfig only for paths/target, ignoring include/exclude). The "src/**/_.d.ts" include row is redundant: the TS glob *.ts matches .d.ts files, so src/\**/*.ts already covers it. packages/extension/tsconfig.json has an empty "compilerOptions": {} and excludes [out, dist, vite.config.ts, esbuild.config.mjs] against an include of only src/\** and ../../src/types/\**/_.d.ts — none of those four paths is matched by the include, so all four rows are no-ops. Verified the consumers that could give exclude a second meaning: eslint.config.mjs:540-549 lists projects explicitly and typed-lint project membership is decided by include matching (removing never-matching excludes cannot change membership); scripts/sync-tsconfig-paths.mjs regenerates only the paths blocks, not include/exclude; vitest resolves via scripts/aliases.mjs, not tsconfig globs. Dedupe: rounds123-index.md has no tsconfig-hygiene entry; the settled-surface list covers the alias sync mechanism, not these rows.

**Proposal**

One hygiene commit: drop the four never-matching exclude rows and the redundant src/**/*.d.ts include row from tsconfig.json, and drop the empty compilerOptions object plus the four no-op exclude rows from packages/extension/tsconfig.json. Run npm run typecheck and npm run lint to confirm identical program membership.

**What we give up**

A belt-and-suspenders guard against someone later widening the include globs to cover those paths — speculative, and the same commit family (970fc11030 'prune stale build config') already established this cleanup as house style. Honestly tiny (~8 lines); filed because it is zero-risk and this surface will not be re-audited soon.

**Verifier corrections — these override the evidence and proposal above**

1. Missed consumer of the text (not the behavior): packages/desktop/src/renderer/tsconfig.json's comment explicitly says "the repo-root tsconfig excludes packages/desktop entirely" — the amend commit must reword this (e.g. "the repo-root tsconfig's include never reaches packages/desktop") or it dangles on a deleted row. Behavior is unaffected: esbuild/Vitest walk-up stops at packages/desktop/tsconfig.json and ignores include/exclude regardless. 2. "esbuild reads tsconfig only for paths/target" is imprecise: esbuild also honors jsx, experimentalDecorators, and useDefineForClassFields through the extends chain (extension esbuild.config.mjs:46 -> packages/extension/tsconfig.json -> root), which is load-bearing for this repo's decorator settings; the true and relevant half is that esbuild ignores include/exclude. 3. Net LoC understated: prettier collapses the extension exclude array to a single line once four of five rows go, so honest net is about -11 (root -5, extension -6), not -8. 4. The extension "node_modules" exclude row is itself removable (TS default exclude covers node_modules and the include never reaches one), though keeping it is a defensible conservative choice. 5. Inheritance risk should be stated in the PR: include/exclude propagate through extends, and the safety argument depends on every extending config overriding include — verified true today for all 13 tsconfigs, but it is the actual invariant, not "exclude only filters include" alone.

<details><summary>Verifier reasoning</summary>

Verified every claim against HEAD. Root tsconfig include is src/** + packages/extension/src/** only; the four named exclude rows match nothing include covers, and src/**/\*.ts matches .d.ts files, so src/**/*.d.ts is redundant. Extension tsconfig: empty compilerOptions and four exclude rows (out, dist, vite.config.ts, esbuild.config.mjs) that its src/**-scoped include never reaches. Confirmed the finding's consumer audit: eslint.config.mjs:540-549 typed-lint projects decide membership by program membership (never-matching excludes cannot change it); scripts/sync-tsconfig-paths.mjs regenerates only paths blocks of tsconfig.build.json and desktop/tsconfig.paths.json, extension tsconfig explicitly not a target; extension esbuild honors compilerOptions via extends but ignores include/exclude; no repo tsconfig has "references", so Vite/tsconfck never does include-matching; no ratchet or knip script parses these fields. Independently audited the extends-inheritance hazard (the realistic failure mode the finding didn't name): all 13 tsconfigs either declare their own include/exclude or inherit a non-root exclude, so nothing depends on the deleted rows. Found one missed textual reference (the desktop renderer nearest-tsconfig marker comment) — mechanism unaffected, needs a one-line comment amend. Dedupe clean, prior commits pruned this same block twice, cost recomputed at ~-11.

</details>

#### Four uninvoked npm scripts in packages/agent restate the build.mjs recipe and have already drifted

- **Kind**: delete · **Risk**: low · **Net**: -4 LoC
- **Files**: `packages/agent/package.json`, `packages/agent/scripts/build.mjs`

**Evidence**

packages/agent/package.json:42-45 declares build:bundle, build:types, check:artifacts, clean. Repo-wide rg (excluding node_modules, pnpm-lock, and the two survey proposal docs that merely mention them) finds ZERO invokers for all four — no workflow, no root script, no docs runbook, no .claude skill, no other package. The only production entry points are `build` (invoked by root typecheck:agent at package.json and by prepack) and `prepack`; `build` runs scripts/build.mjs, which executes the same five steps directly (clean.mjs, bundle.mjs, tsc -p ../../tsconfig.build.json, rewrite-declaration-aliases.mjs, validate-artifacts.mjs). Drift is already visible: build:types runs `tsc --checkers 8 -p ../../tsconfig.build.json` while build.mjs runs plain `tsc -p ../../tsconfig.build.json` (packages/agent/scripts/build.mjs:12-15) — two owners of one recipe, disagreeing on the checkers flag. Dedupe: rounds123-index.md has no entry touching packages/agent scripts; the round-2 survey doc cites these rows only as evidence that fsWalk.mjs is production-reachable, and that reachability survives via build.mjs, which invokes rewrite-declaration-aliases.mjs and validate-artifacts.mjs directly. External consumers: the package is deliberately unpublished (CLAUDE.md: 'built, fenced, not published'; release.yml publish-agent job is hard-disabled with `if: false`), so no external tooling can be calling these script names.

**Proposal**

Delete the build:bundle, build:types, check:artifacts, and clean rows from packages/agent/package.json, leaving `build` and `prepack` as the two entry points. The underlying .mjs files stay (build.mjs runs them). Optionally add --checkers 8 to the tsc call in build.mjs so the one surviving owner keeps the faster form, resolving the drift in the canonical direction.

**What we give up**

The convenience of running one build stage by npm-script name; `node scripts/bundle.mjs` etc. from packages/agent/ still works, and nothing in three months of history has needed the per-stage aliases.

**Verifier corrections — these override the evidence and proposal above**

Two minor corrections: (a) the claim says only "the two survey proposal docs" mention the scripts — a third doc, docs/dev/audits/2026-08-04-typescript-7-upgrade.md:191, also names build:types (dated audit snapshot, not an invoker; no edit needed); (b) the optional --checkers 8 addition to build.mjs should note that `tsc` in packages/agent/node_modules/.bin resolves to the @typescript/native (tsgo) binary alongside a `tsc6` shim — --checkers is a tsgo-only flag, valid for the resolved binary, but this makes the edit slightly less trivial than "resolving drift in the canonical direction" implies and it can be dropped from the PR without weakening the deletion. Everything else verified exact: rows at package.json:42-45, build entry chain (root typecheck:agent → pnpm --filter build → build.mjs five steps), prepack→build, zero invokers repo-wide, publish job disabled with if:false.

<details><summary>Verifier reasoning</summary>

Verified against HEAD: packages/agent/package.json:40-47 shows exactly the six scripts claimed; build.mjs runs clean.mjs, bundle.mjs, tsc, rewrite-declaration-aliases.mjs, validate-artifacts.mjs in sequence, duplicating all four uninvoked rows. Repo-wide rg for the three colon-named scripts finds only three doc mentions, zero invokers; no workflow, root script, .claude skill, or recursive pnpm run reaches `clean`. The drift (build:types has --checkers 8, build.mjs does not) is real and is the classic two-owners-of-one-recipe defect. Deleting the four rows leaves build+prepack as the sole entry points with no capability loss (per-stage runs remain possible via `node scripts/<x>.mjs`).

</details>

### cascade-orphans

#### StreamLogStore.reload/executeReload lost their only production callers in #11452 — now a test-only surface

- **Kind**: delete · **Risk**: medium · **Net**: -255 LoC (proposer claimed -290; verifier figure governs)
- **Files**: `src/transcript/StreamLogStore.ts`, `src/test-kernel/transcript/StreamLogStoreLoad.vitest.ts`, `src/test-kernel/desktop/DesktopAgentExecution.vitest.ts`

**Evidence**

At the pre-round base (afef057ae3) the only production callers of `StreamLogStore.reload` were SessionHandle.ts:429 (`transcripts.reload()`) and :444 (`reload({discardPendingWrites:true})`), both inside `replaceStoresAfterStorageRootChange`, deleted by #11452. On origin/main, grep for `\.reload(` across src+packages finds zero production callers — only tests (StreamLogStoreLoad.vitest.ts:894,926,945,1853,2015,2031,2053,2078; DesktopAgentExecution.vitest.ts:2762, a test-convenience use). The SDK barrel (packages/agent/src/index.ts:252) constructs only `StreamLogStore.ephemeral`, on which reload throws by design. `git log -S discardPendingWrites` bottoms out at e89c5cbc05 (#9273), the workspace-transition stack. Dead surface: `reload` (:1208-1232 incl. doc that still says 'reserved for workspace-root rollback'), `executeReload` (:1336-1369, incl. the writeGeneration-bump/drain branch that exists only for `discardPendingWrites`), `pendingReload` field (:437), and the now-false comment at :642 ('flush/reload drains this write before a storage-root change'). Not on any wire: StreamLogStore is in-process, not part of the CLI NDJSON contract or a persisted format — deleting a method changes no stored bytes. `writeGeneration`, `replaceSummaries`, `readPersistentSummaries`, `prepareSummaryCache` all have live non-reload callers (clear() at :1088, open() at :501-502) and stay. Dedupe: `reload`/`discardPendingWrites` appear in no survey doc claim and no rounds123-index title; the round-3 transition item's test plan (round3.md:1292) never mentioned this file.

**Coverage handoff — which suite owns each dropped behavior**

The behaviors that stop being pinned are exactly the deleted mechanism's own: transactional-reload atomicity (StreamLogStoreLoad.vitest.ts:879), discard-pending-writes rollback (:910, :1836, :1997), dir re-preparation after a storage-root reload (:936), and reload-vs-metadata races (:2026, :2036, :2062) — all describe an operation that no longer exists, so no surviving suite needs to own them. The persistence behaviors those tests incidentally exercised remain pinned by the same file's surviving describes ('StreamLogStore load' flush/drain tests and 'StreamLogStore save throttle', src/test-kernel/transcript/StreamLogStoreLoad.vitest.ts) and by the summary-metadata-mirror describe (:1935). DesktopAgentExecution.vitest.ts:2762 keeps its persist-across-eviction assertion by replacing `requestEviction + reload` with `requestEviction + ensureLoaded` (eviction alone already forces the disk re-read) in src/test-kernel/desktop/DesktopAgentExecution.vitest.ts.

**Proposal**

Delete `reload`, `executeReload`, and `pendingReload` from src/transcript/StreamLogStore.ts; simplify the write-path comment at :642; delete the eight reload-pinning tests and rework the one desktop test's convenience call. Roughly -60 production, -230 test lines. Ship as its own PR since it deletes a public method on a class the frozen SDK constructs (ephemeral-only, so the SDK surface is unaffected — but say so in the PR body).

**What we give up**

A production caller of `.reload(` outside test-kernel, an SDK consumer contract that names `reload` (none exists: the SDK is unpublished and packages/agent/src only calls `StreamLogStore.ephemeral`), or a maintainer plan to revive in-place store swapping.

**Verifier corrections — these override the evidence and proposal above**

1. MISSED RATCHET EDIT (biggest gap): config/ratchets/store-public-surface-baseline.json lists "reload" under StreamLogStore, and its semantics string requires lowering the baseline in the same PR when the surface shrinks. The proposal never mentions this file; the PR must remove that row (sanctioned shrink, per round3 doc :2818 and #9590 proof obligation 10). 2. MISSED PRIOR-ART CITATION: merged #11452's PR body already deferred exactly this deletion as a follow-up, grouping it with three sibling orphans — StreamSnapshotStore.evictAll, StreamStatusMachine.clearAll, getAllStreamStates (streamStatusTestUtils.ts). The follow-up PR should either cover all four or state it deliberately scopes to StreamLogStore.reload; the finding claims only one. 3. LoC overcount: the eight tests total ~194 lines (31+26+18+29+29+10+26+25), not ~230; honest net ≈ -255 (≈-60 prod: reload :1208-1232, executeReload :1336-1369, pendingReload :435-437, comment :642; ≈-195 test incl. the one-line desktop edit and the baseline row). 4. Citation imprecision: "round3.md:1292" — the doc is agents/docs/archived/simplification/2026-08-26-simplification-survey-round3.md; the substantive claim (no reload ruling there) checks out. 5. Cross-lane note for the PR body: agents/docs/archived/simplification/2026-08-26-simplification-survey-round2.md:1877 cites the "prepares transcript directories again after a storage-root reload" test as surviving evidence for the separate invalidateAll candidate; deleting that test moots the reference — name it so the other lane isn't confused. 6. Unstated side effect worth one PR-body line: executeReload:1359 is the sole site that re-enables summaryCacheMaintenanceEnabled after :1614 disables it; production-invisible today (no reload caller exists), but the disable becomes permanent per store instance after deletion.

<details><summary>Verifier reasoning</summary>

Verified against origin/main (HEAD dce7d7e862; local checkout was stale — #11452 merged today at e9ceffbd62, which is why local grep still showed SessionHandle.ts:429/:444 callers; origin/main shows zero). Read reload/executeReload/pendingReload on origin/main, the eight test bodies, the desktop test at :2742-2771, the SDK barrel, the store-public-surface baseline, both survey docs, the rounds index, and #11452's PR body. The finding is accurate on every load-bearing claim (dead surface, no wire/SDK exposure, helper-method survivorship, coverage handoff, dedupe) and is the follow-up #11452's author explicitly requested. Its two real gaps — the mandatory baseline-row edit and the three sibling orphans — are execution corrections, not refutations. Risk stays medium: deleting a public method on a ratcheted store surface warrants its own PR with the baseline edit and the SDK-unaffected statement, exactly as proposed.

</details>

#### Four comments still describe the deleted workspace-storage transition as live behavior

- **Kind**: amend · **Risk**: low · **Net**: -2 LoC
- **Files**: `packages/extension/src/extension.ts`, `src/agent/followUp/ToolUseFollowUp.ts`, `src/controllers/session/SessionFactApplier.ts`, `src/controllers/progressView/backend/ProgressBackend.ts`

**Evidence**

#11452 (e9ceffbd62) updated the AppSignals doc for `approvalPolicyChanged` ('changed through a settings update', src/eventBus/AppSignals.ts) but missed the subscriber: packages/extension/src/extension.ts:729-731 still says 'Workspace transitions and approval-policy setting updates emit on this signal' — the transition emitter is gone. src/agent/followUp/ToolUseFollowUp.ts:178-182 says run metadata may be non-resident 'after a host restart, or evicted by a storage-root change' — the storage root can no longer change in-process (workspaceStorage.ts:160-166 now documents it as pinned at construction). src/controllers/session/SessionFactApplier.ts:571-576 lists 'storage-root change' as a cause of an `undefined` delete outcome, but the sole producer, ProgressBackend.deleteStreamNow (:609-613), returns undefined only for 'reserved id / cannot-use data dir' — the transition abort path that produced the third cause was deleted. src/controllers/progressView/backend/ProgressBackend.ts:775-778 justifies `storageOperationQueue` with 'filesystem work must observe one workspace root from beginning to end' — the root is now permanently pinned, so the stated reason is vacuously true; the queue's live job is serializing deletions/loads against each other (`enqueuePreparedStorageOperation`, :790-800). Per the 'what the code says it is for' rule these are now-false statements, not seams to reason past. Checked living docs too: AGENTS.md, CLAUDE.md, docs/architecture, docs/guide and .claude contain no reference to any symbol or mechanism the three rounds deleted (verified by scripted grep of all 199 deleted exported names plus 185 deleted locals against those paths).

**Proposal**

Reword the four comments: extension.ts drops 'Workspace transitions and'; ToolUseFollowUp.ts drops 'or evicted by a storage-root change' (snapshot eviction still exists — say 'or evicted', if that arm is to be kept, since `requestEviction` is live); SessionFactApplier.ts drops 'storage-root change' from the undefined-cause list so it matches deleteStreamNow's own comment; ProgressBackend.ts restates the queue's reason as ordering deletions against loads and other deletions (do NOT delete the queue — its serialization is still load-bearing for delete-vs-load ordering, only its justification rotted). Batch into any nearby PR; no behavior change.

**What we give up**

Nothing — these are factual statements checked against the current call graph. If a reviewer shows an emitter of approvalPolicyChanged on a transition path or an undefined-returning delete arm I missed, drop the corresponding edit.

**Verifier corrections — these override the evidence and proposal above**

Three factual errors/imprecisions. (a) The proposal justifies keeping 'or evicted' in ToolUseFollowUp.ts 'since requestEviction is live' — but requestEviction is a StreamLogStore method (src/transcript/StreamLogStore.ts:679, heavy in-memory log entries), not the store holding run metadata. Run metadata lives in StreamSnapshotStore (getRunMetadata at StreamSnapshotStore.ts:1429), whose eviction paths are load()'s evictStreamsExcept (:1785-1792) and the staged-deletion coordinator's evict hook. 'Or evicted' remains defensible, but cite the snapshot store's load()/eviction, not requestEviction. (b) The SessionFactApplier.ts undefined-cause list is stale in TWO arms, not one: besides 'storage-root change', 'no durable data' also no longer produces undefined — deleteStreamNow explicitly returns 'deleted' for ephemeral-only streams ('report deleted even when it had no durable data'). Matching deleteStreamNow's own comment (reserved id / cannot-use data dir) fixes both; the amend should drop both stale causes, which the proposal's 'so it matches deleteStreamNow's own comment' implies but never states. (c) Minor: cited line numbers drift by a few lines at origin/main (extension.ts comment starts at 729; ProgressBackend queue comment at ~774-777, deleteStreamNow undefined arm at 610-613; SessionFactApplier list at ~571-577); also the finding says 'the sole producer, ProgressBackend.deleteStreamNow (:609-613)' — the preparation-failure arm at :477-479 also feeds completeCommandRemoval, but with 'failed', so the sole-undefined-producer claim still holds.

<details><summary>Verifier reasoning</summary>

Verified every claim against origin/main (dce7d7e862), which contains merged #11452. git grep confirms exactly one production emitter of approvalPolicyChanged remains (SettingsViewMessageHandler.ts:548, a settings update), so extension.ts:729's 'Workspace transitions and...' is false. WorkspaceStorageProvider at origin/main pins activeWorkspacePath readonly at construction with a doc comment saying the storage root never changes under live runs, killing the 'storage-root change' cause in both ToolUseFollowUp.ts:180 and SessionFactApplier.ts:575. Traced the command-removal chain: enqueuePreparedStorageOperation → prepareStreamDeletion (failure → 'failed') → deleteStreamNow, whose only undefined return is !canUseStreamDataDir; clearStream returns DeleteStreamResult, never undefined — so the undefined-cause list in completeCommandRemoval's doc is provably stale (in two arms, see corrections). ProgressBackend's storageOperationQueue comment states a now-vacuous workspace-root invariant while the queue's real job (serializing deletes against loads, with the prepared-operation ordering dance at :785+) is still load-bearing — reword, keep the queue, exactly as proposed. Dedupe and ruling searches came up empty. This is a legitimate low-risk cascade amend: rounds shipped the deletion, these four comments now assert dead behavior as live.

</details>

### docs-tree

#### texra-cli-checkout.md still claims the repository is not open source and points at a CLAUDE.md section that no longer exists

- **Kind**: amend · **Risk**: low · **Net**: 0 LoC
- **Files**: `docs/dev/texra-cli-checkout.md`

**Evidence**

docs/dev/texra-cli-checkout.md:6 says the checkout instructions 'are not part of the public CLI guide ... because the repository is not open source.' The repo has been public under Apache-2.0 since the 2026-07-24/2026-07-29 open-source release (LICENSE at repo root; docs/guide/open-source.md states 'TeXRA's client software is licensed under the Apache License 2.0' and links github.com/LionSR/TeXRA; a round-3 KEEP ruling likewise records 'the repo is public'). The same doc ends its texra-local section with 'See also the "Local CLI (`texra-local`)" section of `CLAUDE.md`' — current CLAUDE.md contains no such section (rg 'texra-local' CLAUDE.md: 0 hits; the only texra-local references are the package.json scripts, which do still exist at package.json:55-56). Last touched 2026-06-14, before the open-source release. The check-guidance-refs gate scans docs/dev/ but only verifies path existence, so both claims survive CI. Dedupe: no rounds-1-3 title touches this file; not in the three survey docs.

**Proposal**

Amend, not delete — the install mechanics (texra-local:build/link, pnpm shadow path) are verified current. Rewrite the opening rationale to say these are developer notes kept out of the public guide because they concern working from a source checkout (the actual remaining reason), and either delete the CLAUDE.md pointer or repoint it to the real home of the texra-local scripts (root package.json / scripts/link-texra-local.mjs).

**What we give up**

The historical record that the repo was once private — worth nothing here; the dated open-source proposals under docs/proposals/ already carry that history.

**Verifier corrections — these override the evidence and proposal above**

1. The finding is not a fresh discovery: agents/docs/archived/process/2026-08-01-open-source-readiness-audit.md already recorded both defects (lines 505-507) and ordered the fix in its Phase-2 item 16 (line 641). It was simply never executed for this file while sibling item-16 fixes shipped. The finding's dedupe section ("no rounds-1-3 title touches this file") is true but incomplete — the amend PR should cite the audit proposal as the prior ruling it executes. 2. Dating: the repo went Apache-2.0 on 2026-08-21 (commit 67c9d40c54 "Relicense the repo under Apache-2.0"), not "2026-07-24/2026-07-29" — those are the dates of the open-source proposals, which predate the flip. 3. Minor: the same item-16 checklist has a second unexecuted doc fix (docs/dev/verification.md:19-21 still tells contributors to ignore "pre-existing" @openrouter/sdk/models typecheck errors) — worth batching into the same amend PR since it is the same orphaned checklist item, though outside this finding's stated path.

<details><summary>Verifier reasoning</summary>

Every factual claim checks out at HEAD except the release date. The doc's opening rationale is now false (repo is public, Apache-2.0) and its closing pointer is dangling (no texra-local section exists in CLAUDE.md; the scripts live in root package.json + scripts/link-texra-local.mjs). The check-guidance-refs gate only validates path existence, so neither defect trips CI. The strongest kill candidate — the 2026-08-01 audit proposal — turns out to be a prior order for the identical fix that was dropped during execution, which strengthens rather than defeats the finding. The proposed amend (reframe as source-checkout developer notes, repoint or drop the CLAUDE.md reference) preserves the verified-current install mechanics and loses nothing of value.

</details>

#### The CLI round-trips architecture note's mermaid diagrams cite one renamed and one deleted symbol, contradicting the doc's own prose

- **Kind**: amend · **Risk**: low · **Net**: 0 LoC
- **Files**: `docs/architecture/2026-06-20-cli-runtime-round-trips.md`

**Evidence**

The doc opens 'This note maps the current CLI ... paths' and was last swept 2026-08-24 (86dbf21336 'correct standing guidance that names symbols and files that are gone'), but that sweep missed the mermaid blocks: line 24 (startup flowchart) and line 136 (model-selection sequenceDiagram) both name `resolveCliRunnableModel`, which no longer exists anywhere in src/ or packages/ (0 rg hits); it was renamed to `selectCliRunModel` (packages/cli/src/runtime/runModel.ts:47), and the doc's own 'Refactor Targets' section at line ~208 already uses the new name — so the doc disagrees with itself. Line 88 (render flowchart) cites `StreamTabsStrip`, also 0 hits repo-wide. I verified the other ~50 real identifiers in the doc (runOrchestration, maybeRunCliOnboarding, buildCliOrchestrationItems, getCliModelAccessList, runChatTui, planTeamRuns, sessionSignalsAdapter, ...) all still resolve, and ran the same audit over the other three architecture docs, four dev docs, and design docs: only one other miss anywhere (agent-trace.md:140's `resolveActiveGroupId`, which appears in an explicitly historical sentence about a completed cleanup — fine as-is). The guidance-refs gate covers docs/architecture/ but checks only backticked path existence, never symbol names, so this class is invisible to CI. Dedupe: rounds 1-3 never touched docs/; not in the survey docs.

**Proposal**

Amend the three diagram nodes: `resolveCliRunnableModel` -> `selectCliRunModel` in both diagrams (matching the prose), and replace or drop `StreamTabsStrip` in the render flowchart with whatever component now renders the tab strip (verify in packages/cli/src/chat/tui/ when editing). Do not rewrite the rest — the flow, ownership list, and Refactor Targets sections were spot-verified accurate at HEAD.

**What we give up**

Nothing; pure correction of stale names in a doc that claims currency.

**Verifier corrections — these override the evidence and proposal above**

(1) MATERIAL: the proposed replacement symbol is wrong. `resolveCliRunnableModel` was renamed to `selectCliRunnableModel`, which exists today at packages/cli/src/runtime/modelAccess.ts:358 and is called with the same shape at the doc's exact sites (orchestrate.ts:95, runChatTui.tsx, chatSubmitDriver.ts:177, agentModelCommands.ts:78). `selectCliRunModel` (runtime/runModel.ts:47) is a different, higher-level wrapper that itself CALLS selectCliRunnableModel (runModel.ts:54). Applying the finding's edit as written would inject a wrong name: line 136's sequence-diagram arrow targets participant MA = modelAccess, and selectCliRunModel does not live in modelAccess. Correct edit: `resolveCliRunnableModel` -> `selectCliRunnableModel` at lines 24 and 136. (2) Consequently the "doc disagrees with itself" framing is off: line 209's `selectCliRunModel` mention (added by sweep 86dbf21336) refers to the root-model path in runModel.ts, a genuinely different current function — both statements coexist; the diagrams are stale, not contradictory. (3) MINOR: "StreamTabsStrip, also 0 hits repo-wide" is overstated — 0 hits in code, but 3 doc hits (agents/docs/archived/simplification/2026-07-09-tech-debt-audit-runtime-ui.md, agents/docs/archived/simplification/2026-07-10-cli-child-stream-state-consolidation.md, docs/dev/audits/2026-05-31-tui-performance-audit.md), all dated-historical and correctly out of scope per #9730. For line 88, the component was removed by #8404 which folded stream tabs into unified session navigation; the plausible current node is "StatusBar / SubagentList / side panels" (packages/cli/src/chat/tui/panes/SubagentList.tsx), to be confirmed when editing as the proposal itself says.

<details><summary>Verifier reasoning</summary>

The defect is real and verified against HEAD: two mermaid nodes name `resolveCliRunnableModel` (0 code hits) and one names `StreamTabsStrip` (0 code hits) in a doc whose opening sentence claims to map "the current CLI ... paths" and which the 2026-08-24 standing-guidance sweep explicitly tried to bring current — it fixed four other stale names in this file but missed these three sites (its commit message proves the omission). The guidance-refs gate only checks backticked paths, so nothing in CI catches stale symbol names; a manual amend is the only fix path. Precedent (86dbf21336 editing docs/architecture/ under the #9730 ruling) establishes these date-prefixed architecture docs as standing, amendable guidance. The finding survives but its prescription must be corrected before shipping: substitute `selectCliRunnableModel` (modelAccess.ts:358), not `selectCliRunModel`, at lines 24 and 136, and swap `StreamTabsStrip` at line 88 for the unified session navigation surface (likely SubagentList) after a quick check of App.tsx wiring. With the corrected names the amend is three token-level edits, zero net lines, no code impact, no consumer risk.

</details>

#### docs/README.md's public-surface summary omits half the published root pages that publicDocs.js declares

- **Kind**: amend · **Risk**: low · **Net**: 1 LoC
- **Files**: `docs/README.md`, `docs/.vitepress/publicDocs.js`

**Evidence**

docs/README.md ('TeXRA documentation map', last touched 2026-08-21) states '`index.md`, `launch.md`, and `providers.md` are public root pages.' The actual boundary in docs/.vitepress/publicDocs.js publicRootDocs is six entries: those three plus `work-using-texra.md` (a tracked, published page — commit 51c04c6 'docs: list remaining TeXRA papers on the public work page', #11365) and the build-generated `changelog.md`/`terms.md`. rg 'work-using' docs/README.md: 0 hits. The README does defer to publicDocs.js as source of truth two paragraphs later, which is why this is a one-line amend rather than anything larger — but a reader skimming the map is told a page listing the maintainer's published papers is internal when it is on texra.ai. No root-docs-gate implication: work-using-texra.md is already classified public, so no deploy risk (checked docs/scripts/check-root-docs.mjs semantics via publicDocs.js comments). Dedupe: no prior-round title touches docs/README.md.

**Proposal**

Add `work-using-texra.md` to the README's public-root sentence (optionally noting changelog.md/terms.md are generated public pages, mirroring the comment in publicDocs.js). One line in docs/README.md; publicDocs.js itself needs no change and is listed only as the cross-referenced authority.

**What we give up**

Nothing.

**Verifier corrections — these override the evidence and proposal above**

Two trivial inaccuracies in the evidence: (a) the README's deferral to publicDocs.js is the immediately following paragraph (lines 13-16), not 'two paragraphs later'; (b) the README's last touch (2026-08-21, 15002a6a46) was a rename/organization commit, not an edit of the public-surface sentence — that sentence predates work-using-texra.md's publication, which explains the drift. Neither affects the verdict. All other facts verified: publicRootDocs has six entries; work-using-texra.md tracked and published via 51c04c6f40 (#11365); changelog.md/terms.md are build-generated and gitignored per the publicDocs.js comment; docs/README.md is excluded from the public build.

<details><summary>Verifier reasoning</summary>

This is a documentation-accuracy amend, not a simplification claim, so the +LoC bar in checklist section 13 does not apply; the bar is whether the README actually misstates the boundary it summarizes, and it does. The stale sentence tells a reader that work-using-texra.md (the maintainer's published-papers page, live on texra.ai) is internal engineering material — exactly the kind of misclassification the README exists to prevent. The fix is one line in docs/README.md: extend the bullet to name work-using-texra.md and optionally note that changelog.md/terms.md are generated public pages, mirroring the publicDocs.js comment. publicDocs.js needs no change. No CI gate, publish boundary, or external consumer is affected. Files: docs/README.md (line 8), docs/.vitepress/publicDocs.js (lines 21-27).

</details>

### prompts-resources

#### The creator retry prompt has three owners and has already drifted: identical 2-line retryPrompt blocks in both agentCreator templates plus a differently-worded DEFAULT_RETRY_PROMPT fallback that is statically dead

- **Kind**: consolidate · **Risk**: low · **Net**: -4 LoC
- **Files**: `packages/extension/resources/templates/agentCreatorToolUse.yaml`, `packages/extension/resources/templates/agentCreatorWorkflow.yaml`, `src/agent/implementations/agentCreator/agentCreatorFlow.ts`

**Evidence**

agentCreatorToolUse.yaml:66-67 and agentCreatorWorkflow.yaml:122-123 both define byte-identical retryPrompt text ('The previous attempt failed validation: {{ VALIDATION_ERROR }}. Fix it and return only the YAML.'). agentCreatorFlow.ts:84 defines DEFAULT_RETRY_PROMPT with drifted wording ('Please fix and return only the YAML.') and applies it via `?? DEFAULT_RETRY_PROMPT` at :106-108 behind an `.optional()` schema field (:69). The fallback can never fire in production: the only loader of these templates is packages/extension/src/commands/agent/agentCreatorCommands.ts:36-42, which reads the two bundled files from extensionPath — there is no user-override path for creator templates. So of three copies, one is dead and the live two are duplicates; the wording drift is the proof that multiple owners already cost something. Dedupe: 'retryPrompt'/'DEFAULT_RETRY_PROMPT' appear in neither survey doc and no issue; the 2026-07-12 fallback-audit ruling 'keep validated template' (line ~1445) adjudicates the AI-output-fails-validation template fallback, not this string default, and its 'missing is not invalid' rule actually sanctions the shape this proposal keeps.

**Proposal**

Pick one owner. Cleanest per the fallback-audit's own 'missing is not invalid' rule: delete the retryPrompt block from BOTH bundled YAMLs and let DEFAULT_RETRY_PROMPT be the single owner (absence -> default), updating its wording to the currently-shipping 'Fix it' phrasing so behavior is byte-identical. Alternative with the same LoC: make the schema field required and delete the constant plus the two `??` arms, keeping the YAMLs as the owner — but that keeps the two-file duplication, so the first form is strictly better. This is a thin find on its own (~-4 net lines); batch it into any PR already touching the creator templates or flow rather than standing it alone.

**What we give up**

The ability for a hypothetical future user-supplied creator template to omit retryPrompt with per-file wording — no such input path exists today.

**Verifier corrections — these override the evidence and proposal above**

1. 'Byte-identical' is slightly wrong as stated: the YAML block scalars (`|`) yield values with a trailing '\n' (the sibling test asserts block-scalar newline preservation); DEFAULT_RETRY_PROMPT has no trailing newline. The updated constant must end with '\n' for true byte identity — practically immaterial (rendered via nunjucks into a retry message) but the claim needs the caveat. 2. The proposal as written trades one dead arm for another: keeping `retryPrompt: PromptStringSchema.optional()` plus the two `??` arms leaves a schema field no input ever supplies. The clean version also deletes the optional field, the two `??` arms (build retryPrompts directly from the constant), and the retryPrompt entries in the test fixture/it.each — netting roughly -8 to -12 instead of -4; if the field is dropped, the strictObject comment's fallback sentence needs a one-line update. 3. Loader citation is off by one: the buildCreatorConfig call is at agentCreatorCommands.ts:43, with the file reads at :29-42 (finding said :36-42). 4. Provenance nit: DEFAULT_RETRY_PROMPT was not born in agentCreatorFlow.ts — it lived in agentCreatorCommands.ts and moved via ca61155dc3 then 84e10bfe6f (2026-08-21); the drift is a relocation survivor, which if anything strengthens the multi-owner argument.

<details><summary>Verifier reasoning</summary>

Verified every factual leg against HEAD: byte-identical retryPrompt blocks at agentCreatorToolUse.yaml:66-67 and agentCreatorWorkflow.yaml:122-123; DEFAULT_RETRY_PROMPT at agentCreatorFlow.ts:83-84 with drifted wording applied via `??` at :107-108 behind `.optional()` at :69; single production loader in the extension host reading only bundled extensionPath files, so the fallback is statically dead in production. Checked all seven kill criteria: no duplicate in the 234-title index or survey docs, the 2026-07-12 fallback-audit row genuinely adjudicates a different fallback (the validated agentTemplate replacement for failed AI output), the strict-schema guard and its #8187 contract test survive the proposal untouched, and no host, wire, or user-override consumer exists for the creator templates. The wording drift is real evidence of multi-owner cost. The finding is thin but correct; it survives with corrections on the trailing-newline nuance, the residual dead optional field its minimal form leaves behind, and a fuller-cleanup option worth taking when batched.

</details>

#### CLI npm bundle ships docs/agent-creation that the CLI host cannot serve to anything — round 1's recorded keep-premise is already refuted by round 2's own evidence

- **Kind**: amend · **Risk**: low · **Net**: -1 LoC
- **Files**: `packages/cli/scripts/copy-resources.mjs`, `packages/extension/resources/docs/agent-creation/workflow_schema.md`, `packages/extension/resources/docs/agent-creation/tooluse_schema.md`, `packages/extension/resources/docs/agent-creation/tool_catalog.md`, `packages/extension/resources/docs/agent-creation/execution_and_testing.md`, `src/utils/files/externalRoots.ts`, `packages/extension/src/frontend/setup.ts`

**Evidence**

packages/cli/scripts/copy-resources.mjs:16 copies 'docs/agent-creation' (4 files, 473 lines, 24K) into the CLI dist. The only thing that makes those docs reachable is the external-roots registry plus the AGENT_DOCS_DIR template variable, and registration happens exclusively in the VS Code activation layer: grep for registerExternalRoot hits only packages/extension/src/frontend/setup.ts (5 call sites) and the registry itself; src/utils/files/externalRoots.ts:15 states 'Registration happens in the VS Code activation layer'. On the CLI, getAgentDirectoryVars (src/agent/prompt/userVars.ts:271-288) renders AGENT_DOCS_DIR as '' and the file tools reject the out-of-workspace path anyway (path protection default true) — all of this is already established, with line citations, in the round-2 refutation of the creator-flow retirement (agents/docs/archived/simplification/2026-08-26-simplification-survey-round2.md:3743-3760). Dedupe: round 1's verifier note (agents/docs/archived/simplification/2026-08-25-simplification-survey-49-candidates.md:2033) deliberately KEPT this copy row when trimming templates/ from the CLI bundle, on the premise that CLI agent creation 'drives creation through docs/agent-creation'. Round 2 then proved that premise false — the docs are bundled, not functioning, on CLI. gh issue searches for 'agent-creation'/'creator CLI roots'/'openai.yaml'/'retryPrompt' return no prior filing. Not on the overturned/policy-protected list (the CLI exclusion there is external-inquiry, unrelated). Desktop ships the same dead payload but wholesale (electron-builder.yml copies all of ../extension/resources), so it has no per-entry row to trim.

**Proposal**

Two coherent resolutions; the maintainer should pick one rather than leave the current half-state. (a) Precedent-matching trim: delete the 'docs/agent-creation' row from runtimeResourceEntries in packages/cli/scripts/copy-resources.mjs, exactly as round 1 did for templates/ — one line, 24K off the npm tarball, trivially reverted. (b) The direction round 2 recorded as 'the real prerequisite work, unfiled': move registerAgentDirectoryRoots out of extension activation into a host-neutral composition step so creator actually functions on CLI/desktop, which turns the shipped docs into live payload. If (b) is imminent, skip (a) and file (b) as its own issue; if (b) stays unfiled, ship (a) and note the revert condition in the commit message.

**What we give up**

Option (a) gives up nothing today (the docs are unreachable on CLI), but must be reverted in the same PR that ever wires external roots host-neutrally — record that condition. It also slightly deepens the extension/CLI asymmetry that round 2's refutation criticized.

**Verifier corrections — these override the evidence and proposal above**

1. Path list omits packages/cli/scripts/validate-pack.mjs. Its lines 13-14 comment ("The CLI resolves agent creation through resources/docs/agent-creation, so none of these belongs in the published tarball") is the in-repo guard explanation for EXTENSION_ONLY_TEMPLATES and becomes false after option (a); it must be rewritten in the same PR. The finding defeats the premise only via the survey docs, not this in-code comment. 2) "24K" is on-disk block size; actual payload is ~17.7K bytes (473 lines verified). 3) Round-2's refutation is not merely "own evidence" against round 1's keep-premise — it also independently established the file-tool rejection path (pathResolution + TOOL_PATH_PROTECTION default true), which I re-confirmed only via the registry-empty/AGENT_DOCS_DIR='' route; both routes independently make the docs unreachable, so the conclusion stands either way. 4) Additional CLI resourcesPath consumers exist beyond the three round 2 listed (history.ts trace-viewer readers, doctor.ts directory check) — verified none reads docs/, so the dead-payload claim still holds, but the evidence chain as quoted was incomplete.

<details><summary>Verifier reasoning</summary>

Verified at HEAD: copy-resources.mjs:16 still ships docs/agent-creation; registerExternalRoot has production call sites only in packages/extension/src/frontend/setup.ts, so on CLI the external-roots registry is empty, AGENT_DOCS_DIR renders '' (userVars.ts:281), and the sole consumer (tool_use_agents/creator.yaml:34,44) points nowhere; no CLI resourcesPath consumer (bundledPrompts, bootstrapNodeAgentDirectories=['agents','tool_use_agents'], skills, trace-viewer readers, doctor) touches docs/. Not a duplicate: rounds index line 52 is the shipped templates trim that deliberately kept this row on a premise round 2's refutation (round2.md:3743ff) proved false ("bundling, not functioning"); line 152 is the refuted creator retirement, a different proposal. No round-3 PR (#11452-#11460) overlaps; no prior gh issue. No dated ruling protects the payload: the SDK-readiness reverify ruling keeps the creator _boundary_ open (interactive-UI work), and round 2's refutation itself names option (b) as unfiled prerequisite work — the finding's fork (trim now, or file the host-neutral roots move) is exactly the coherent resolution of the recorded half-state. validate-pack.mjs neither asserts the docs' presence nor blocks their removal; desktop wholesale-copy claim verified in electron-builder.yml:45-49. Cost honest: one deleted row plus a comment rewrite; the real win is ~18K off the npm tarball and retiring a false recorded premise. No external consumer reads dist/resources/docs (texra-action consumes result JSON only). Revert condition (re-add the row when external roots go host-neutral) is correctly recorded.

</details>

## 3. Keep rulings

8 apparent redundancies were examined and found to be the right shape. Do not re-open one without evidence that beats the reasoning here.

#### appendTextToLastAssistantMessage: seven parallel implementations share a skeleton, but hoisting a template method into ModelHandler nets ~0 and fights the SDK-native-types rule — keep as is

Abstract at ModelHandler.ts:1258, single production caller at ModelHandler.ts:1593 (addContinueMessage path). Seven overrides: anthropic:1331 (requires trailing user with array content + containCutOffMessage, pushes textBlock, logs preserved thinking blocks), openai:876 (also accepts role 'system' trailing), openaiResponse:2488 (isMessageItem narrowing, delegates to per-shape appendAssistantText at :2876), google:1191 (pops the continuation step FIRST, then appends into model_output's last text content — a different order from the other six), openrouterNative:678 (two isAnthropicViaOpenRouter special branches, one replacing instead of appending text), vscodelm:376 (immutable — replaces messages[i] via appendText), validation:225 (constant false). jscpd flags the anthropic/openai/openaiResponse trios as 58-60-token clones, which is what makes this the file-duplication signal worth ruling on. A base-class template method would need at least four abstract hooks (trailing-message-is-continuation predicate, assistant-target predicate, append-into-content, pop-behavior), each generic over the handler's SDK message type M — the variance is exactly the per-wire message shape, which the repo rule 'prefer native SDK types' (and the round-3 KEEP precedent that per-handler restatement of shared shape is correct, e.g. availability/dispatch route precedence) says belongs in each handler. Skeleton is ~10 lines/impl x 7 = ~70 removable lines against ~40 base lines plus 7 hook sets of 15-25 lines: net approximately zero or positive LoC, plus one new abstraction seam on the frozen-adjacent handler contract.

Record as a keep ruling so a future round chasing the same jscpd clone signal (anthropic:1332 ~ openai:877 ~ openaiResponse:2489) does not re-open it. New evidence that would defeat this: two chat-completions-shaped handlers becoming byte-identical (today openrouterNative deliberately extends ModelHandler, not ModelHandlerOpenAI, and carries Anthropic-via-OpenRouter branches).

#### writeSessionDescription's swallow-and-debug is a documented L3 best-effort side write — examined, correctly shaped

executionLifecycle.ts:318-334: the catch swallows storage I/O errors when persisting the AI-generated session description and logs at debug. Examined against the taxonomy and ruled legitimate L3: the required comment is present and states the reason ('Best-effort... Never throws: the description is presentation metadata, not lifecycle state'), the write is serialized through enqueueMetaUpdate (:65 comment documents the race it prevents), and the checklist's no-downgrade-below-warn rule targets read failures that change run behavior — this is a side write whose failure costs only a display label. The only defensible tweak would be debug->warn for symmetry with the rest of this file (every other catch here logs warn or aggregates), but the site's comment explicitly defeats a masking claim, and the surface brief's 'what the code says it is for' rule applies. Recording as keep so round 5 does not re-litigate it. Dedupe: no rounds-index or survey-doc entry names writeSessionDescription.

Keep as-is. If the maintainer wants strict loudness symmetry within executionLifecycle.ts, the one-word debug->warn change is safe, but the current shape satisfies the L3 contract (comment present, never run-critical) and needs no PR.

#### KEEP ruling: ws in @texra-ai/agent looks dead (zero source imports) but is load-bearing for the bundled patched openai

ws has zero imports across src, packages/_/src, packages/_/scripts, and scripts (rg for every import/require form), no package peers on it (pnpm why: only a regular transitive of @google/genai, openai, ink), no supabase realtime usage exists, and knip.json ignoreDependencies:['.*'] means no gate would ever flag it — a textbook-looking dead dependency row. It is not: bundle.mjs:22-25 deliberately bundles the pnpm-patched openai runtime into dist ('Consumers do not inherit pnpm patches'), the emitted chunk contains `import * as WS from "ws"` (packages/agent/dist/chunk-RC3X6SLF.js, openai's realtime WebSocket shim), and validate-artifacts.mjs:140-150 fails the build on any dist import that is not in dependencies/peerDependencies. Deleting the row breaks `npm run check:artifacts` and, for npm consumers of the published package, module resolution inside the bundle.

Keep the ws dependency row. Recording this so no future dependency sweep proposes it: an in-repo import grep cannot clear an @texra-ai/agent dependency — the dist bundle is the consumer corpus for that manifest, exactly the external-consumer class this round was warned about. If anyone wants ws gone, the actual lever is pruning openai's realtime module from the bundle graph, an openai-internal reachability question not worth owning.

#### KEEP ruling: the rest of the commands/settings/agents product surface is healthy — catalog-driven, machine-verified, fully registered, and fully documented

Commands: all 50 contributed rows come from the commandCatalog SSOT (sync-package-contributes.mjs writes contributes.commands and keybindings; CommandCatalog.vitest diff-checks); every id resolves to a handler — 39 through EXTENSION_COMMAND_HANDLERS, the rest through bespoke registrars (agentReview via registerAgentReviewCommands, comment trio via inlineComments.ts with real comments/commentThread/* menus, showMainView in commands.ts) — no contributed-but-unregistered command exists. The palette:false rows (pack, clean, stopAgent, openDoc, packSingle-family) are genuine webview/tree dispatch targets (packages/extension/src/webview/managers/executionHandlers.ts:130-155), not dead surface. toggleView/showMainView/showProgressView are one toggle plus two direct jumps over the same view id — distinct actions, not duplicate homes. Settings: spot-checked every suspicious core key (audio.soxPath, wrapCritiqueInAlign, autoOpenFinal, zoteroPort, openaiParallelToolCalls, useGoogleBackgroundResponses, tempFileLocation, numberOfCommitsToShow, runOnCommit, texfmtConfig, latexindentConfig, gpt5ReasoningSummary, maxImageDimension, tikzTemplate/tikzInputDirectory, skills.enabled, debug.saveModelIO, logger.debugMode) — every one has a non-test production reader; the stateSettings catalog's honoredBy/reachability rows are path-verified per the round-3 KEEP ruling, and the one documented-removed family (texra.files.included./ignored., docs/guide/configuration.md:103-105) is a deliberate removal notice, not drift. Agents: all 24 bundled YAMLs (5 workflow + 2 write/ + 17 tool-use) have a named section in docs/guide/built-in-agents.md; team presets reference only names that resolve locally or are declared texraHostedAgents, and listing bundled names (lean, presenter) there is inert because every consumer intersects with unresolved names (src/common/teams/TeamPlan.ts:137-140, ApplyTeamTool.ts:169-175) — matching the in-file 'harmless because roster application intersects' comment. Docs cite six palette titles and all six match live command titles. Also checked and cleared: chatSkills and languageModelTools contributions (all 3 LM tools registered in registerLanguageModelTools.ts; both keys covered by verify-extension-package-invariants), walkthrough command: links (all four target live commands), and the setup agent's dual entry (command wrapper adds credential preflight; the dropdown launch is fully functional, unlike changeReviewer's).

Record this as the round-4 ruling for the product surface so later rounds don't re-audit it: apart from the two findings above, no command, settings row, or bundled agent on this surface is unreachable, unregistered, undocumented, or a second home for an action the product already owns. The '23 agents' figure in the walkthrough copy (packages/extension/package.json:527, resources/walkthroughs/getting-started.md:35) is the only unverifiable count found (24 bundled today) — not worth a standalone finding; fold into the next copy pass.

#### The uninvoked-by-automation scripts are manual operator tools, not dead: capture:walkthrough-media, validate:pack, desktop package:dir/test:e2e, and the vscode:prepublish guard

Each looks dead to an invoker grep but has a live manual purpose: (1) capture:walkthrough-media (package.json) has zero references in workflows or docs, but it regenerates packages/extension/resources/walkthroughs/media/*.png, which are contributed by packages/extension/package.json:493-597 walkthroughs and were last produced by commit fbd672728d ('docs: capture walkthrough screenshots'); it shares scripts/webview-electron-harness.mjs with the CI-wired webview smoke. (2) validate:pack (packages/cli/package.json:52) is documented as deliberately manual in agents/docs/archived/architecture/2026-07-09-state-of-the-architecture.md:843 (QA-4 row), which proposes wiring it into CI, not deleting it. (3) desktop package:dir is invoked by scripts/run-desktop-package-local.mjs:60; test:e2e is the manual desktop suite documented in packages/desktop/tests/e2e/README.md and playwright.config.ts. (4) vscode:prepublish's SKIP_VSCE_PREPUBLISH guard fires only under a manual `vsce package` — the repo's own build:fast sets SKIP=1 and release.yml publishes a pre-built VSIX — so the non-skip branch is the escape hatch for exactly that manual path.

Keep all of them. Recording the ruling so a later round does not re-run the same invoker greps and mistake operator tooling for dead scripts.

#### The .local-before-pull proposal snapshot stays: it is a deliberately labeled historical record, not drift

This 224-line file is a 97% byte-duplicate of its canonical sibling (diff = the 5-line banner plus one ~7-line divergence about buildResultMeta), which makes it look like an accidental merge artifact ripe for deletion. It is not: two dedicated commits curated it — fd253865ce 'docs: date workflow script proposal snapshot' (#9116) and 8f97ae42a1 'docs: label workflow proposal snapshot' (#9136) — and the banner it carries states its reason for existing: 'Historical snapshot (not authoritative). This file preserves the local-before-pull state of the proposal', with a link to the canonical version. Under the round-3 lesson (a doc that states why it exists must have that statement defeated, not reasoned past) and the skill's rule that dated proposals are rulings, the deliberate label defeats the deletion case: the preserved delta records what the pre-pull design got wrong (it expected buildResultMeta wiring; the canonical version explains why that was intentionally omitted), which is exactly the kind of decision provenance rounds 2-3 used to kill wrong findings. Recording this as KEEP so a future docs sweep does not re-flag the near-duplicate.

Keep as-is. If a future maintainer wants the duplication gone, the only acceptable shape is folding the 7-line divergence into a 'superseded alternative' footnote inside the canonical proposal and deleting the snapshot in the same change — but nothing forces that now, and the labeled-snapshot decision in #9136 stands.

#### KEEP: the 14 skills/*/agents/openai.yaml sidecars have zero in-repo loaders, and that is the documented shape — they are portability metadata for Codex-style consumers, not dead resources

All 14 bundled skills carry an agents/openai.yaml sidecar (56 lines total) whose keys — interface.display_name/short_description/default_prompt — have zero consumers: grep across src/, packages/*/src, and scripts/ returns nothing, and src/skills/skillLoader.ts + SkillSchema.ts read only SKILL.md name/description/body. But the absence of a loader is stated intent, not rot: docs/dev/skill-authoring.md:18 rules 'Treat agents/openai.yaml as optional product metadata, not part of the core skill contract', :3 states skills 'are intended to stand on their own — a person using one of these skills should not need access to this repository', and agents/docs/archived/feature/2026-05-14-skills.md:24,74 document the codex-style layout (SKILL.md + references/ + agents/openai.yaml side-car) as the deliberate package shape, matching the format OpenAI Codex reads for UI metadata when a user drops a skill into its skill dirs. An in-repo grep cannot prove these unused because the intended consumer is outside the repo (the same class of external-consumer trap this round's brief warns about). Surveyor trap also recorded here: packages/extension/resources/skills/ is a gitignored build copy of root skills/ (scripts/copy-extension-skills.mjs rm+cp), so the source of truth for all skill edits is root skills/.

No change. Record this ruling so later rounds do not re-file 'resources nothing loads' against the sidecars. Re-opening requires evidence that defeats the documented portability contract — e.g. a decision that TeXRA skills no longer target codex-compatible consumption.

#### KEEP: the Voice and File-Output-Rule paragraphs copy-pasted across 8 agent YAMLs are deliberate per-agent prompt text — no shared default exists, and creating one would add an element over semantically varied copy

Line-level duplicate scan across all bundled and remote agent YAMLs: the 'Voice: Write plain technical English…' paragraph appears verbatim in 8 files (6 bundled tool_use_agents + 2 remote); the 'CRITICAL - File Output Rule…' paragraph appears in 7, but in THREE deliberate wording variants ('Standard math prose is fine' in assistant/research, 'The output must be self-contained' in lean/prover/review, 'Standard academic prose only' in remote presenter) — the tails are agent-specific, not drift. No shared default exists to fold onto: the inherits: mechanism (AgentDataclass.ts, agentDefinitionInheritance) is used by zero bundled YAMLs, and no fixed template variable carries shared prose. Deduplicating would therefore ADD an element (a base agent or a new fixed variable) and put model-facing text behind indirection, against §13 abstraction-cost guardrails; prompts/README.md's rule that 'prompt changes require review of the final resolved prompt' makes every future edit to an included fragment an 8-agent behavior review. The remote copies are additionally outside a pure in-repo fix: prompts/agents/remote/ syncs manually to the agent-configs bucket, so a shared owner spanning both corpora cannot exist in the repo at all.

No change; record the ruling so a shared-include/base-agent mechanism does not get proposed for this duplication. The cheap real safeguard already exists: when the Voice paragraph is next edited, a single grep for 'Voice: Write plain technical English' finds all 8 sites.

## 5. Acceptance criteria

- `npm run typecheck`, `npm run lint`, `npm run format`, affected suites, and `npm run check:dead-code-ratchet` clean per PR.
- Where a deleted export had a baseline row, `config/ratchets/knip-baseline.json` shrinks in the same PR. Never add a row.
- A defect fix (`amend`) must make the failure **loud** — `warn` plus a surfaced cause — not merely delete the fallback.
- Anything touching the CLI NDJSON vocabulary, a persisted file, a settings key, or the texra-action result contract needs evidence beyond an in-repo grep.
