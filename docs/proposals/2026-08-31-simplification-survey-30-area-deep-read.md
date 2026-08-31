# Simplification survey: 30-area deep read (2026-08-31)

Status: survey and implementation complete. Eleven candidates were accepted in
four validated batches; S11 was rejected during type-boundary validation. The
evidence target is `origin/main` at
`de922616af7c232c438999ef8023b2600278500d`.

## Result

Thirty non-overlapping areas were assigned separately and read in waves by
three subagents. The fourth concurrency slot was occupied by the coordinating
agent, so completing thirty areas required reassigning each subagent after its
previous report rather than combining several areas into one nominal report.

The initial survey produced twelve candidates after repository-wide consumer
searches, history and proposal deduplication, and a separate adversarial
verification pass. Twenty areas produced no new candidate. One additional
reflection finding is a wider form of an already recorded item and is
consolidated there rather than counted again.

Eleven candidates survived implementation validation and were divided into four
independent changes. Across production code, tests, and configuration, the four
patches contain 289 insertions and 607 deletions, a measured net reduction of
318 lines, excluding this report. S11 was rejected because activating the Vite
client declarations would widen global types in Node-only compilation graphs;
`skipLibCheck` concealed declaration conflicts but did not preserve the
original type boundary.

## Method and evidence boundary

The survey followed `.claude/skills/find-simplification/SKILL.md`, the project
review checklist, the simplifier instructions, the architecture guidance, and
the repository's testing discipline. Each area performed the following work:

1. Read every assigned production source file, not merely search results.
2. Count all production, test, script, configuration, and documentation
   consumers of a proposed surface.
3. Check relevant history, earlier survey records, open and closed issues, and
   open and merged pull requests.
4. Reject changes that merely rename complexity, cross a lifecycle or wire
   boundary, weaken error handling, or delete consequential regression
   coverage.
5. Re-read every file changed by main while the survey was running.

The working tree contained unrelated work in progress. It was therefore not
used as evidence for any changed file. Audits read Git blobs from `origin/main`,
and no source file, Git ref, dependency, issue, or pull request was changed by a
subagent.

Two reconciliation passes covered the main-branch advances during the survey.
The first read 20 non-CLI files (8,571 lines) changed by #11657, #11659,
#11660, and #11661; the affected CLI files were re-read inside Areas 25, 27,
28, and 29. The second read the 29 extension production files changed by
#11656. These passes found no residual candidate and no contradiction with the
twelve candidates below. At the close of the survey there was no open pull
request.

Area 30 excluded one generated 706-line extension-invariant snapshot after
verifying its checked-in generator. Its 158 live text/source files, including
the two walkthrough capture scripts (1,139 lines combined), were read in full.

## Thirty-area ledger

| Area | Assigned scope                                                                                                                     | Result                              |
| ---: | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
|    1 | Agent kernel, core, index, nodes, types, storage, and trace                                                                        | No new candidate                    |
|    2 | Runtime session and interaction ownership                                                                                          | S1                                  |
|    3 | Runtime execution and lifecycle                                                                                                    | S2, S3                              |
|    4 | Reflection flow and output pipeline                                                                                                | S4, S5; one prior item consolidated |
|    5 | Tool-use flow, workflow-script engine, and agent creator                                                                           | S6                                  |
|    6 | OpenAI model handlers and their support utilities                                                                                  | No new candidate                    |
|    7 | Other model handlers and miscellaneous agent/export modules                                                                        | S7                                  |
|    8 | Delegation, approvals, and executions tools                                                                                        | No new candidate                    |
|    9 | GitHub, inquiry, arXiv, citation, Zotero, and web tools                                                                            | S8                                  |
|   10 | Remaining tools                                                                                                                    | No new candidate                    |
|   11 | Shared schemas                                                                                                                     | No new candidate                    |
|   12 | Shared non-schema code                                                                                                             | No new candidate                    |
|   13 | Controllers                                                                                                                        | No new candidate                    |
|   14 | Platform, common, auth, logger, events, housekeeping, telemetry, skills, and host ports                                            | S9                                  |
|   15 | Utilities and model selection                                                                                                      | No new candidate                    |
|   16 | LaTeX and replacement engine                                                                                                       | S10                                 |
|   17 | Transcript and ambient/source types                                                                                                | S11                                 |
|   18 | Extension top level, commands, frontend utilities, and extension common code                                                       | No new candidate                    |
|   19 | Extension main webview                                                                                                             | No new candidate                    |
|   20 | Progress-view host, top level, state slices, and formatters                                                                        | No new candidate                    |
|   21 | Progress-view components and styles                                                                                                | No new candidate                    |
|   22 | Settings view                                                                                                                      | No new candidate                    |
|   23 | Desktop main process and preload                                                                                                   | S12                                 |
|   24 | Desktop renderer and shared desktop code                                                                                           | No new candidate                    |
|   25 | CLI runtime, initialization, onboarding, orchestration, configuration, schemas, and binary entry                                   | No new candidate                    |
|   26 | CLI commands                                                                                                                       | No new candidate                    |
|   27 | CLI chat controller, state, and chat commands                                                                                      | No new candidate                    |
|   28 | CLI forms, input, modals, notifications, history, and common TUI code                                                              | No new candidate                    |
|   29 | CLI panes, rendering, and chat shell                                                                                               | No new candidate                    |
|   30 | Scripts, packaged resources, prompts, Supabase functions, agent package, trace viewer, ratchets, and executable root configuration | No new candidate                    |

The last six CLI/tooling partitions provide useful scale checks: Area 25 read 83
files (14,951 lines), Area 27 read 38 (9,030), Area 28 read 62 (9,384), Area 29
read 37 (13,030), and Area 30 read 158 (23,632). Area 1 independently read 65
files (11,882 lines).

## Candidate outcomes

| ID  | Simplification                                                              |                                 Conservative estimated deletion | Risk       |
| --- | --------------------------------------------------------------------------- | --------------------------------------------------------------: | ---------- |
| S1  | Carry the exact resolved agent description through launch context           | 6-8 production lines; resolver test scaffolding also disappears | Low        |
| S2  | Return the child-loop completion promise directly                           |         About 7 production lines; callers and tests also shrink | Medium     |
| S3  | Remove the dead runtime `SessionEvent` re-export                            |       A 6-line Knip baseline entry; zero net source-line change | Low        |
| S4  | Return only the latest compiled-PDF location                                |                                          14-18 production lines | Low-medium |
| S5  | Use one response-cycle state interface                                      |                                          14-18 production lines | Low        |
| S6  | Give fresh and resumed tool-use preparation one prompt-construction site    |                                           8-10 production lines | Low        |
| S7  | Replace nine never-parsed chat-export schemas with types                    |               25-35 production lines and nine runtime constants | Low-medium |
| S8  | Return inquiry manifests directly                                           |           25-30 production lines and three carrier declarations | Low-medium |
| S9  | Delete the permanently empty input-directory exclusion channel              |                               6 production lines and two fields | Low        |
| S10 | Delete unread replacement metadata                                          |                                             47 production lines | Low        |
| S11 | Use Vite's existing asset declarations                                      |                                            22 declaration lines | Rejected   |
| S12 | Remove the desktop lifecycle facade and inline its one-call relaunch helper |                 About 41 production and 46 redundant test lines | Medium     |

### S1. Carry the exact resolved agent description

`AgentLaunchContext.ts:281-292` resolves and loads the exact `ResolvedAgent`
chosen for launch, including its source and category. That result's description
is discarded. `sessionDescription.ts:120-134` consequently calls
`resolveAgentForLaunch` a second time, even though its sole production caller,
`executeAgent.ts:435-441`, already holds the launch context.

Add the resolved description to `AgentLaunchContext`, pass it to
`generateSessionDescription`, and delete the second resolver import, call,
comments, and resolver-specific test mocks. This preserves the resolution rule
introduced by the earlier session-description fix while making it impossible
for a registry change between the two lookups to label a run with another
entry's description.

### S2. Return the child-loop completion promise directly

`ChildRunLoopHandle` in `childRunLoop.ts:364-367` contains only
`completion: Promise<void>`. Both production consumers, `agentCliShared.ts` and
`detachedChildRun.ts`, immediately unwrap that property. Return the existing
caught promise directly and delete the one-field interface and object wrapper.

The function must remain synchronous. Setup and launch failures currently
throw synchronously, allowing caller `try`/`catch` blocks to unwind resources.
The terminal `.catch` at `childRunLoop.ts:1240-1245` must remain on the returned
promise. Turning the function into an `async` function would change this
failure boundary and is not part of the candidate.

### S3. Remove the dead runtime `SessionEvent` re-export

`src/agent/runtime/index.ts` re-exports the `SessionEvent` type, but no source,
test, script, or package import obtains it from `@agent/runtime`.
`packages/agent/src/index.ts` does not expose it publicly. Remove only the
barrel re-export and the matching production-dead entry in
`config/ratchets/knip-baseline.json`; retain the leaf type in
`SessionEventHub.ts`.

### S4. Return only the latest compiled-PDF location

`publishCompiledPdfArtifact` writes both the round-specific and stable latest
PDF copies. This side effect remains necessary. Its two-field
`CompiledPdfArtifact` return value is not: production consumers read only
`latestPdf`, while the round `pdf` field is read only by tests that already
inspect the round file on disk.

Return `RunStorageFileLocation | null` for the latest copy, keep both file
writes, replace the propagated artifact arrays with location arrays, delete
`CompiledPdfArtifact`, and make `PublishCompiledPdfOptions` module-private.
The existing filesystem assertions continue to protect both copies.

### S5. Use one response-cycle state interface

`ResponseCycleFlow.ts:38-74` divides the cycle object into `CycleFields` and
`CycleTransientFields`, then immediately intersects them into
`ResponseCycleShared`. `ResponseCycleNode.ts:92-112` constructs this object in
memory and passes it directly to the flow. There is no parse, clone,
persistence, or wire boundary corresponding to the claimed
serializable/transient partition.

Replace the three declarations with one
`ResponseCycleShared extends BaseCycleFields` interface. This completes the
direction of #11568, which removed the unused runtime schema but left its
fictional serialization partition in the type structure.

### S6. Give tool-use preparation one prompt-construction site

The resumed and fresh branches of `ToolUsePrepareNode.exec` call
`buildInitialToolUsePrompts` with identical arguments and separately construct
the same system text. Emit the resume diagnostic first, perform the shared
await once in source, build the system text once, and branch afterward.

The resumed branch must continue to use `resumeShared.messages` verbatim; its
prompt-cache explanation remains valid. Keep the fresh branch's empty-state
constructors before the shared await, for example in a conditional fresh-state
object, so their exceptional-path ordering is unchanged as well. No new test is
required; the existing resume suite already protects fresh system text and
persisted-message identity.

### S7. Replace nine never-parsed chat-export schemas with types

Six Zod constants in `src/agent/export/schemas.ts` and three in
`normalizeConversation.ts` are used only through `z.infer` and schema
composition. None has a `.parse` or `.safeParse` consumer. The export
intermediate representation is produced and consumed inside one process, and
raw provider values are already narrowed by the real guards in
`normalizeConversation.ts`.

Replace these nine runtime constants with TypeScript interfaces and
discriminated unions. Preserve canonical ownership rather than hand-copying
field sets:

- define the search projection through
  `Pick<WebSearchResult['results'][number], 'title' | 'url'>`;
- make `ExportAttachmentType` an alias of `MediaAttachmentKind`;
- retain the discriminated `ContentBlock` union; and
- retain every provider-wire and persisted schema that is actually parsed.

This does not weaken schema-first design: it removes schema values from a place
where no validation boundary exists.

### S8. Return inquiry manifests directly

`PersistedOpenTurn`, `PersistedAnsweredTurn`, and generic
`OpenTurnUpdate<T>` in `externalInquiryStorage.ts` wrap the manifest with data
that no production caller reads separately. The open caller needs the manifest
and its `threadId`; the answer caller needs only the manifest.

Make `withOpenTurnUpdate` accept and return
`ExternalInquiryThreadManifest | null`, write that manifest under the same
`threadMutex.runExclusive` block, and return the just-written writer snapshot.
Have `recordOpenQuestion` and `recordAnswerForOpenTurn` return manifests
directly. This preserves locking, stale-action arbitration, and the deliberate
absence of a write/read race. Existing tests can inspect the last manifest turn
instead of a duplicate `turn` field.

### S9. Delete the empty input-directory exclusion channel

`FILE_HANDLING_RULES.ignored.inputDirectories` is fixed to an empty array.
`loadFileListSettings` renames it to `ignoredInputDirectories`, and
`buildInputLikeConfig` spreads that empty array into the ordinary ignored
directories. These are the only four occurrences; there is no alternate
constructor, setting, test, or documentation source.

Delete both fields and pass `settings.ignoredDirectories` directly. File
discovery policy has been non-configurable since #9593, so this is exact
behavioral equivalence rather than retirement of a setting.

### S10. Delete unread replacement metadata

The replacement engine never reads category `description`. Remove that field
from both category interfaces and from all 23 category literals. Fourteen
non-regex literals also spell `isRegex: false`; omit those values because the
non-regex interface already permits the absent value and the engine tests the
property only for truth.

Retain `NonRegexReplacementCategory.isRegex?: false` on the interface so
`category.isRegex` continues to narrow the union. Retain all nine
`isRegex: true` values, the regular-expression flags, category names, and the
settled category-name type locks.

### S11. Use Vite's existing asset declarations — rejected

Implementation validation showed that the `vite/client` triple-slash reference
was inert in its former position. Moving it to the declaration-file header made
the Vite client globals active in Node-only compilation graphs and introduced
duplicate browser declaration copies. `skipLibCheck` hid the resulting
conflicts without restoring the former type boundary. The local asset
declarations were therefore retained.

### S12. Remove the desktop lifecycle facade and inline the relaunch helper

`installDesktopLifecycleComposition` owns no state. Its two calls in desktop
`index.ts` each select exactly one optional branch: window lifecycle wiring or
before-quit wiring. Call `bootstrapDesktopWindowLifecycle` and
`installDesktopBeforeQuitWiring` directly at those same startup positions and
delete `desktopLifecycleComposition.ts` and its two local option types.

The facade's two tests repeat the more complete
`DesktopWindowLifecycle.vitest.ts` coverage. Although #11468 introduced the
facade during a broad test deletion, its tests execute the facade directly and
therefore do not prove that desktop `index.ts` calls it. Deleting the forwarding
layer loses no composition-root guarantee that exists today.

Separately, inline the private, single-caller
`handoffDesktopWorkspaceRelaunch` body into its exported main-process boundary.
Keep that exported boundary and the two `DesktopDevScript` cases that protect
the supervised-send and packaged-relaunch branches.

## Consolidated and rejected observations

- Area 4 found a wider form of the previously recorded
  `hasRoundOutputs`/`hasCompileFailures` output-state accessor deletion in
  `docs/proposals/2026-08-07-prod-structural-leads-triage.md`. The wider change
  may also remove `getOutputFilesByRound`, `setCompileFailures`, and
  `LatexDiffManager`'s injected getter. It should amend that record rather than
  create a duplicate candidate.
- Making `UsageMonitor.recordUsage` synchronous removes only about two lines
  and changes a promise/microtask boundary. It does not justify a separate
  change.
- `parseApprovalDecision` in the Supabase device-auth function is a justified
  single-caller helper. #8266 introduced it and its focused Deno suite after
  the former code treated every value except literal `false` as approval. The
  suite is the narrow regression boundary for a consequential authorization
  contract and must remain.
- Removing only the `TraceDataSchema` export changes no source line and would
  churn the deliberate trace-wire tests. The former duplicate trace schema was
  already removed by #8941.
- The two packaged `template_slide.tex` files are category-relative resources;
  customized agent copies require each category's local file. Their apparent
  duplication was already rejected in the 2026-08-25 survey.
- The walkthrough capture scripts and their generated images are live package
  and CI inputs, not abandoned maintenance scripts.
- Named test seams, lifecycle state, persisted and wire schemas, provider
  routing distinctions, browser/Node boundaries, and CLI cancellation,
  approval, transcript, and shutdown ownership were retained unless the read
  established exact equivalence.
- Work merged in #11656, #11657, #11659, #11660, and #11661 was treated as
  owned work, not reported as a new finding. Current-version reads found no
  independent residue in those diffs.

## Implementation batches and verification

The accepted candidates were implemented on four branches, each based directly
on the evidence commit:

1. [PR #11682](https://github.com/LionSR/TeXRA/pull/11682)
   (`codex/simplify-core-data-layers`): S3, S5, S9, and S10. This batch
   removes 79 lines net. Its focused suites ran 84 tests, and the workspace
   typecheck, lint, formatting, and dead-code ratchet all passed.
2. [PR #11683](https://github.com/LionSR/TeXRA/pull/11683)
   (`codex/simplify-agent-runtime-carriers`): S1, S2, S4, and S6. This batch
   removes 91 lines net while preserving synchronous child-run failures, both
   compiled-PDF writes, and resumed-message identity. The focused suites ran
   242 tests, and the workspace, test-kernel, and CLI typechecks passed.
3. [PR #11684](https://github.com/LionSR/TeXRA/pull/11684)
   (`codex/simplify-export-inquiry-data`): S7 and S8. This batch removes 58
   lines net. The export/parity suites ran 83 tests, the inquiry suites ran 68,
   and the workspace, test-kernel, and CLI typechecks passed.
4. [PR #11685](https://github.com/LionSR/TeXRA/pull/11685)
   (`codex/simplify-desktop-lifecycle`): S12. This batch removes 90 lines net.
   The desktop lifecycle suites ran 26 tests, and the desktop and test-kernel
   typechecks passed.

Each batch also passed file-scoped ESLint and Prettier checks together with
`git diff --check`. No changelog entry is needed because these changes preserve
user-visible behavior.
