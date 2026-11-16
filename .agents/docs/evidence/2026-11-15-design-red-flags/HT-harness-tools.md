# HT. The harness's tools, platform, utils, common, logger, skills and types

Read on `main` at `d70ad92` (the brief's commit `93906b9` changes only this
folder). Paths are relative to `packages/harness/src` unless they start with
`packages/`, `src/` or `.agents/`. Consumer counts are over `packages/*/src`
unless stated.

## Numbers

| Directory   | Lines | Files |
| ----------- | ----: | ----: |
| `tools/`    | 12477 |    60 |
| `common/`   |  4438 |    21 |
| `utils/`    |  3094 |    27 |
| `platform/` |  2477 |    17 |
| `skills/`   |  1448 |     5 |
| `logger/`   |   588 |     5 |
| `types/`    |    42 |     1 |
| total       | 24564 |   136 |

The five largest files: `tools/ExecutionsTool.ts` (780),
`common/plugins/pluginManifest.ts` (566), `tools/memory/MemoryTool.ts` (546),
`common/storage/runStorage.ts` (502), `common/plugins/installedPlugins.ts`
(486).

Round 2's M report covered this area; M2 and M3 are refused and M4 and M9
are held (see "Already settled").

## HT-1: The tool switch record has one decoder but five hand-written readers and writers in four modules across two layers

- flags: information leakage, repetition, pass-through
- package: harness (touches texra's `ToolDashboardData.ts` only if it moves to the new reader)
- kind: refactor
- size: S
- earlier: none (the 2026-10-30 texra report named `storedDisabledTools`/`readDisabledTools` as wrappers of one decode in passing; no id)
- open PR: none

**Evidence.** The stored record `tools.disabled` has a key and a decoder in
`shared/state/disabledTools.ts:10-46` ("The one decoder of the record; each
reader turns the failure into its own error", `:22-23`). Everything a caller
does with it is then written again at each site:

- `tools/plugins.ts:184-192` `storedDisabledTools` re-wraps the decoder's
  failure as `StateReadFailed`; `:196-201` `readDisabledTools` reads the key
  and applies it.
- `skills/runtimeSkills.ts:176-187` `readDisabledSkills` reads the same key by
  hand (`stores.globalState.get(DISABLED_TOOLS_KEY.key)`) and maps the same
  failure to a plain `Error` with `Result.mapBoth`, because `skills/` sits
  below `tools/` in the layer order (`packages/harness/AGENTS.md` "Layer
  order", 6 vs 7) and cannot import `readDisabledTools`.
- Two writers each spell `state.modify(DISABLED_TOOLS_KEY.key, (stored) =>
  Result.map(storedDisabledTools(stored), …))`: the first-install seed
  (`tools/toolAvailability.ts:92-104`) and the switch
  (`tools/liveTools.ts:203-211`).
- Readers of `readDisabledTools`: `liveTools.ts:199` (served as
  `ToolCatalog.disabled`), `pluginCatalog.ts:106`,
  `agent/runtime/loop/step.ts:224`,
  `agent/index/BundledAgentDirectories.ts:32`. `ToolCatalog.disabled` has one
  consumer (`packages/texra/src/controllers/settingsView/ToolDashboardData.ts:133`);
  the harness's own readers go around it.

**The design decision behind it.** "Which plugins are switched off, and how
is that changed" is a fact about one stored record, but only its decode was
given an owner; the read, the seed and the toggle were each left to the
module that needed them, and the read's home (`tools/`) is above one of its
readers (`skills/`).

**The better design.** `shared/state/disabledTools.ts` owns the record's
three operations beside its decoder: `read(store): Effect<ReadonlySet<string>,
StateReadFailed>`, `seed(store, ids)` (the `modify` that writes only when
absent, answering whether it wrote) and `toggle(store, id, enabled)`.
`StateReadFailed` and `StateStore` are already in `shared/config/settings`,
the same layer. Deleted: `storedDisabledTools` (3 production callers, 0
outside the harness), `readDisabledTools` in `tools/plugins.ts` (4 callers
move to the shared reader), the inline decode in `readDisabledSkills`, and
the two hand-written `modify` bodies. `decodeDisabledTools` becomes
file-local (its 2 callers both go through the new functions). Callers write
`DisabledTools.read(roots.globalState)`.

**What we give up, and risk.** Nothing: the error each reader raises
becomes `StateReadFailed` everywhere, where the skills listing raised a
plain `Error` with the same message (the CLI and settings view print the
message only).

**How I tried to refute it.** Checked that `skills/` cannot reach
`@tools/plugins` (layer order) and that no reader needs a different failure
type (`Skills.display`/`enabled` callers print `toErrorMessage`). Checked
the open PRs: none touches these files. `ToolCatalog.disabled` stays (a host
reads it through the catalog), but now calls the one reader.

## HT-2: A plugin's fact kinds are checked and indexed outside the plugin table, twice per session and by linear scan per fact

- flags: temporal decomposition, repetition, overexposure, non-obvious code
- package: harness
- kind: refactor
- size: S
- earlier: none
- open PR: none

**Evidence.** `toolTable` (`tools/toolTable.ts:274-320`) is where the plugin
list is checked: ids, repeated ids and tool names, `requires`, agent-file
blocks and script modules, each a throw that `processLayer` turns into
`PluginsRefused` at process build (`effect/processLayer.ts:294-299`). The
one rule about the list it leaves out is the fact kinds: "a fact kind of
another plugin's id, or a kind contributed twice, is a defect of the plugin
list" (`tools/plugins.ts:260-276`, `factKindsOf`). That check runs later and
more than once:

- `controllers/session/databaseLayer.ts:289` builds `factKindsOf(...)` from
  `ToolRegistry` at every store open (the global store and each project's),
  inside an `Effect.gen`, so a bad list surfaces as a defect at the first
  session open, not as `PluginsRefused` at process build.
- `controllers/session/sessionOwners.ts:286` builds it again for
  `announceWrites`.
- The per-fact readers do not use the index at all: `checkOwnFacts`
  (`tools/plugins.ts:295`) and `ownFactsChecked` (`:367`) each find a kind
  with `plugin.factKinds?.find((own) => own.kind === kind)` and restate the
  ownership check (`fact.plugin !== plugin.id`, `:296`).
- `ownFactsChecked` is exported with no production consumer outside its file
  (its one caller is `factRows`, `:406`; the other references are a comment
  at `databaseLayer.ts:480` and `src/test-kernel/controllers/session/sessionEvents.vitest.ts:1102,1119,1153`).

**The design decision behind it.** "Which row kinds the process's plugins
own" is a property of the plugin list, decided when the list is accepted;
it was written as a function each reader calls at its own time.

**The better design.** `ToolTable` gains `factKinds: FactKinds`, built and
checked in `toolTable` with the other list rules, so a bad list is a
`PluginsRefused` at build like every other list defect. `databaseLayer` and
`sessionOwners` read `registry.factKinds`; `checkOwnFacts` and
`ownFactsChecked` look up `factKinds[factName(fact)]` and drop their own
ownership restatement (the index already holds only a plugin's own kinds).
Deleted: `factKindsOf` as an export (2 production callers, 2 test callers
that can call `toolTable(plugins).factKinds`), the two per-session rebuilds,
the two linear finds; `ownFactsChecked` becomes file-local (the test calls
`factRows`, or keeps the export as its one consumer if the owner prefers).

**What we give up, and risk.** None in behavior; a malformed plugin list
fails earlier and with the typed error.

**How I tried to refute it.** Looked for a reason the kinds are computed
late (a plugin added after build, a store opened over another list): the
table is fixed for the process (`ToolRegistry` is `Layer.succeed(table)`,
`liveTools.ts:235`), and both callers read that same registry. The
`databaseLayer.ts:821` test-support call passes `toolTable([])`, which
still works.

## HT-3: Skill discovery is an open contribution system with one producer, and it de-duplicates skills three times

- flags: overexposure, shallow module, repetition, special-general mixed
- package: harness
- kind: refactor
- size: M
- earlier: none (lens 2's `includeInterop` row landed; this is the structure around it)
- open PR: #14949 (branch `claude/dazzling-cori-84lvx0`, commit `2f24098`) replaces the hand-copied `SkillRoot` with `Omit<SkillSource, 'scope'>`; it leaves everything below

**Evidence.**

- `SkillSourceContribution { id, tier, roots(call) }`
  (`skills/skillSources.ts:113-117`) has one producer,
  `hostSkillContributions` (`:221-243`), called once in production
  (`effect/processLayer.ts:287`) and twice in a test
  (`packages/harness/test/cli/CliSkills.vitest.ts:112,233`). It builds a fixed
  list: six `CORE_SKILL_CONTRIBUTIONS` (`:126-188`), one project
  contribution, one per tool plugin (`pluginSkillContribution`, `:200-212`).
- `foldSkillSources` (`:254-302`) then undoes the indirection: it checks the
  ids are unique and throws otherwise "so the id stays a checked key for the
  display and toggle consumers that will read it" (`:250-252, 258-264`).
  Nothing reads a contribution's `id` (the only `.id` read in `skills/` is
  `tier.id`, `:268`); it walks `SKILL_TIERS` (`:65-77`) and, per tier, every
  contribution, to stamp the tier's scope back on.
- `SKILL_TIERS.order` is `'source'` on six rows and `'name'` on one
  (`bundled`, `:66-72`): a column constant except for one row, read once
  (`loadSkills.ts:336`).
- `SkillSource.label?` is optional (`loadSkills.ts:39`) with a fallback to the
  scope (`runtimeSkills.ts:139-141`), but the one production builder always
  sets it (`skillSources.ts:283`); only `packages/harness/test/skills/LoadSkills.vitest.ts:44,77`
  omits it.
- Three de-duplication passes over the same keys: paths across contributions
  (`skillSources.ts:270-277`), then names and canonical `SKILL.md` paths
  across sources (`loadSkills.ts:256-279`, `accept`), and the same two keys
  again inside each root (`loadSkills.ts:105-108, 162-185`, with its own
  `dupNameIssue`/`dupRealpathIssue` calls). `accept` sees every root's skills
  in the root's own order (a `name` tier re-sorts by directory name, which
  inside one root is the order the scan already used), so the in-root pass
  decides nothing `accept` would not.

**The design decision behind it.** "Where skills come from" is a fixed,
ordered list the harness knows completely (custom, project, interop-project,
user, installed plugins, interop-user, bundled), parameterized by four data
values a host passes (`resourcesPath`, `projectDataDirName`, the tool
plugins' ids, the CLI's extra paths). It was written as a registry of
closures with ids and tiers, folded back into that list at each discovery.

**The better design.** `skillTiers(call, host)` in `skillSources.ts` returns
the tiers in precedence order as one literal, each source written where its
tier is (the bundled tier's sources being the resources root and each
plugin's `bundledPluginDir`), with the one path de-dup kept.
`HostSkillSources` carries the host's data (`resourcesPath`,
`projectDataDirName`, `pluginIds`, `options`) instead of `contributions`.
`scanSkillRoot` returns what it loaded and lets `accept` decide duplicates.
`label` becomes required. Deleted: `SkillSourceContribution`,
`CORE_SKILL_CONTRIBUTIONS`, `pluginSkillContribution`,
`hostSkillContributions`, the id check, `SKILL_TIERS` as a table (its order
becomes the literal's), `SkillSourceTier.order` (the bundled tier is the one
that pools; `discoverSkillSources` takes `{ pooled: boolean }` or the tier
array marks the last), the in-root `seenNames`/`seenRealPaths`, and
`sourceLabel`'s fallback. About 120 of the 646 lines of the two files.
Update the "Skill sources" line of
`.agents/docs/implemented/architecture/2026-09-24-plugin-architecture.md:205-207`.

**What we give up, and risk.** A future second producer of skill roots
(none is planned or proposed) would add a parameter instead of a
contribution. Dropping the in-root pass changes one message: a skill
directory reached twice through a symlink in one root reports its own load
issues twice instead of once.

**How I tried to refute it.** Looked for a second producer (app, CLI,
plugin, test-kernel): none; `HostSkillSources` is provided only by
`processLayer` and two tests. Looked for a reader of the contribution id
(display, toggle): none; the toggle reads `ActiveSkillSourceScope` and the
plugin id. The plugin-architecture note lists skill sources among "contribution
lists" with "stable id", but states no consumer of the id. #14949 touches
only the `SkillRoot` type.

## HT-4: Four JSON Schema walkers keep four readings of which keywords hold subschemas, and the provider-facing one treats a property named `default`, `enum`, `const` or `examples` as a keyword

- flags: repetition, information leakage, non-obvious code
- package: harness
- kind: bug
- size: M
- earlier: none
- open PR: none

**Evidence.** Walks over a tool's JSON Schema each decide, by their own
table, which values are subschemas:

- `agent/core/tools/toolSchema.ts:244-306` (`withArrayItems`, applied to
  every tool's wire parameters by `convertToolSchema`, `:339`) walks every
  value except those under `DATA_KEYWORDS` (`enum`, `const`, `default`,
  `examples`, `:244-249`), and it applies that test to every key at every
  level, property names included: inside `properties`, a property named
  `default` is returned unwalked (`:275`).
- `tools/catalogEntries.ts:102-158` (`withoutSchemaDescriptions`, the tool
  digest) has an allow-list: 16 single-or-list keywords and 6 map keywords,
  and says why: "It walks keywords, not keys: a property named `description`
  stays" (`:132-137`).
- `tools/structuredOutput.ts:52-74, 84-147` (`assertSafeSandboxSchema`, the
  guard on a model- or script-authored schema) has a third allow-list split
  three ways (11 single, 4 list, 5 record keywords); unlike the digest's it
  leaves out `contentSchema`.
- A fourth, partial walk: `schemaText` in `tools/codemode/discovery.ts:41-54`
  (the text a script's `searchTools` ranks) follows `properties`, `items`
  and `anyOf`/`oneOf`/`allOf` only, so a field described under `$defs` (where
  Effect Schema puts a recursive or shared definition, `toolSchema.ts:322-325`)
  is never searched.

**How it fails.** An MCP tool's JSON Schema passes through as its
parameters (`tools/mcp/mcpServer.ts:10-11`; `inputSchema` returns
`definition.parameters`, `toolSchema.ts:318`) and goes through
`withArrayItems`. A server tool with an array-typed property named
`default` (or `enum`, `const`, `examples`) whose schema has no `items`, or
uses `prefixItems`, is sent unchanged, and OpenAI rejects the request ("array
schema missing items", the very case `withArrayItems` exists for, `:251-258`).
Every tool of the step goes out in that request, so one such server tool
fails the whole turn. The same walk drops an `additionalProperties: true`
value wherever the key appears (`:282-284`), including under `properties`
for a property of that name. No built-in tool has such a field today
(grep of `packages/*/src` for a struct field named `enum|const|default|examples`:
none), so only third-party schemas reach it.

**The design decision behind it.** "Which parts of a JSON Schema node are
subschemas" is one fact of the JSON Schema vocabulary; each walker that
needed it wrote its own answer, one of them as a deny-list.

**The better design.** One keyword table by value shape (single subschema,
list of subschemas, map of named subschemas) and one
`mapSubschemas(node, f)` beside `convertToolSchema` in
`agent/core/tools/toolSchema.ts`; `withArrayItems`,
`withoutSchemaDescriptions`, the sandbox guard and `schemaText` are each a
function over it (the guard also needs the map keys, to refuse `__proto__`, which the map
case exposes). Deleted: `DATA_KEYWORDS`, `SUBSCHEMA_KEYWORDS`,
`SCHEMA_MAP_KEYWORDS`, `SUBSCHEMA_KEYS`, `SUBSCHEMA_LIST_KEYS`,
`SUBSCHEMA_RECORD_KEYS` and the four hand-written recursions' dispatch.
One regression test (a parameters object with a `default` array property
without `items` comes out with `items`), written to fail first.

**What we give up, and risk.** The digest changes for no built-in tool (its
walk already followed keywords); a resumed step's recorded digests stay
valid. `contentSchema` joins the sandbox guard's walk, which can only refuse
more.

**How I tried to refute it.** Checked that MCP parameters reach
`withArrayItems` (they do, through `convertToolSchema` for every tool in
`toolDefinitionsFor`, `catalogEntries.ts:34-37, 49-57`). Checked that
nothing upstream renames properties first: `flattenTopLevelUnion` and
`stripDollarSchema` touch only the root. No open PR touches the three files.

## HT-5: The documents plugin's run workspace (snapshots, dependency mirrors, round-directory links) is a harness class every run carries

- flags: special-general mixed, information leakage, shallow module, overexposure
- package: harness (moves code to texra; touches cli's `documentTaskOutput.ts`)
- kind: refactor
- size: L
- earlier: none on placement. Round 2's I report used `RunFileService` as the owner of the diff base (I-latex-documents, finding on lineage); `DOCS-prepare-run-workspace-per-call-stays` in `refuted-candidates.json` refused moving the per-call prepare into the first revision, which this does not propose
- open PR: none

**Evidence.** `common/storage/runStorage.ts:55-502` is `RunFileService`, a
class with per-run mutable state (`preparedBaseFiles`,
`mirroredDependencies`, `pathLanes`, `:57-62`). Every run builds one
(`agent/runtime/run/AgentRun.ts:316`) and every tool call is handed it on
the public plugin surface (`ToolRun.fileService`,
`agent/runtime/RunCall.ts:170`; `RunFileService` is exported from
`plugins.ts:222`). Its methods split cleanly by who calls them:

- Only the app's documents and LaTeX code: `prepareRunWorkspace`
  (`packages/texra/src/tools/documents/documentState.ts:168`),
  `mirrorWorkspaceFile` (`packages/texra/src/latex/latexMedia.ts:206,273,373`,
  `packages/texra/src/agent/output/revisionLatexdiffs.ts:101`),
  `ensureMirroredInRunSubdir`
  (`revisionLatexdiffs.ts:141,144`, `documentState.ts:345`), `createLocation`
  (`documentState.ts:119,123,130,337`, `replyDocuments.ts:350`,
  `outputFileExtraction.ts:160`), `originalSnapshotPath` and `hasDirectory`
  (`packages/texra/src/tools/AcceptRunFilesTool.ts:208,264`).
- The harness: `locateSource` once (`agent/runtime/loop/runLoop.ts:214`),
  `inspectEntry` once (`agent/storage/childRunOutput.ts:108-111`, on a fresh
  instance for another run), and `runDirectory`.
- Six sites construct the class only to read `runDirectory`, which is
  `runDirUnder(roots.storage, runId)` (`storageLayout.ts:77-79`):
  `packages/cli/src/runtime/headless/documentTaskOutput.ts:312`,
  `packages/texra/src/controllers/progressView/ProgressDocumentTaskFileActionsController.ts:109,184`,
  `packages/texra/src/agent/output/compileCheck.ts:107`,
  `packages/texra/src/tools/OpenPdfTool.ts:69`,
  `packages/texra/src/tools/documents/documentResult.ts:297`.

The class speaks the documents plugin's vocabulary: round directories
`r<N>` and "a multi-document output at `r{round}/chapters/ch1.md`"
(`runStorage.ts:159, 445, 483`), "Read-only build assets
(cls/sty/bib/figures)" (`:446-449`), the `protectedStem` of a LaTeX build's
primary output (`:410-424, 437`). `shouldSkipRelocation`
(`storageLayout.ts:47-59`) keeps workspace folders named `History`/`history`
out of run storage because "History folders contain prior run data that is
managed separately", a rule from the pre-1.0 history folders that nothing
else in the tree mentions. `fileLocation.ts:49` still sends readers to
"RunFileService.createLocation()", and the host API doc repeats it
(`packages/harness/docs/api/host.md:1386`).

**The design decision behind it.** "How a document task stages its inputs
in run storage" is the documents plugin's decision. It was placed in the
harness's storage layer, and so every run of every agent, and every
embedder's plugin, is handed the plugin's stateful helper.

**The better design.** The harness keeps the pure run-storage reads beside
`runDirUnder` in `storageLayout.ts`: `sourceLocationUnder(roots, path)`
(today's `locateSource`) and `runEntryUnder(storage, runId, relativePath)`
(today's `inspectEntry`), both functions of data. The stateful part
(prepare, snapshot, mirror, round-directory links, `createLocation`) moves to
`packages/texra/src/tools/documents/` as the plugin's own run workspace,
held per run the way the plugin already holds per-opening state
(`taskFileSnapshots`, a `WeakMap` keyed by the run's opening, kept by
`DOCS-task-file-snapshots-weakmap-stays`). Deleted from the harness:
`RunFileService` (about 330 lines), `ToolRun.fileService`,
`AgentRun.fileService`, `shouldSkipRelocation` and `IGNORED_WORKSPACE_ROOTS`
(or kept in the plugin if the owner still wants it), the stale comment.
The six `new RunFileService(...).runDirectory` sites call `runDirUnder`.

**What we give up, and risk.** An SDK break: `RunFileService` and
`ToolRun.fileService` leave `@texra-ai/harness/plugins` (record it under
"Needs your eye"). A third-party plugin that used them (none in the tree)
would copy the helper. The move must keep the per-run memo's lifetime: one
workspace per run activation, as today.

**How I tried to refute it.** Looked for a harness or host caller of the
stateful methods: none outside texra. Checked that `locateSource` and
`inspectEntry` read no instance state (they read `roots`, `runId` and
`runDirectory` only, `:244-311`, `:340-345`). Checked the refused candidates on this class:
both are about when the documents plugin calls it, not where it lives.

## HT-6: "Keep a long output's head and tail and say how much was left out" is written by hand four times, with four spellings of the elision note and a comment naming a function that no longer exists

- flags: repetition, comment restates code, information leakage
- package: harness
- kind: refactor
- size: M
- earlier: M6 (round 2) moved the background delivery onto the `process.output` rows (landed, #14810); its PR refused making the foreground output tail-only. This finding keeps both decisions and is about the window they each re-implement
- open PR: none

**Evidence.** The same window (the first H characters, the last T, and the
count between) is kept by hand at four sites, each over `appendHead` /
`appendTail` (`utils/text/appendTail.ts:7-54`):

1. Foreground bash: `boundedOutput` (`tools/bash.ts:70-123`), streaming, with
   the 4,000/50,000 budgets of tool results and the note
   `[... N characters elided from stdout ...]` (`:116`).
2. Background bash: `record` in `backgroundBashTurn` (`tools/bash.ts:196-236`),
   streaming per stream with its own `recorded`/`elided`/`tail` counters and
   the 1,000/12,000 budgets, whose note is a `process.output` row's `elided`
   field.
3. Every tool result: `capToolResultText`
   (`agent/runtime/run/toolResultText.ts:51-70`), one-shot, the 4,000/50,000
   budgets again, note `[... N characters elided ...]` (`:63`).
4. The background delivery: `bashResultDelivery`
   (`agent/runtime/delegation/bashDelivery.ts:56-110`), over the rows, the
   1,000/12,000 budgets, note `<output-elided>N characters elided</output-elided>`
   (`:94`). Its doc comment says the gap is stated "mirroring the foreground
   `checkToolResultTextLimit`'s note" (`:28-29`); no such function exists
   (grep over `packages/*/src`: this comment only).

A fifth spelling, `[N characters elided]`, is `outputGapNotice`
(`shared/toolUse.ts:182-183`), read by `shared/session/transcriptLogRows.ts:50`
and `tools/executions/processOutput.ts:86`. The budgets live in two modules
(`toolResultText.ts:19-20` and `bashDelivery.ts:21,32`) and `bash.ts` imports
both pairs (`:17-18, 29`).

**The design decision behind it.** The head-and-tail excerpt is one
operation with a budget pair and a note; it was written into each consumer,
and so was the note's wording.

**The better design.** One streaming window beside `appendHead`/`appendTail`
(which become file-local): `headTail({ head, tail })` with `append(chunk)`
and a read of `{ head, tail, elided }`. Sites 1 and 2 hold one per stream
(site 1 keeps its whitespace rule as a filter on what it appends); site 3
appends once; site 4 appends the rows' text, adding the gap row's `elided`.
One note, `elidedNote(count, stream?)`, replaces the four inline wordings
and `outputGapNotice`. Deleted: the hand-kept `head`/`tail`/`totalChars`
and `recorded`/`elided`/`tail` counters in `bash.ts`, the two inline
computations in `toolResultText.ts` and `bashDelivery.ts`, the false
comment. About 80 lines net.

**What we give up, and risk.** The model reads one wording of the note
where it read four; prompts do not quote any of them (grep of
`packages/extension/resources/` for "characters elided": none).

**How I tried to refute it.** Checked that the windows really compute the
same thing: each takes `appendHead('', s, H)` and `appendTail('', s, T)` of
the text seen and reports the difference; site 1's whitespace handling and
site 2's cap on both streams together sit outside the window. Checked M6's
record: the refused part (tail-only foreground output) is not proposed.

## HT-7: The three file-viewing tools take a line range in two shapes under two names, the view formatter takes a third, and the transcript reads each by hand

- flags: repetition, information leakage, non-obvious code
- package: harness
- kind: refactor
- size: S
- earlier: none
- open PR: #14953 edits two other fields of `tools/executions/toolInput.ts`; it leaves the range alone

**Evidence.**

- `read_file` takes `range: { start, end? }`, also accepting a
  `[start, end?]` array "some models (e.g. DeepSeek) send instead"
  (`tools/ReadTool.ts:30-74`, `LineNumberSchema`, `RangeObjectSchema`,
  `RangeSchema`).
- `memory view` and `executions` take `view_range: [start, end]`, both ends
  required and no object form (`tools/formatting.ts:5-13`, `ViewRangeSchema`,
  "Canonical 1-based inclusive line range for tool view_range fields";
  `tools/memory/memoryInput.ts:38`, `tools/executions/toolInput.ts:40`).
- The one formatter all three call takes a tuple
  (`formatFileView`, `formatting.ts:68-127`, `viewRange?.[0]`), so
  `read_file` converts its object back (`ReadTool.ts:170-185`) and alone
  reports a requested end past the file (`:175-179`); memory and executions
  clamp silently.
- The transcript reads `read_file`'s `input.range.start/end`
  (`shared/transcript/toolRowSections.ts:202-207`) and the executions
  tool's `input.view_range[0..1]` (`:316-324`) with their own guards.
- The Claude Code hook translation reads `read_file`'s `range.start/end`
  by hand again to build `offset`/`limit`, and writes a `range` back
  (`common/plugins/hookConfig.ts:213-243`); it has no entry for the two
  `view_range` tools.
- The executions description teaches `view_range: [start, end]`
  (`tools/ExecutionsTool.ts:719`) and its output hints repeat it
  (`tools/executions/processOutput.ts:185,187`).

**The design decision behind it.** "Which lines of a file to show" is one
input the model gives three tools; each tool chose its own name and shape,
and only `read_file` was taught the form models actually send.

**The better design.** One `LineRangeSchema` in `tools/formatting.ts` (the
object with an optional end, the array form accepted, as `read_file` has it
now) under one field name on all three tools, and `formatFileView` taking
that object and owning the "requested end past the file" note. Deleted:
`ViewRangeSchema`, `read_file`'s private copies and its tuple conversion,
one of the two transcript readers (both tools then share one). Callers
write `range: { start: 10, end: 40 }` or `[10, 40]` everywhere.

**What we give up, and risk.** A model-facing rename (`view_range` to
`range`) on two tools, a 1.0 format change for their stored inputs: a
transcript of an older run shows no range line for those calls (record
under "Needs your eye"). Keeping the `view_range` name for all three is the
other choice; either way there is one shape.

**How I tried to refute it.** Looked for a reason the shapes differ: the
executions and memory views page line windows exactly as `read_file`
does and pass the same pair to the same formatter; nothing reads an
open-ended range differently. The tuple-only schema is the one that
rejects the object form a model may send, which `read_file` already
learned to accept.

## HT-8: Smaller items, batched: prompt modules filed under `utils/`, a JSON store that parses its file two ways under a false comment, and crossed file names in `platform/defaults/`

- flags: shallow module, repetition, comment restates code, vague name
- package: harness
- kind: refactor (b's comment is a false comment)
- size: S
- earlier: (a) is a remainder of M10's theme ("`utils/` holds modules with domain owners", landed for the three modules it named, #14874) and of L2-3.10, which renamed `varsUtils.ts` to `promptFilesXml.ts` in place; (b) and (c) none
- open PR: none

**a. Three prompt-building modules live in `utils/`, and every reader is in
`agent/prompt/`.** `utils/prompt.ts` (`getPromptFileName`, `getListOfFiles`,
`renderPrompt`), `utils/files/promptFilesXml.ts` (`readFilesAsPromptXml`)
and `utils/files/agentsMd.ts` (`loadAgentsMd`). Consumers in
`packages/*/src`: `getListOfFiles` 1 (`agent/prompt/templateInputs.ts`),
`getPromptFileName` 2 (`templateInputs.ts`, `promptFilesXml.ts`),
`readFilesAsPromptXml` 1 (`templateInputs.ts`), `loadAgentsMd` 1
(`agent/prompt/PromptBuilder.ts`); `renderPrompt` is the one with readers
outside (`PromptBuilder.ts`, its re-export at `plugins.ts:201`, and three
texra modules). `packages/harness/AGENTS.md` says `utils/` is for "helpers
with no domain owner"; these have one. Move the three into `agent/prompt/`
(beside their readers), keeping `renderPrompt`'s public export. Nothing is
deleted but a directory hop and the reason a reader must look in `utils/`
for prompt rules.

**b. `JsonStore` reads and parses its file by two hand-written paths, and
two comments give a reason no caller has.** `readJsonRecordSync`
(`platform/defaults/jsonStore.ts:42-53`) and `readJsonRecord` (`:62-83`) both
read the file, treat absence as `{}`, `JSON.parse` it and refuse a
non-object with the same `TypeError` text; `open` uses the Effect one and
every later read the sync one (`current`, `:174-195`). `storageError`
says it preserves "the Node error identity exposed by this store's existing
callers" (`:23`) and `readJsonRecord` that "its existing callers match the
underlying Node errors" (`:59-60`); the callers
(`packages/texra/src/platform/defaults/nodeStores.ts:71-90,125`,
`packages/cli/src/runtime/platform/cliService.ts:91`) only print the message
(`toErrorMessage`). Better: `open` reads through `current()` (one parse, one
absence rule) and fails with what it read; the identity comments go (keep
`storageError` only if the unwrapped message is wanted).

**c. The file names in `platform/defaults/` are crossed.** The SDK's
`nodePlatform()` and `NodePlatformOptions` live in `sdkPlatform.ts`
(`:26, 69`), while `nodePlatform.ts` holds the process services
(`nodePlatformServices`, `:325`) and the project environment layer
(`workspaceEnvironmentLayer`, `:354`), which have nothing to do with
`nodePlatform()`. `platform/interfaces.ts:2-3` opens with history
("Formerly one file per port under `interfaces/`"). Rename the files for
what they hold (`nodePlatform.ts` for the SDK platform, `nodeServices.ts`
for the services and the environment layer) and drop the history line.
Importers: `node.ts:32,43`, `host.ts:44`, `effect/processLayer.ts:33`,
`controllers/session/sessionLayer.ts:41`, `agent/runtime/runRegistry.ts:34`.

**How I tried to refute them.** (a) Checked the layer order: `agent/` may
import `utils/`, and nothing below `agent/` reads these modules, so the move
adds no edge. (b) Checked whether any caller catches a Node `code` from the
store: none (grep for `.code` near `JsonStore` callers). (c) Checked for a
documented reason for the names: neither file's header gives one.

## Good modules in this area

- `tools/toolTable.ts` `toolTable`: every rule about a plugin list checked
  in one function at process build, turned into one typed error
  (`PluginsRefused`). HT-2 asks only that fact kinds join it.
- `tools/toolAvailability.ts` after M1: per-root `RcMap` entries, a sliding
  `PubSub` of numbered answers, the credential relay as a filtered stream; a
  caller writes `refresh(inputs)` and gets the round that covers its ask.
- `tools/jsonRpc.ts`: two framings, one terminal state (`close(reason)`),
  pending requests failed on close; both the MCP client and the Lean server
  sit on it.
- `platform/defaults/fileSecrets.ts`: one file per key makes concurrent
  processes safe with no lock; the commit and the announcement are one
  `ensuring`.
- `tools/core/definition.ts` `defineTool`: decode with every issue, map
  failures once, propagate interruption and storage refusals; a tool
  author writes `schema`, `guard` and `execute`.
- `tools/timeouts.ts`: the retry decision and the error label read the same
  `HttpClientError` reason, so a failure cannot be retried as one kind and
  reported as another.
- `platform/defaults/nodePlatform.ts`'s supervised spawner: a bounded
  teardown and parent-exit cleanup added under the upstream spawner, so no
  caller writes either.

## Already settled, left alone

- M2, the MCP pool's failed start held as a value: refused
  (`MCP-failed-start-rcmap-lookup`). `tools/mcp/mcpConfig.ts` still holds it
  so, as ruled.
- M3, a child's environment decided in several modules (`SENSITIVE_ENV_NAME`
  in `tools/mcp/mcpServer.ts:61`, `commandEnv` in `utils/system/execUtils.ts`):
  refused (`RT-child-environment-one-owner`).
- M4, the plan tool decoding its own past results for its goal, and M9, the
  catalog follower's subscriptions and readiness `Deferred`
  (`tools/agentCatalogFollower.ts:240-264`): held by the owner with #14773.
- M7's file-lane maps (`keyLanes` in `fileSecrets.ts:42`, `writeLanes` in
  `jsonStore.ts:90`, `fileWriteLanes`, `memoryTreeLanes`): refused
  (`M7-file-lanes-as-references`); `logSink` and `externalRoots` module
  state left as M7 says.
- M8's roots: `WorkspaceRoots.globalStorage`/`globalState` refused
  (`PLATFORM-roots-drop-global-slots`, `SESSION-roots-carry-rooted-fs`);
  `AgentDirectoriesPort.teamMembers?` and `resourcesRoot?` kept (X S2).
- `globalStorageFsLayer` (`platform/rootedFs.ts:294-298`, one caller) and
  the `create*Location` factories (`common/storage/fileLocation.ts:10-41`):
  listed as borderline by lens 2
  (`../2026-11-08-design-red-flags-lenses-2/README.md:231-235`) and not
  ranked; nothing new.
- `DOCS-prepare-run-workspace-per-call-stays`: when the documents plugin
  calls `prepareRunWorkspace`. HT-5 moves the class, not the call.
- Warning sites written as `logWarning(...).pipe(annotateLogs({ data }),
  withLogChannel(...))` beside `logFailure` (`logger/effectLog.ts:28-34`):
  #14953 (branch `claude/optimistic-cori-q0n270`, "eight warning sites log
  through logFailure") is converting them.
- Plugin hooks with one implementer (`Plugin.decision`, `agentBlock`,
  `requires`, `FactKind.accepts`/`supersedes`): the SDK surface, per the
  options inventory's "Rejected"
  (`.agents/docs/proposed/simplification/2026-11-03-fewer-processing-options.md`).
