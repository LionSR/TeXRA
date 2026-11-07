# I. LaTeX and documents: design red flags

Area: `packages/texra/src/latex/`, `replacement/`, `tools/latex/`,
`tools/documents/`, `agent/output/`, with the shared contracts they are the
one writer of (`shared/plugins/documents.ts`, `shared/plugins/documentOutputs.ts`,
`shared/constants/workflowOutput.ts`) and the toolchain catalog
(`shared/constants/latexToolchain.ts`) the brief names. Read-only, at the
working tree of 2026-11-06 (`73e0225`). Paths below are relative to
`packages/texra/src` unless they start with `packages/`. Consumer counts are
files over `packages/*/src` (production) and `src/test-kernel`,
`packages/*/test` (tests), from `grep -rl`.

The area is Effect-native already: no `new Promise`, no `async`, no timers, no
`Date.now()`, no `catch {}`; one `.then(` and one `AbortSignal`, both in
`latex/arxivProcessor.ts` (finding 8), and one hand-rolled request lifetime
(a cleanup array, a `Deferred` read with `isDoneUnsafe`, an in-progress
boolean) in `tools/latex/latexPreview.ts` (finding 11). The rest of the
design problems are not fiber fights. They are **one record mutated by six
modules**, **one fact stored two or three ways**, and **a layout grammar every
step re-spells**. Every "better design" below names the Effect 4.1.2
primitive that is the thing, or says the computation is pure LaTeX text
handling and stays plain TypeScript; the table at the end lists the exact
exports verified in `node_modules/effect`.

## Numbers

Lines per subdirectory (64 `.ts` files, 15,171 lines): `latex/` 5,594 (27
files), `agent/output/` 3,634 (16), `replacement/` 3,199 (8),
`tools/documents/` 1,853 (8), `tools/latex/` 891 (5).

Five largest files: `replacement/rules.ts` 830, `latex/arxivProcessor.ts` 764,
`replacement/maxRules.ts` 659, `latex/LatexMediaManager.ts` 603,
`agent/output/extraction/filenameHeaders.ts` 563.

Comment share of the worst files ≥ 200 lines (`^\s*(/\*|\*|//)` over total):
`replacement/helpers.ts` 31% (82/264), `latex/texTools.ts` 31% (101/325),
`replacement/rulesRegex.ts` 29%, `agent/output/extraction/contentSimilarity.ts`
27%, `replacement/maxRules.ts` 25%. `helpers.ts` and `maxRules.ts` are rule
generators with a worked example per function, which is documentation, not a
protocol. The comments that substitute for design are elsewhere:
`agent/output/XmlOutputManager.ts:424-434,456-463,487-497,508-516` (why each
recovery tier exists and which launch shape it serves, finding 7),
`agent/output/lineageMapping.ts:352-357` ("do not reintroduce an 'origin but no
base' fallback", finding 2), `agent/output/compileCheck.ts:172-178,189-195`
(why a backstop records a failure whose log is the output file, finding 3),
`tools/documents/documentState.ts:108-113` (why two document tools must not run
concurrently, finding 1), and `shared/constants/latexToolchain.ts:117-118`
("Extract just the install command (first paragraph) from each guide",
finding 10).

Primitives: `new Promise` 0; `.then(` 1 (`arxivProcessor.ts:394`);
`AbortSignal` 1 (`arxivProcessor.ts:357`); `catch {}` 0; `Effect.ignore` 1
(`acceptedFileTarget.ts:168`, with `log: 'Warn'`); catch-and-continue sites
(`Effect.catch`/`catchIf`/`catchTag`/`catchCause`/`orElseSucceed`/`result`/
`exit`) 69 in 20 files, the densest `arxivProcessor.ts` 9,
`LatexMediaManager.ts` 7, `compileCheck.ts` 5; `Effect.sync(() =>
logger.warn(...))` wrappers 7 (the `AgentTrace` logger is synchronous, so each
recovery that reports through it is wrapped); classes whose fields are their
constructor arguments 6 (`XmlOutputManager`, `LatexDiffManager`,
`LaTeXdiffService`, `DiffCommandExecutor`, `DiffFileProcessor`,
`LatexMediaManager`), each with exactly one production `new` site; module-level
mutable state 2 (`documentState.ts:268` `taskFileSnapshots` WeakMap,
`replacement/engine.ts:285` LRU regex cache); `Settings.get*` sites 14 over 11
keys, the same key read in two modules three times (finding 3 and 6).

---

## Finding 1. A revision's record is a mutable map that six modules write into, then one serializes

**Red flags:** shared mutable state crossing module boundaries; temporal
decomposition (extract / validate / compile / diff each "set their part");
shallow module (`outputState.ts` is five accessors over one `Map`); two
spellings of "an empty round"; two lists named `baseFiles`.

**Evidence.** `OutputState` is `{ rounds: Map<number, RoundState> }` where
`RoundState` is the persisted `RoundOutput` with `readonly` stripped
(`agent/output/outputState.ts:183-191`: "extraction, the disk check, the
compile check and the diff each set their part of the round in place before
the call commits the whole map"). Writers of a round's fields:

- `tools/documents/documentTools.ts:281-286` clears five fields by hand
  (`round.outputs = []`, `missingOutputs`, `compileFailures`, `latexdiffs`,
  `reply`), the second spelling of what `ensureRoundData`
  (`outputState.ts:220-233`) initializes.
- `agent/output/outputFileExtraction.ts:115` (`ensureRoundData(state,
  currRound).outputs = []`) and `:156` (`data.outputs = processedPairs`).
- `agent/output/diffComputation.ts:124` reads `ensureRoundData(state,
  currRound).outputs`, the list the caller assigned one line earlier, and
  returns the rebuilt list, which `documentTools.ts:304` assigns back.
- `agent/output/outputValidation.ts:548-572` rewrites `round.missingOutputs`.
- `agent/output/XmlOutputManager.ts:290,306,381` reports missing outputs
  through an `outputState` injected for that purpose alone (`:233,239-240`),
  so a pure recovery pass has a side channel into the round.
- `documentTools.ts:392` `setCompileFailures`; `:463` `latexdiffs = entries`.

Then `docs.fact()` (`tools/documents/documentState.ts:207-208`) serializes the
whole map with `roundsToPersisted`, and the comment at `:108-113` explains why
two document tools cannot run beside each other: each loaded its own copy and
the later write drops the other's. Counts: `OutputState` 7 production files,
`ensureRoundData` 5, `roundsToPersisted` 3, `roundsFromPersisted` 2,
`setCompileFailures` 2, `reportMissingOutputs` 2; tests 2 (both build
`{ rounds: new Map() }` to call into the pipeline).

Beside it, `Documents` carries two lists called `baseFiles`:
`deps.baseFiles` is the sources (`documentState.ts:169-178`,
`fileService.locateSource`) and `docs.baseFiles` is their snapshots
(`:184-206`, `prepareRunWorkspace`). The extraction's similarity tier and
`\input` rewrite read the first (`outputFileExtraction.ts:44,153`), the diff
stats read the second (`documentTools.ts:307`).

Open PR: #14713 (open) adds a seventh writer step to `document_extract`
(`documentTools.ts`, +26: copying each `round.outputs` entry under
`model/r{round}/` with a `recoverOutputFailure`), so this finding sequences
after it.

**The design decision behind it.** The pipeline was written as a sequence of
phases over one object ("extract, then validate, then compile, then diff")
and each phase was given the object to mutate, so that knowledge of the
round's shape, its reset and its commit spread to every phase. The
rows-as-state rule the plugin already follows between calls
(`documentTools.ts:1-9`) stops at the call boundary.

**The better design.** A round is a value. The Effect primitive that holds a
tool call's state between calls is the one the plugin already uses: the fact
row (`ToolResult.facts`, read back with `ChildRuns.fact`). Within one call
the steps are sequential `Effect.fn` functions over that value; no `Ref` is
wanted here, because a `Ref<RoundOutput>` shared by the steps would be the
mutable map again with a lock, and the comment at `documentState.ts:108-113`
says no two steps of one run ever run concurrently. (A `SubscriptionRef`
would be right only if a view subscribed to the round mid-call; the view
reads the committed row.) Each document tool computes the next `RoundOutput`
from the previous one and what it did, and commits `rounds.with(revision,
next)`:

- `document_extract` returns `{ outputs, missing, reply }` from a pure
  `recoverDocuments` (finding 7) plus the diff-stat pass, and the round is
  `{ round, outputs, missingOutputs: missing, compileFailures: [], latexdiffs:
  [], reply }`: one literal, the reset implied.
- `document_compile` returns `{ ...round, compile }` (finding 3).
- `document_diff` returns `{ ...round, latexdiffs }`.

DELETE `OutputState`, `RoundState`, `ensureRoundData` (5), `setCompileFailures`
(2), `reportMissingOutputs` (2), `roundsFromPersisted` (2), `roundsToPersisted`
(3), the clearing block, `checkExpectedOutputs`'s in-place rewrite (it returns
the missing list), and `XmlOutputManager`'s `outputState` parameter (its
recovery returns `{ documents, unmatched }`). `deps.baseFiles` is renamed
`sources` or dropped: the snapshot list already answers "the file itself"
when no snapshot exists (`packages/harness/src/common/storage/runStorage.ts:103-110`),
so one list serves both readers. `Documents` loses `state`, `xml`, `diff` and
keeps `rounds: readonly RoundOutput[]`.

**What we give up.** Nothing a user sees. The `OutputState` tests
(`src/test-kernel/agent/output/CompileCheck.vitest.ts:50`,
`XmlOutputManager.vitest.ts:45`) are rewritten against values.

**Change amplification.** "A sixth per-revision product" (say, a lint report
the critic reads): today `RoundOutputSchema` (`documentOutputs.ts:223-241`),
`DOCUMENTS_OUTPUT_KIND.version` (`documents.ts:50`), `ensureRoundData`, the
clearing block, `documentsOf`'s `byRound` list (`documents.ts:156-160`), the
new tool, the recipe source and `DOCUMENT_TASK_TOOLS` (`documentRecipe.ts:29-69`),
`WorkflowRunContent.ts:58-60`: 8 files. After: the schema, the tool, the
recipe, the view: 4.

**Depends on:** none.

---

## Finding 2. An output's lineage is two stored fields, flattened to one path, and its origin re-derived from the path

**Red flags:** two representations of one fact; information leakage (which of
two bases a path was is recovered by testing the path against the storage
root); a comment forbidding a fallback that the shape invites.

**Evidence.** `FileLineageSchema` has `original` and `diffBase`
(`shared/plugins/documentOutputs.ts:25-28`), with `getEffectiveDiffBase`
coalescing them (`:92-96`). They are computed in
`agent/output/diffComputation.ts:137-171`: `origin` from the model-reported
source, `diffBase` from `origin ?? name-match`, a single-input fallback at
`:151-156`, and `toWorkspaceOrigin` (`:78-103`) that re-resolves a snapshot
location back to the live workspace file "so the compare action diffs their
real file". `lineageMapping.ts:352-357` then warns future readers: "`origin`
set implies `base` set — do not reintroduce an 'origin but no base'
fallback".

The flattening: `roundOutputsToOutputSummaries` (`documentOutputs.ts:254`)
writes `originalPath: getEffectiveDiffBase(lineage)?.absolutePath`, one path
for two meanings. The reader then recovers the meaning from the path:
`tools/documents/documentResult.ts:152-161` `deliveredFilePath` tests
`isPathWithin(roots.storage, originalPath)` to decide whether it holds a
snapshot (strip the round dir) or a workspace file (make it workspace-relative).
The CLI does the same by suffix (`packages/cli/src/runtime/workflowOutput.ts:209-223`).

Four production readers read the pair four ways: `ui/progress/components/FileList.ts:312-331`
reads `getEffectiveDiffBase`, `lineage.diffBase` **and** `lineage.original`
and picks between them with a comment; `agent/output/LatexDiffManager.ts:299-304`
records `lineage.original` and diffs against `base`;
`latex/latexdiff/diffOperations.ts:93,167` reads `getEffectiveDiffBase` and
treats `lineage === null` as "never recorded"; `documentResult.ts:152-161` as
above.

**The design decision behind it.** "Which file does this output revise?" and
"what do I diff it against?" were stored as two answers because the second
is a snapshot the harness made of the first, and no module owned the rule
"the diff base of a workspace document is its `original/` snapshot".
`RunFileService` does own it: `prepareRunWorkspace` "answers each base file's
pre-run location: its snapshot when one exists, else the file itself"
(`packages/harness/src/common/storage/runStorage.ts:103-110`), and
`ensureMirroredInRunSubdir` derives the snapshot path from the relative path
(`:445-448`, `originalSnapshotPath(relativePath)`).

**The better design.** Lineage is one field in the schema,
`document: Schema.NullOr(FileLocationSchema)`, the workspace document the
output revises (a new document has none); the `Schema.Struct` is the one
owner of the shape and the `FileLineageSchema` pair goes. The diff base is a
pure path function, `fileService.diffBaseOf(document)` (the snapshot when the
run has one, else the document), plain TypeScript owned by the harness's
storage module beside `originalSnapshotPath`, and every reader
(`latexdiffPairs`, `computeDiffStats`, the UI's compare action, the critic's
review) calls it. The one hand-rolled Effect primitive on this path is in the
harness, not here: `prepareRunWorkspace`'s `if (this.preparedBaseFiles)
return` memo (`runStorage.ts:113,153`) is `Effect.cached` (area M's file;
noted for the ordering). `OutputFileSummary.originalPath` becomes
`document: string | null` (workspace-relative), so `deliveredFilePath` and the
CLI's suffix match are deleted. DELETE `diffBase`, `getEffectiveDiffBase` (4),
`toWorkspaceOrigin`, the single-input fallback (fold into
`pairOutputsWithBases` as a rule, or refuse: an output a one-input task cannot
pair is a new document), `RoundFileEntry.origin` (keep `base` as `document`),
and the two path-recovery readers.

**What we give up.** An output whose base was never a workspace file (an
external input): today `diffBase` can name the external file while `original`
is null; with one field the external file is the document and the snapshot
rule answers "the file itself". No loss.

**Change amplification.** "A host action that opens the document an output
revises" (a desktop "reveal original"): today it chooses among three shapes
(`original`, `diffBase`, `originalPath` parsed) as `FileList.ts:312-331` does:
4 files to get right. After: one field, 1.

**Depends on:** finding 1 for the writer; a reader-side slice can land alone.

---

## Finding 3. What the compile check found is said in the script's variables, in a sentinel path, and in three setting reads

**Red flags:** state machine in optional fields / sentinel values (a failure
whose log _is_ its output means "no log"; `compileFailures: []` means both
"compiled" and "not checked"); information leakage (the sentinel is written in
one file and decoded in another); a decision ("does a failed compile reject
the revision?") made in three places; a reason literal nothing branches on.

**Evidence.**

- `agent/output/compileCheck.ts:57-70`: `CompileSkip` is
  `'disabled' | 'no-tex' | 'no-compiler' | 'errored'`; the round record keeps
  only `compileFailures: CompileFailure[]` (`documentOutputs.ts:226-228`), so
  a skipped check and a clean compile are the same row. The skip is returned
  to the script (`documentTools.ts:402-406`), which hands `compiled.checked`
  back to the next tool (`agent/output/documentRecipe.ts:58-61`), and
  `DocumentReviewTool.ts:79-84,131` takes `checked` as an input it cannot
  verify (`checked !== false`). A resumed recipe replays the script, so this
  works, but the fact lives in a script variable rather than the rows every
  other reader uses.
- `compileCheck.ts:179-208`: a backstop `catchCause` records a failure with
  `log: outputFile.location` because "logRelativePath must stay a real,
  resolvable path"; `agent/output/compileFailureRoundContext.ts:71-75` decodes
  it: `failure.log.absolutePath === failure.output.absolutePath` means "the
  check errored before writing a log". A sentinel written in one module and
  read in another. The backstop itself is the second level of recovery over
  `compileOne`'s own `Effect.catch` (`:387-395`), which already turns every
  typed failure into `{ kind: 'errored' }`; the comment (`:172-178`) says it
  exists "for a defect in that handling itself".
- `COMPILE_SKIPPED` (`documentTools.ts:354-359`) re-spells each reason as a
  sentence; the tool description and `scriptReturns` (`:365-367`) spell them a
  third and fourth time; nothing branches on the reason except
  `'no-compiler'` at `:410` (to add one sentence).
- `rejectsOnCompileFailure` is read at `documentState.ts:251` (does the next
  prompt carry the failure context), `documentTools.ts:411` (wording) and
  `:519` (does the proposal fail). Three places decide what a failed compile
  means for the task.

Open PR: #14713 (open) edits `documentTools.ts` (the extract tool only, not
the compile or propose sites cited here); sequence after it to avoid a merge
conflict in that file.

**The design decision behind it.** The compile check's outcome was modelled as
"a list of failures" because that is what the next prompt consumes, and the
other outcomes (skipped, errored, unchecked) were bolted on as return values
and sentinels rather than added to the record.

**The better design.** The round records its check as a schema union,
`compile: Schema.NullOr(Schema.TaggedUnion({ skipped: { reason: Schema.String },
checked: { failures: Schema.Array(CompileFailureSchema), rejected:
Schema.Boolean } }))` (`skipped.reason` is a message, since nothing branches
on it). `document_review` and `revisionPrompt` read the round; the recipe no
longer passes `checked`; `CompileSkip`, `COMPILE_SKIPPED`,
`skippedCompileCheck` (2) and the sentinel go. The backstop collapses into
`compileOne`'s one `Effect.catch`: `catch` handles typed failures only
(Effect.d.ts:4301-4337), so interruption and defects already pass through it
and the `catchCause` + `Cause.hasInterrupts` re-raise is the fiber model being
fought; a failure without a log has `log: Schema.NullOr(FileLocationSchema)`.
"A failed compile rejects the revision" is decided once, at
`document_compile`: the tool reads the setting there, records `rejected`, and
`revisionPrompt`, `document_propose` and the critic read the field. Log
reading and the excerpt format stay plain TypeScript over `FileSystem`.

**What we give up.** `document_compile`'s `checked`/`skipped` fields in
`scriptReturns` (a script reads `compile` instead); a setting toggled mid-task
no longer changes what the proposal does for a revision already checked.

**Change amplification.** "A fifth skip reason" today touches `CompileSkip`,
`COMPILE_SKIPPED`, the description, `scriptReturns` and the critic's copy: 2
files, 5 sites. After: the one message string at its site, 1.

**Depends on:** finding 1 (the round as a value) makes the field natural; the
sentinel's removal can land alone.

---

## Finding 4. A document task's documents are reported twice: the fact rows and `output.structured`

**Red flags:** two representations of one fact (`RoundOutput[]` in the
`documents/output` fact and `DocumentsResult` in the run's `structured`
value); compatibility defaults on persisted shapes; a rename at the tool
boundary (`structured` → `documents`).

**Evidence.** `document_propose` builds the fact and, from it,
`documentsSummary(fact)` (`tools/documents/documentTools.ts:535-544`); the
recipe returns that summary (`documentRecipe.ts:69`), so the run's
`output.structured` is `DocumentsResult` (`documentOutputs.ts:301-311`), a
flattening of the same rounds (`OutputFileSummary`, `:140-148`, which loses the
`FileLocation` and the two lineage fields, finding 2). `DocumentTaskTool.ts:351-359`
then renames `structured` to `documents` for scripts.

Readers split by representation. The fact: `controllers/session/hostRunActions.ts:286`,
`ui/progress/components/WorkflowRunContent.ts:34`, `ui/copy/taskDiagnostics.ts:18`,
`tools/documents/runOutputs.ts:27`. The structured value:
`agent/output/selectAutoOpenFinalOutput.ts:35` (called by hosts that hold the
session view: `packages/desktop/src/main/desktopHostRequests.ts:226`,
`packages/extension/src/frontend/agents/finalOutputOpener.ts:25`), and the CLI
(`packages/cli/src/runtime/workflowOutput.ts:309,386,426`), which dies when a
completed task "ended without its documents" (`:312-317`), a case the fact
makes impossible. `DOCUMENT_TASK_RESULT` (`documentResult.ts:181-186`)
delivers the structured form to the launching model and re-derives workspace
paths from it (finding 2).

Compat defaults on the persisted shapes: `OutputFileInfoSchema.round`
defaults to 0 (`documentOutputs.ts:34`), `RoundOutputSchema.compileFailures`
and `missingOutputs` to `[]` (`:226-235`), `DocumentsResultSchema.compileFailures`
and `diffs` to `[]` (`:303-308`). Every writer sets them
(`XmlOutputManager.ts:415-421`, `outputState.ts:223-230`,
`documents.ts:131-135`); the defaults read an earlier build's row, which
`DOCUMENTS_OUTPUT_KIND`'s own comment (`documents.ts:46-50`) says fails
loudly. AGENTS.md "Compatibility and format retirement" deletes them.

Open PR: #14713 (open) edits `documentTools.ts` (its extract tool); the
propose site this finding rewrites is untouched, but sequence after it for
the file.

**The design decision behind it.** The run's result had to be JSON a model and
a script can read, so a flattened copy was made and then became the thing the
CLI and the auto-open read, although every host and the CLI already hold the
session view the fact lives in.

**The better design.** The fact is the one record, and its row is the Effect
primitive already in place: the plugin's `factKinds` schema decoded once at
the row boundary with `Schema.decodeUnknownSync` (`documents.ts:119-122`) and
read through `ChildRuns.fact` (which `openDocuments` already uses at
`documentState.ts:165`). The recipe returns a reference (`{ runId }`, or
nothing: the launching model's delivery reads the fact). `DocumentsResult`
survives only as the delivery projection built at the delivery site
(`DOCUMENT_TASK_RESULT.delivery`), a pure function, never persisted;
`selectAutoOpenFinalOutput` and the CLI read
`documentsOf(view.runs.get(runId))`. The row schemas are plain
`Schema.Struct`s with every field required: the five `withDecodingDefault`s
are compatibility readers and go, so an older row fails at decode as
`DOCUMENTS_OUTPUT_KIND`'s comment promises. DELETE `documentsResultOf` (3),
`DocumentsResultSchema` as a persisted shape, `withDocuments`, the five
defaults, and the CLI's "ended without its documents" `Effect.die`.

**What we give up.** A script's `document_task(...)` promise resolving with
the outputs inline; it would resolve with `{ runId }` and read the fact (the
`DOCUMENTS_MODULE`'s `from()` helper, `documentsModule.ts:228-236`, is the
one place that reads it and would take the run id). Risk: the harness's
`AgentBlockResult.changes` (`documentResult.ts:165-178`) must be fed the fact
rather than `structured`; that is a one-site change in the harness.

**Change amplification.** "A new field on an output the hosts show" (say, the
compile artifact): today `OutputFileInfoSchema`, `OutputFileSummarySchema`,
`roundOutputsToOutputSummaries`, `formatOutputFile`, the CLI's reader and the
UI: 5 files. After: the schema and the UI, 2.

**Depends on:** none (the harness fact channel, `ToolResult.facts`, stays).

---

## Finding 5. The `r<N>` layout grammar is spelled at eight sites, with two meanings

**Red flags:** information leakage (a file layout known by many modules);
a function that strips a prefix others add; a one-based `r<N>` beside the
zero-based directory.

**Evidence.** `shared/constants/workflowOutput.ts:13-29` owns
`workflowOutputRoundDir(round)` = `r${round}` and `stripWorkflowRoundDir`. The
grammar is also spelled at `agent/output/compileCheck.ts:289-313`
(`r${currentRound}_${safeName}.log`, `build/r${currentRound}`, after
_stripping_ the same prefix from the display path, `:287-292`),
`agent/output/compiledPdfArtifacts.ts:37-49,86-95` (`output/r${round}/`, after
stripping), `agent/output/LatexDiffManager.ts:191-196` (`diff/${workflowOutputRoundDir}`),
`tools/documents/documentsModule.ts:234` (a regex `/^r\d+[\/\\]/` inside
script source handed to the sandbox), `compileCheck.ts:108-129`
(`resolveWorkspaceSourceDir` strips it to find the live folder),
`documentResult.ts:158`, `packages/cli/src/runtime/workflowOutput.ts:200`, and
`documentOutputs.ts:73-76` `formatRoundLabel` = `r${round + 1}`, the same
letters one-based for display. `stripWorkflowRoundDir` has 5 production
files, `workflowOutputRoundDir` 4.

The stripping exists because an output's display path carries the round
directory while its _document name_ does not; yet every `OutputFileInfo`
already carries `source`, the document name (`documentOutputs.ts:32`), and
`getSafeDocumentRelativePath(source)` is what `latexdiffPairs` keys by
(`diffOperations.ts:89,98`).

Open PR: #14713 (open) adds a ninth site, `modelOutputCopyPath` in
`shared/constants/workflowOutput.ts` (+26): a `model/r{round}/{run|workspace}/…`
layout built from `workflowOutputRoundDir` and `stripWorkflowRoundDir`, and
its writer in `documentTools.ts`. The `Revision` value proposed here would
own that path too (`.modelCopy(document)`); sequence after the PR and fold
its function in.

**The design decision behind it.** Where a revision's files live was decided
as a string convention rather than as a value, so every writer of a derived
file (log, PDF, diff) recomputes the revision's folder and every reader of a
run-storage path parses it back out.

**The better design.** The grammar has one owner that both renders and
parses it: `const RevisionDir = Schema.TemplateLiteralParser(['r',
Schema.NumberFromString])`, so `Schema.encodeSync(RevisionDir)(['r', n])` is
the directory name and `Schema.decodeUnknownResult(RevisionDir)` is the one
inverse, with no hand regex. `RunFileService` (or a small `Revision` value it
hands out, plain TypeScript over that schema) owns the layout:
`revision(n).dir`, `.reply`, `.compileLog(document)`, `.pdf(document)`,
`.diffDir`, `.modelCopy(document)`, and `documentOf(location)` for the one
reader that needs the inverse. Writers ask for paths; readers use `source`.
DELETE `stripWorkflowRoundDir` (5), the regex in `DOCUMENTS_MODULE` (it
reads `output.source` or the summary's `document` field from finding 2),
`resolveWorkspaceSourceDir`'s strip, and the hand-built `r${…}` strings (4).
`formatRoundLabel` renders "Revision N", not `r<N>`.

**What we give up.** Nothing. Risk: a host reading run storage by path
(`packages/cli/src/runtime/workflowOutput.ts:200`) must take the document from
the summary instead; that is finding 2's field.

**Change amplification.** "Name the revision folder `revision-<N>`": today
8 files. After: 1.

**Depends on:** none.

---

## Finding 6. Two latexdiff orchestrators over one pairing, and a service that is three one-use classes

**Red flags:** repetition (two bodies decide the between-rounds setting, the
suffix, the cwd and the description); a class whose fields are its
constructor arguments, three times; a constant-per-caller parameter
(`mathMarkup: undefined` at three of four `runDiff` sites); two levels of
result conversion.

**Evidence.**

- `latex/latexdiff/diffOperations.ts:120-225` (`runLatexdiffForRun`, the GUI
  hosts' verb) and `agent/output/LatexDiffManager.ts:173-278`
  (`document_diff`'s pass) both call `latexdiffPairs` (`diffOperations.ts:83-109`),
  both read `LATEXDIFF_BETWEEN_ROUNDS` (`:152`, `LatexDiffManager.ts:202`),
  both choose `'_diff'` vs `buildBetweenRoundDiffSuffix` (`:189-192`,
  `:253-259`), and differ in what they do not share: the manager mirrors
  dependencies (`:191-196,312-313`), resolves the cwd by `realPath` (`:106-116`)
  and compiles a PDF (`:326-333`); the verb runs in `roots.workspace ??
  dirname(base)` (`:188`) and compiles nothing. The run already records every
  pair it diffed in the fact (`round.latexdiffs`, `documentOutputs.ts:236-237`,
  shown by `LatexDiffsSection`), so the host verb re-runs latexdiff over the
  same recorded outputs rather than opening what the run wrote.
- `latex/latexdiff.ts:61-78`: `LaTeXdiffService` holds a `DiffFileProcessor`
  and a `DiffCommandExecutor`, each a class with one `new` site
  (`:76-77`) and fields equal to its constructor arguments
  (`diffCommandExecutor.ts:79-90`, `diffFileProcessor.ts:57-64`). The split is
  by _when_ (build the command, run it, post-process the file), not by what
  each hides: all three read the same `roots`. `new LaTeXdiffService` has 4
  production sites, each passing a channel string (`'ToolEditApproval'`,
  `CHANNEL`, `runId`, `params.channel`).
- `runDiff(input, edited, suffix, mathMarkup, options)` (`latexdiff.ts:133-147`):
  `mathMarkup` is `undefined` at `latexdiffVerbs.ts:119`, `LatexDiffManager.ts:320`
  and passed through at `diffOperations.ts:213`; `latexPreview.ts:364` alone
  passes `'coarse'`. The executor reads the setting when it is undefined
  (`diffCommandExecutor.ts:276-280`).
- Failures are converted twice: `LaTeXdiffService.failure` turns every error
  into `{ success: false, message }` and logs it (`latexdiff.ts:90-98`);
  `LatexDiffManager.logLatexdiffResult` logs the result again (`:118-136`) and
  `runSingleDiff` catches once more (`:339-349`) for an error the service
  said it never raises (`never` at `:150`).

**The design decision behind it.** "A latexdiff of a run's outputs" was
implemented once for the run (with mirroring and PDFs) and once for a host
button, and the service underneath was decomposed into stages rather than
into one function that takes a `cwd` and returns a path or a typed error.

**The better design.** One `Effect.fn('latexdiff')(pair, options)` in
`latex/latexdiff.ts` that fails with the `Schema.TaggedError`s the module
already defines or needs (`LatexdiffFailed`, `diffCommandExecutor.ts:58-77`;
`ToolMissing`; a new `NoDocumentEnvironment`) and succeeds with the diff
path; the command, the `--flatten` fallback (`Effect.catchIf(isBibliographyError,
() => attempt(false))`, as `diffCommandExecutor.ts:247-257` already writes it)
and the post-processing (pure text transforms, plain TypeScript) are private
functions of that module. The run's `document_diff` is the one orchestrator,
written as `Stream.fromIterable(pairs).pipe(Stream.mapEffect(latexdiff, {
concurrency: 1 }), Stream.tap(report))` so progress is the stream's own
elements rather than a `DiffProgressReporter` port; the hosts' "latexdiff
this run" verb opens `round.latexdiffs` from the view and runs the one
orchestrator only for rounds that recorded none (or with a different markup,
which is then its one parameter). DELETE `DiffCommandExecutor`,
`DiffFileProcessor`, `LaTeXdiffService` as classes (4 `new` sites become
calls; the per-instance `channel` string becomes `withLogChannel` at each
caller), `runLatexdiffForRun` (2), `DiffRunResult`, `DiffProgressReporter`
(2), `LatexDiffManager.logLatexdiffResult` and the second catch. The
`LaTeXdiffResult` union with its `'missing-document-environment'` reason
becomes the tagged error the two callers that skip it `Effect.catchTag`.

**What we give up.** A host diff with a math-markup setting changed after the
run (the verb reruns for that round: kept as the one option). The `channel`
string per service instance becomes `withLogChannel` at each caller.

**Change amplification.** "Between-round diffs also diff against the round
before last": today two orchestrators and `latexdiffPairs`: 3 files. After:
`latexdiffPairs`, 1.

**Depends on:** none.

---

## Finding 7. The extraction ladder decides "which files may this reply name" in two files and branches on it four times

**Red flags:** special and general code mixed (a general recovery with
branches for the single-output, the multi-input and the rewrite-in-place
launch shapes); information leakage (the documents plugin's substitution of
`outputFiles` for the base files is known by `documentState.ts` and by a
comment in `XmlOutputManager.ts`); a class with two injected side channels.

**Evidence.** `agent/output/XmlOutputManager.ts:431-436` computes
`expectedFiles` (outputs, else inputs) and `soleExpectedFile`; then branches
on `agentConfig.outputFiles.length` at `:444` (`coalesceRepeatedName`),
`:470-472` (take all fences or the first), `:504-508` (the similarity tier
only when no outputs are declared), with the comment at `:511-516` explaining
that "the documents plugin substitutes config.outputFiles for baseFiles
whenever the agent declares any", which is `documentState.ts:169-171`. The
same fact decides lineage at `documentTools.ts:309-311`
(`docs.task.outputs.length === 0`). Five tiers run in sequence (`:422-522`),
each explained by a paragraph. The class takes `outputState` for
`reportMissingOutputs` (finding 1) and `config` for one method the tool calls
separately (`ensureCorrectXmlStructure`, `documentTools.ts:289`).

Open PR: #14713 (open) inserts into `document_extract` right after the
`docs.task.outputs.length === 0` site cited above (`documentTools.ts:309-311`);
sequence after it.

**The design decision behind it.** The launch shape ("a task that writes one
new document from many inputs", "a task that rewrites its inputs in place",
"a task that writes several named documents") is a fact of the task block and
the launch, but it was never computed as a value; each tier re-derives the
piece it needs from `inputFiles.length` and `outputFiles.length`.

**The better design.** `openDocuments` computes one `expected` value from the
task and the launch: `{ names: string[], sole: string | null, rewritesInputs:
boolean }`. `recoverDocuments(response, expected, baseContents)` is a pure
function in `agent/output/extraction/` that runs the tiers as a list and
returns `{ documents, unmatched }`. This is LaTeX text recovery and stays
plain TypeScript: no Effect primitive belongs inside it. The tool, an
`Effect.fn`, reads the base contents for the similarity tier
(`Effect.forEach(..., { concurrency })`) and writes the files, which is where
the `FileSystem` boundary is. `XmlOutputManager` becomes two
functions; the fenced-block and header tiers take `expected` instead of four
options (`filenameHeaders.ts` `extractFilenameHeaderDocuments` options:
`roundDir`, `labelFiles`, `synthesisName`, `coalesceRepeatedName`, the last
two derivable from `expected`).

**What we give up.** Nothing in behaviour; the tier order and thresholds
stay. Risk: `src/test-kernel/agent/output/XmlOutputManager.vitest.ts`
constructs the class and is rewritten against the function.

**Change amplification.** "A task block that declares `outputs` may also
revise an input" (a mixed task): today `documentState.ts:169-171`,
`documentTools.ts:309-311`, four branches in `XmlOutputManager.ts`,
`similarityBaseFiles` (`outputFileExtraction.ts:39-72`): 4 files, 7 sites.
After: `expected`, 1.

**Depends on:** finding 1 for the side channel; the `expected` value can land
alone.

---

## Finding 8. The arXiv download hand-joins a promise and wraps `Effect.retry` in a cause sandwich

**Red flags:** reinvented Effect/Node primitives (`.then(`, an `AbortSignal`
kept in a closure, a "late rejection" join, a `catchCause → fail(cause)` /
`catch → failCause` pair around `Effect.retry`); a callback parameter
threaded through five functions; two representations of one choice.

**Evidence.**

- `latex/arxivProcessor.ts:351-413` `extractTarFile`: `pending`, `signal` and
  `rejected` closure variables, `tar.x({ filter: () => !signal.aborted })`,
  then `Effect.onExit(() => Effect.promise(() => pending?.then(...)))` to
  re-raise "a distinct late tar failure" while swallowing the abort. The
  area's only `.then(` (`:394`) and only `AbortSignal` (`:357`). `tar.x`
  with no `file` is a Writable; `fs.stream(tarPath)` piped into
  `NodeSink.fromWritable(() => tar.x({ cwd }), onError)` is one Effect whose
  interruption destroys the writable, with no filter, no join and the same
  `Effect.timeout`.
- `:199-238` `downloadFile`: `Effect.catchCause((cause) => Effect.fail(cause))`
  before `Effect.retry({ while: (cause) => … })` and `Effect.catch((cause) =>
  Effect.failCause(cause))` after, so the retry's `while` can inspect a
  `Cause` ("Effect's typed-error retry otherwise selects one failure and
  drops its siblings", `:204-206`). The attempt is `Effect.scoped` and fails
  with one typed error (`:332-336`); its cause has one reason unless a
  finalizer failed, and a finalizer failure is a defect to surface, not a
  sibling to preserve. `Effect.retry({ while: (e) => e._tag ===
  'ArxivSourceTransientError' })` over the error is the same policy.
- `progressCallback?: (msg, increment?) => void` (`:106`) is passed through
  `downloadArxivSource` → `fetchAndPlaceSource` → `stageAndPlaceSource` →
  `placeSourceFiles` and `indentLatexFilesInDirectory` (`:450,558,625,681`,
  `formatter/indentDirectory.ts:148`), one shape, two callers. A `Stream` of
  progress events, or `Effect.annotateCurrentSpan`, is the Effect form.
- `DownloadSourceOptions.autoIndent` and `formatter: LatexFormatter | null`
  are one choice twice: both callers pass `formatter: autoIndent ? … : null`
  and `autoIndent` (`packages/extension/src/commands/latex/arXivCommands.ts:102-106`,
  `tools/arxiv/ArxivDownloadTool.ts:94-98`), and `indentLatexFilesInDirectory`
  already answers `'disabled'` for a null formatter (`indentDirectory.ts:158-163`).

**The design decision behind it.** `tar`'s promise API was wrapped as a
promise rather than as the stream it also is, and the retry was written
against the cause to keep a cleanup failure visible.

**The better design.** Extraction as a stream pipeline:
`fs.stream(tarPath).pipe(Stream.run(NodeSink.fromWritable({ evaluate: () =>
tar.x({ cwd: destDir }), onError })))` under `Effect.timeout(EXTRACT_TIMEOUT)`;
`tar.x` without `file` is an `Unpack`, a `Parser` with `write`/`end`
(`node_modules/tar/dist/esm/parse.d.ts:81-88`, the `NodeJS.WritableStream`
shape the sink names), and interruption destroys the writable through the
sink's own finalizer, so there is no signal, no filter and no late join.
Retry over the typed error: `Effect.retry({ while: (e) => e._tag ===
'ArxivSourceTransientError', schedule, times })`; `while` is typed over `E`
(Effect.d.ts:7072), so the two cause wrappers go. Progress as a stream the
host consumes: `downloadArxivSource` becomes `Stream.callback<ArxivProgress |
ArxivDone, ArxivSourceError>((queue) => program(queue))`, the program
`Queue.offer`s its progress and its result and the two hosts
`Stream.runForEach` it; the `progressCallback` parameter on four functions
goes. `autoIndent` deleted (2 callers), `formatter: null` is the switch. The
staging-directory finalizer (`Effect.addFinalizer`, `:643-647`) and the
`makeDirectory`-as-claim (`:568-581`) are already the right shape and stay.

**What we give up.** The "distinct late tar failure" after a timeout: with a
destroyed writable there is none to report.

**Change amplification.** "Report download progress as a percentage in the
desktop too": today the callback's two arguments at 6 sites; after, one
stream consumer per host.

**Depends on:** none.

---

## Finding 9. `compileLatex2Pdf` reports success before the PDF exists; three callers verify three ways

**Red flags:** an error the boundary could define out of existence; the same
check repeated with different strictness; an internal call validated with a
schema.

**Evidence.** `latex/texTools.ts:295-299` returns `{ ok: true, pdfPath }` on
the engine's exit code, without reading the path. Its callers then check:
`latex/LatexMediaManager.ts:196-236` (`fs.exists`, then `stat`, then
`size === 0`, three warnings), `latex/TikzPictureManager.ts:282-294`
(re-derives the path with `.replace(/\.tex$/, '.pdf')` although `pdfPath` is
returned, then `fs.exists`), `agent/output/compiledPdfArtifacts.ts:78-83`
(`stat` and `type === 'File'`); `compileCheck.ts:413-414` and
`LatexDiffManager.ts:409` trust `ok`. Seven production callers in all.
`texTools.ts:28-50,194` decodes the options of every call through
`LaTeXCompileOptionsSchema` with `decodeUnknownSync`; all seven callers are
TypeScript, so the decode validates nothing the type did not (AGENTS.md:
"validate only at real boundaries").

**The better design.** `compileLatex2Pdf` succeeds only when the PDF it names
is a non-empty regular file (one `fs.stat` after the engine exits, inside the
`Effect.fn`); otherwise `{ ok: false, logTail }` with the reason first. No new
primitive: the boundary already is an `Effect.fn` over `FileSystem` and
`ChildProcessSpawner`; the change is where the one check lives. The schema
becomes a plain options type with defaults in the signature (pure input from
TypeScript callers, no decode). DELETE the three post-checks
(LatexMediaManager loses ~40 lines, TikzPictureManager its path
re-derivation, compiledPdfArtifacts its stat).

**What we give up.** Nothing; a compile that "succeeded" with no PDF was
already reported as a skip by every caller that noticed.

**Change amplification.** "A compile that writes a PDF elsewhere (an
`-output-directory` the engine ignores)": today 4 files; after 1.

**Depends on:** none.

---

## Finding 10. The toolchain catalog carries install advice as prose that a function parses back into commands, beside a second table of the same commands

**Red flags:** two representations of one fact (the install command as prose
inside a `Guide` and as `InstallCommand` in `DEPENDENCY_INSTALL_COMMANDS`);
a function that parses its own prose; a second naming of the tools
(`texDistributionInstalled`, `latexdiffInstalled`, …) beside the catalog's
names.

**Evidence.** `shared/constants/latexToolchain.ts:144-290`: per-tool `Guide`
strings built by `texLiveGuide`/`brewAptUrl` embed `brew install latexdiff`,
`sudo apt-get install latexdiff`; `combineGuides` (`:114-140`) then "extracts
just the install command (first paragraph) from each guide" by
`split('\n\n')[0].split('\n  ')[1]`. `DEPENDENCY_INSTALL_COMMANDS` (`:666-693`)
restates the same commands as data (`brew('brew install latexdiff')`), keyed
by `DependencyInstallKey` (`:640-646`), a second naming of five tools that
`LatexToolingController.ts:86-95` computes from the catalog's names and
`LaTeXTab.ts:82-131` lists by hand with the guide beside each. The catalog
rows themselves (`:348-448`) are one owner with four per-consumer columns
(`doctor`, `probe`, `drivesCompile`, `core`); none is constant or derivable, so
the table is sound. The file is 722 lines because the advice is prose.

**The better design.** One structured install record per tool: `{ brew?,
apt?, scoop?, url?, tlmgr?, notes? }` on the catalog row, an `as const
satisfies` table like `LATEX_TOOLS` itself; this is static data and pure
rendering, so no Effect primitive and no runtime schema belongs here (a
`Schema.Struct` would validate a literal the compiler already checks). The
guide text
(`ToolMissing`'s message, the LaTeX tab's card) and the copy/run command are
both rendered from it by one function per platform. The settings-status keys
become the catalog names (`installed: Record<LatexToolName, boolean>` plus the
two derived capabilities, `compiler` and `image`). DELETE `brewAptUrl`,
`withNotes`, `texLiveGuide`, `combineGuides`, every `*_INSTALL_GUIDE` constant
(6 exported), `DEPENDENCY_INSTALL_COMMANDS`, `DependencyInstallKey`,
`hasInstallCommands`, and the hand list in `LaTeXTab.ts`.

**What we give up.** The hand-written wording of the long guides
(`PDFLATEX_INSTALL_GUIDE`'s "restart VS Code and verify…"); keep it as a
`notes` field.

**Change amplification.** "Add a `winget` package manager": today
`SYSTEM_PACKAGE_MANAGERS`, `InstallCommand.packageManager`, `forManager`,
five rows of `DEPENDENCY_INSTALL_COMMANDS`, every `Guide.win32` string, and
`detectPackageManager`: 2 files, ~15 sites. After: the record's field and
one renderer, 2 sites.

**Depends on:** none. This file is area J's by directory; reported here
because the brief names the toolchain constants under I.

---

## Finding 11. The LaTeX preview re-implements the request's scope with a cleanup array, a Deferred and a boolean

**Red flags:** reinvented Effect primitives (`Scope.addFinalizer` as an
array of effects run at the end; scope closure as `Deferred.await` raced with
`isDoneUnsafe` checks; a `Semaphore(1)` as a boolean); state machine in
mutable fields; `*Unsafe` cluster.

**Evidence.** `tools/latex/latexPreview.ts:47-73` declares `LatexPreviewEntry`
with `isSettled: () => boolean`, `settled: Deferred<void>`,
`workspaceTempCleanup: Array<Effect<void>>`, `latexOperationInProgress:
boolean` and `onError`. `registerCleanup` (`:141-150`) pushes a cleanup onto
the array "or runs it now if the entry already finished";
`createTempFileWithCleanup` (`:241-254`) wraps a write and that push in
`Effect.uninterruptible` so "a finished request interrupting between them
would leave a file nothing deletes"; `withLatexOperation` (`:156-181`) sets
and clears the boolean under `Effect.ensuring`, races the operation with
`Deferred.await(entry.settled)` and sorts interrupt-only causes by hand;
`:298` and `:377` re-check `isSettled()` before opening a build. The owner,
`controllers/approval/ToolEditApprovalController.ts:288-331`, already holds
a `Scope` (`:288`, stored on the entry at `:312`) and forks the build into it
(`Effect.forkIn(..., entry.scope)`, `:262-266,423-427`), then builds the
Deferred (`:289`), the array (`:291`), runs the array in `Effect.ensuring`
(`:305`), and completes the Deferred with `Deferred.doneUnsafe` from an
`acquireRelease` release (`:326-332`). The scope and its hand-rolled twin
live side by side.

**The design decision behind it.** The preview programs were written to run
on a fiber the controller races, so "the request finished" had to be
observable from inside them; the request's scope, which the controller
already closes, was not handed to them.

**The better design.** The entry carries only `scope: Scope` (it already
does). A temp file's removal is `Scope.addFinalizer(entry.scope,
deleteWithAuxFiles(tempPath))` right after the write, which replaces
`registerCleanup`, the array and the `uninterruptible` wrapper (a finalizer
added to a closed scope runs at once: that is the "or run it now" case). A
preview is `Effect.forkIn(program, entry.scope)`, so the scope's close
interrupts it, which replaces `Effect.raceFirst(Deferred.await(settled))`,
`isSettled()` and the two mid-program checks. "One LaTeX operation at a
time" is `Semaphore.make(1)` on the entry and
`Semaphore.withPermitsIfAvailable(1)` around the program (a second click
gets `Option.none` and does nothing), which replaces the boolean and its
`ensuring`. `onError` stays as the one host port. DELETE `isSettled`,
`settled`, `workspaceTempCleanup`, `latexOperationInProgress`,
`registerCleanup`, the `Deferred.isDoneUnsafe`/`doneUnsafe` pair in the
controller and the `Cause.hasInterruptsOnly` branch (interruption of a scoped
fiber needs no handler). `fs.makeTempFileScoped` is **not** the temp-file
primitive here: its release removes the temp file's directory recursively
(`platform-node-shared/dist/NodeFileSystem.js:348-351`), and these files sit
beside the user's document.

**What we give up.** Nothing visible; the "Preview failed" message still
comes from `onError`.

**Change amplification.** "A third preview operation" (say, a word count of
the proposal): today it must take the entry, check `isSettled` twice,
register its temp files and go through `withLatexOperation`: 1 file, 4
protocol points. After: one `forkIn` under the permit, 1 point.

**Depends on:** none (the controller's half is area G's file; the entry
type and both programs are this area's).

---

## Finding 12. Batched: smaller flags, each one PR

- **`replacement/helpers.ts` is fourteen generators under a vague name, nine
  with one call site** (`generateXmlLatexConversions`, `generateLatexToXmlConversions`,
  `generateEnvironmentBracesFixes`, `generateSectionSpacingFixes`,
  `generateInvalidSectionEndingFixes`, `generateEnvironmentLinebreakFixes`,
  `generateArrowRelationShortcuts`, `generateDifferentialSpacing`,
  `generateReferenceSpacing` ×2, counted over `replacement/`). `createPatterns`
  (29 calls) is `Object.fromEntries(items.flatMap(mapper))` (`:17-22`).
  Inline each single-caller generator at its rule table as the `flatMap` it
  is; keep the five with several callers beside `maxRules.ts`, which uses
  them. (Shallow module; single-caller extraction.)
- **`applyReplacements` is exported for tests only**: one production file
  (`engine.ts` itself), one test (`src/test-kernel/replacement/ReplacementRules.vitest.ts`).
  The test should go through `replacementEngine.applyAll` with a config, or
  the export goes. **`applyFor(text, 'xml-content' | 'tex-write', config)`**
  (`engine.ts:144-175`) is a two-branch purpose enum with one caller each
  (`XmlOutputManager.ts:447`, `tools/registry.ts:157`); two named functions
  say the same without the switch and `absurd`. `applyAllPolicy` trims four
  times and wraps critique twice (`:104-112`). (Overexposure; option for a
  special case.)
- **`recoverOutputFailure`'s `level` is constant per caller** (`'warn'` at
  `outputFileExtraction.ts:160`, `documentTools.ts:292,386`; `'error'` at
  `LatexDiffManager.ts:270`): a parameter whose value is a fact of the call
  site. With finding 1's values the combinator has nothing to recover into
  and goes with its 4 consumers. (Pass-through.) Open PR: #14713 (open) adds
  a fifth caller, also `'warn'`, in `documentTools.ts`; sequence after it.
- **`LatexTrace`** (`LatexMediaManager.ts:38-53`) is a structural copy of
  `AgentTrace`'s four log methods (`packages/harness/src/agent/trace/AgentTrace.ts:100-108`)
  with one implementer; `import type { AgentTrace } from '@texra-ai/harness/plugins'`
  is what every sibling in `agent/output/` does. (Port with one
  implementation.)
- **`taskFileSnapshots`** (`documentState.ts:268-291`): a module-level
  `WeakMap` keyed by `run.opening` to read a task's template files once per
  opening. The read is one `Effect` the activation wants memoized:
  `Effect.cached(taskFileVars(task, entry.path))` evaluated once where the
  opening is built and carried on it, or, if the plugin must own it, a
  `Cache.make({ lookup: taskFileVars, capacity })` provided by the plugin's
  layer (`Layer.effect(TaskFiles)(Cache.make(...))`; `Layer.effect` already
  excludes `Scope` from its requirements, Layer.d.ts:1206, so no separate
  `Layer.scoped` exists or is needed). Either replaces a module global
  AGENTS.md says to avoid. (Shared mutable state; reinvented cache.)
- **`staleDiffFileLocation(original, outputPath, original)`**
  (`acceptedFileTarget.ts:316`): the third argument equals the first at one
  of two callers; the function's first `if` (`:289-291`) is that caller's
  constant. Split the "accept wrote over the base" check out of the location
  rule. (Constant-per-caller parameter.)
- **`Documents` opens every tool call with `prepareRunWorkspace`**
  (`documentState.ts:184-196`): idempotent through `preparedBaseFiles`
  (`runStorage.ts:113`), but five calls per revision each re-walk
  `supportFiles` and the catalog. With the round as a value (finding 1) the
  per-call open is `ChildRuns.fact` plus the catalog entry, and the snapshot
  is `document_context`'s first-revision step, where `openTask` already runs
  the first-revision checks (`documentTools.ts:105-173`). (Temporal
  decomposition: `openTask` versus `openDocuments`.)

---

## Good modules in this area

- `latex/latexParsingUtils.ts`: `LATEX_CITATION_COMMANDS` is one list for
  two consumers that used to drift (`:470-505`); `resolveLatexDir`,
  `existingExternalPath`, `collectCommaSeparatedMatches` are small, deep and
  reused by three extractors.
- `latex/overleafProject.ts` and `latex/overleafClone.ts`: pure parsing and
  credential derivation, then one Effect workflow over typed ports with a
  tagged `GitCloneFailed`; the auth-failure rule (`:253-265`) is one regex at
  one site.
- `latex/latexdiff/latexdiffVerbs.ts`: the one body of three host verbs; a
  host supplies two ports (`openDiffs`, `withProgress`).
- `latex/latexdiff/diffFileNameManager.ts`: the between-round suffix has one
  owner (`buildBetweenRoundDiffSuffix`, 3 consumers) and the artifact
  patterns are ordered data.
- `shared/plugins/documents.ts` `DOCUMENT_TASK_OPTIONS`: one table renders the
  tool schema (`DocumentTaskTool.ts:284-286`), the CLI flags, the launch form
  and the approval badges (landed 2026-11-04).
- `tools/documents/documentsModule.ts`: a script-side module of ten lines
  that reuses the tool's own door, so a scripted task is the same child run.
- `agent/output/extraction/contentSimilarity.ts` `assignByContentSimilarity`:
  a well-stated greedy assignment with its refusals named (echo displacement,
  ties, threshold).
- `replacement/engine.ts` rule tables typed as `Record<Category, RuleSet>`
  over the shared category universe (`:187-220`), so a category without
  rules or rules without a category fail to typecheck.
- `latex/texcount.ts` and `latex/formatter/texFormatter.ts`: a count or a
  formatter choice as one Effect with its failures in the value, no class.
- `latex/labelSearch.ts`: one function, two ports, the "found but could not
  open" case answered as the last failure rather than a sentinel.

## Already settled, left alone

- The `personal_style`, `max_style`, `equation_macros`, `max_style_regex`
  presets and the regex/non-regex key pairs: investigated in
  `2026-11-03-fewer-processing-options.md` §6 and kept by the owner
  (2026-11-05, "a feature reachable from config.json by hand"). `rules.ts`
  (830) and `maxRules.ts` (659) are data; their size is not a design flag.
- `DOCUMENT_TASK_OPTIONS` as the one option table, `task.rewrite` derived
  from `outputs`, `latexdiff.tempFileLocation` and `latex.wrapCritiqueInAlign`
  deleted, `acceptEditedFile.copyMeta` deleted: landed per the same note
  (§5, §6, 2026-11-04/05).
- The mechanical hint "`latex/acceptedFileTarget.ts` has a silent catch" is
  refuted: `Effect.ignore({ log: 'Warn', message })` at `:167-172` logs a
  staged file left behind, and the stale-diff removals warn with the path
  (`:187-196`, `:330-336`). The staged-write-then-rename under
  `Effect.uninterruptible` (`:160-175`) is the right shape.
- The arXiv retry loop the storage-errors note (`2026-11-03-storage-errors-and-stop-paths.md`,
  "Transient HTTP status" row) called hand-rolled now uses `Effect.retry`
  with the shared `randomizedExponentialBackoff` and `isTransientHttpStatus`
  (`arxivProcessor.ts:224-234`); what remains is finding 8's cause sandwich,
  a new angle. The jittered backoff schedule itself is refuted candidate
  territory (`refuted-candidates.json`, "Schedule.jittered over the [1, 2)
  contract would cut the mean wait by a third").
- `AgentTrace` (`logger.warn`, 41 calls in `agent/output/`) beside
  `Effect.log*` with `withLogChannel` (67 in `latex/`): AGENTS.md "Logging"
  assigns product rows to the trace and diagnostics to `Effect.log`, and
  `latex/README.md` restates it; the split is by rule, not by accident. The
  seven `Effect.sync(() => logger.warn(...))` wrappers are the cost of a
  synchronous trace and go with finding 1's values.
- `LATEX_TOOLS` (`latexToolchain.ts:348-448`): one catalog, four
  per-consumer columns, none constant; the `latexmk` "required" residual is
  stated at `:280-289` as a product decision. Only the install advice
  (finding 10) is two representations.
- `LATEX_COMMANDS_CHANNEL` as one channel for the LaTeX tool family: a
  documented, user-visible log filter (`latexLogging.ts:1-8`).
- `OpenOptions`-style launch toggles in `LatexMediaManager.processInputFiles`
  (`autoExtractFigure`, `autoExtractTikzFigure`, `autoCompileInputPdf`): the
  user's launch options from the settled table, not special-case knobs.

## Effect-native mapping (verified against node_modules/effect 4.1.2 .d.ts)

Paths are under `node_modules/effect/dist/` unless noted; `platform-node` is
`@effect/platform-node` 4.1.2, which re-exports `@effect/platform-node-shared`
4.1.2. Pure LaTeX text handling (recovery tiers, replacement rules, diff
post-processing, bibliography parsing) is plain TypeScript and has no row.

| Finding                     | Hand-rolled today                                                                                                                                                                                           | Effect primitive                                                                                                                                                                                                      | Verified export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Why it fits                                                                                                                                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                           | `OutputState` mutable `Map`, `ensureRoundData`, five setters, `roundsFrom/ToPersisted`                                                                                                                      | the fact row between calls; `Effect.fn` over values within a call; no `Ref`                                                                                                                                           | `ToolResultSchema.facts` (`packages/harness/src/shared/schemas/toolResult.ts:189`); `Effect.fn` (Effect.d.ts:18880); `Ref.update`/`modify` exist (Ref.d.ts:603,409) and are not wanted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | the steps are sequential and the row is the one store; a `Ref` would re-create the shared map with a lock                                                                                                                                                                     |
| 2                           | `original` + `diffBase` + `getEffectiveDiffBase` + path-recovery readers                                                                                                                                    | one `Schema.NullOr(FileLocationSchema)` field; `diffBaseOf` as a pure path function; `Effect.cached` for the harness memo                                                                                             | `Schema.NullOr` (Schema.d.ts:4210); `Schema.Struct` (:3026); `Effect.cached: <A,E,R>(self) => Effect<Effect<A,E,R>>` (Effect.d.ts:13539)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | the snapshot is a function of the document, so the schema holds one fact; `cached` is the memo `preparedBaseFiles` hand-writes (`runStorage.ts:113,153`)                                                                                                                      |
| 3                           | `CompileSkip` returned to the script, `checked` passed back, `log === output` sentinel, `catchCause` backstop                                                                                               | `Schema.TaggedUnion` for `compile`; `Effect.catch` for typed failures only                                                                                                                                            | `Schema.TaggedUnion(casesByTag)` (Schema.d.ts:5340); `catch_ as catch` (Effect.d.ts:4301,4337); `Effect.catchCause` (:5218) left unused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | a union is the three outcomes as data; `catch` already lets interruption and defects through, so the `Cause.hasInterrupts` re-raise is redundant                                                                                                                              |
| 4                           | `DocumentsResult` persisted beside the fact; five `withDecodingDefault`s                                                                                                                                    | the fact row decoded once at the row boundary; required fields                                                                                                                                                        | `Schema.decodeUnknownSync` (Schema.d.ts, `documents.ts:119-122` uses it); `Schema.withDecodingDefault` (Schema.d.ts:4996) deleted at five sites                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | one owner per fact; a default on a persisted field is a compatibility reader AGENTS.md retires                                                                                                                                                                                |
| 5                           | `r${round}` built at 4 sites, parsed by `stripWorkflowRoundDir` at 5, a regex in script source                                                                                                              | `Schema.TemplateLiteralParser(['r', Schema.NumberFromString])` as the one grammar; `encodeSync`/`decodeUnknownResult` as render and parse                                                                             | `Schema.TemplateLiteralParser` (Schema.d.ts:2423, "supports transformed parts"); `Schema.NumberFromString` (:7523); `Schema.encodeSync` (:1902)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | a parser schema renders and parses from one declaration, so no site re-spells the prefix                                                                                                                                                                                      |
| 6                           | `LaTeXdiffService` + `DiffCommandExecutor` + `DiffFileProcessor` classes; `LaTeXdiffResult` union; `DiffProgressReporter`; two orchestrators                                                                | one `Effect.fn` failing with `Schema.TaggedError`s; `Effect.catchTag` at the skip sites; `Effect.catchIf` for the `--flatten` fallback; `Stream.fromIterable(pairs)` + `Stream.mapEffect` + `Stream.tap` for progress | `Schema.TaggedError` (Schema.d.ts:11985); `Effect.catchTag` (Effect.d.ts:4392); `Effect.catchIf` (:5517); `Stream.fromIterable` (Stream.d.ts:846), `mapEffect` (:1843), `tap` (:2124), `runForEach` (:15953)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | a typed error replaces a result union nobody branches on but two; the stream's elements are the progress a host renders, so no reporter port                                                                                                                                  |
| 7                           | five recovery tiers branching on `outputFiles.length`                                                                                                                                                       | none inside: pure TypeScript `recoverDocuments(response, expected, baseContents)`; `Effect.forEach` with `concurrency` at the file-reading boundary                                                                   | `Effect.forEach` (Effect.d.ts:972)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | text recovery is pure computation; the one effectful step is reading base files                                                                                                                                                                                               |
| 8                           | `tar.x` promise joined by hand (`pending`, `signal`, `rejected`, `.then(`); `catchCause`/`failCause` sandwich around `Effect.retry`; `progressCallback` on five functions                                   | `fs.stream` → `Stream.run(NodeSink.fromWritable({ evaluate, onError }))` under `Effect.timeout`; `Effect.retry({ while })` over the typed error; `Stream.callback` + `Queue.offer` for progress                       | `FileSystem.stream` (FileSystem.d.ts:297), `.sink` (:275); `NodeSink.fromWritable: <E, A>(options: { evaluate: LazyArg<Writable \| NodeJS.WritableStream>; onError; endOnDone? }) => Sink<void, A, never, E>` (platform-node-shared NodeSink.d.ts:29-34); `Stream.run` (Stream.d.ts:15611); `Effect.timeout` raising `Cause.TimeoutError` (Effect.d.ts:8266, Cause.d.ts:1481); `Retry.Options.while?: (error: E) => boolean` (Effect.d.ts:7072); `Schedule.exponential` (Schedule.d.ts:725), `Schedule.jittered` (:981); `Stream.callback: (f: (queue: Queue<A, E \| Done>) => Effect<unknown, E, R \| Scope>) => Stream<A, E>` (Stream.d.ts:595); `Queue.offer` (Queue.d.ts:608) | the sink's finalizer destroys the writable on interruption, so the abort protocol disappears; `while` is typed over `E`, so the attempt's one typed failure is enough and the cause wrappers were compensating for nothing; a stream of progress is consumed, not called back |
| 9                           | three callers re-verify the PDF after `ok: true`; options decoded by schema per internal call                                                                                                               | one `fs.stat` inside the existing `Effect.fn`; plain options type                                                                                                                                                     | `FileSystem.stat` (FileSystem.d.ts:282); `Schema.decodeUnknownSync` deleted at `texTools.ts:194`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | the boundary that owns "compiled" owns "the PDF exists"; a TypeScript caller needs no decode                                                                                                                                                                                  |
| 10                          | install prose parsed back by `combineGuides`; a second command table; a second tool naming                                                                                                                  | none: an `as const satisfies` record per catalog row, rendered by one pure function                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | static data the compiler checks; a runtime schema would validate a literal                                                                                                                                                                                                    |
| 11                          | `workspaceTempCleanup` array + `registerCleanup`; `settled` Deferred + `isDoneUnsafe` + `raceFirst(Deferred.await)`; `latexOperationInProgress` boolean; `Effect.uninterruptible` around write-and-register | `Scope.addFinalizer(entry.scope, cleanup)`; `Effect.forkIn(program, entry.scope)`; `Semaphore.make(1)` + `Semaphore.withPermitsIfAvailable(1)`                                                                        | `Scope.addFinalizer: (scope, finalizer: Effect<unknown>) => Effect<void>` (Scope.d.ts:460); `Effect.forkIn` (Effect.d.ts:17126, already used at `ToolEditApprovalController.ts:262,423`); `Semaphore.make: (permits) => Effect<Semaphore>` (Semaphore.d.ts:253), `withPermitsIfAvailable` (:474); `Deferred.isDoneUnsafe` (Deferred.d.ts:1340) and `doneUnsafe` (:1604) are the `*Unsafe` cluster deleted                                                                                                                                                                                                                                                                         | a scope's close runs its finalizers and interrupts its forks, which is the whole protocol the entry re-implements; a permit is the boolean with its release built in                                                                                                          |
| 12 (`taskFileSnapshots`)    | module-level `WeakMap` keyed by the opening                                                                                                                                                                 | `Effect.cached` on the opening, or `Cache.make({ lookup })` in the plugin's layer                                                                                                                                     | `Effect.cached` (Effect.d.ts:13539); `Cache.make: (options: { lookup, capacity, timeToLive? }) => ...` (Cache.d.ts:250); `Layer.effect(Key)(effect) => Layer<I, E, Exclude<R, Scope>>` (Layer.d.ts:1206): **`Layer.scoped` does not exist in 4.1.2**, `Layer.effect` is already scoped                                                                                                                                                                                                                                                                                                                                                                                            | a memoized effect is what the WeakMap stands in for                                                                                                                                                                                                                           |
| 12 (`recoverOutputFailure`) | a catch-and-log combinator with a per-caller `level`                                                                                                                                                        | none once rounds are values; where a recovery stays, `Effect.catch` + the trace call at the site                                                                                                                      | `catch_ as catch` (Effect.d.ts:4337); `Effect.tapError` (:6413)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | a combinator whose only variation is constant per caller is a parameter for a fact the call site holds                                                                                                                                                                        |
| settled                     | `acceptedFileTarget.ts:160-175` staged write, rename, `onError` remove, `uninterruptible`                                                                                                                   | keep                                                                                                                                                                                                                  | `fs.makeTempFileScoped` (FileSystem.d.ts:191-195) is **not** a fit: its release removes the temp directory recursively (`platform-node-shared/dist/NodeFileSystem.js:345-352`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | the current shape is acquire-use-release in miniature, beside the user's file, where a temp directory must not appear                                                                                                                                                         |
| settled                     | `arxivProcessor.ts:224-234` retry schedule; `:643-647` staging finalizer; `:568-581` `makeDirectory` as the ownership claim                                                                                 | keep                                                                                                                                                                                                                  | `Effect.retry` with `schedule` + `times` (Effect.d.ts:7074-7075); `Effect.addFinalizer` (:12852); `Effect.scoped` (:12567)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | already the primitive; only the cause wrappers around it go (finding 8)                                                                                                                                                                                                       |

Corrections made while verifying: (a) `Layer.scoped` is not an export in
4.1.2; `Layer.effect` returns `Layer<I, E, Exclude<R, Scope>>`, so the
plugin-layer alternative in finding 12 names `Layer.effect`. (b)
`fs.makeTempFileScoped` was a candidate for `acceptedFileTarget`'s staged
sibling and for `latexPreview`'s temp files; its release removes a whole
directory, so neither design uses it. (c) `Effect.makeSemaphore` is not the
4.1.2 spelling; it is `Semaphore.make` from `effect/Semaphore`. (d)
`Effect.retry`'s `while` is typed over the error, not the cause, which is
what makes finding 8's wrappers deletable rather than merely movable.
