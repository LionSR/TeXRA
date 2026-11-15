# HT: harness tools and skills

Read at `cb22acd`. Covered: `packages/harness/src/tools/` (65 files with
`skills/`, about 13,900 lines) and `packages/harness/src/skills/`.

### HT-1: `skills list --source` reaches discovery twice, once as the process's options and once as a per-call override

- **Package:** harness, cli
- **Flags:** an option for a special case (per-call override); repetition (one fact, two paths); pass-through variable
- **Evidence:**
  - Every CLI command builds its context from the global flags:
    `packages/cli/src/commands/_helpers/defineCliCommand.ts:202`
    (`loadConfigAndWarn(ctx.args, ctx.rawArgs)`) →
    `packages/cli/src/commands/_helpers/globalArgs.ts:157`
    (`skillSourcePaths: collectStringFlagValues(rawArgs, 'source', 's')`) →
    `packages/cli/src/runtime/platform/cliContext.ts:525-526` →
    `packages/cli/src/runtime/platform/cliProcessRuntime.ts:67` →
    `packages/harness/src/effect/processLayer.ts:286`
    (`HostSkillSources.options`).
  - `skills list` reads the same flag a second time and passes it as a
    per-call override: `packages/cli/src/commands/skills.ts:85`
    (`additionalPaths: collectStringFlagValues(ctx.rawArgs, 'source', 's')`),
    `:31` (`Skills.enabled(roots, options)`).
  - The harness threads that override through three functions:
    `packages/harness/src/skills/runtimeSkills.ts:104`, `:211`, `:269`
    (`options?: SkillSourceOptions`) down to `:115`
    (`options: options ?? host.options`). The two operands are the same value
    for the only caller that passes one.
  - Consumers of the override: production 1 (`cli/src/commands/skills.ts:31`);
    the other `Skills.enabled` caller (`SkillsListForm.tsx:85`) and both
    `loadRuntimeSkillCatalog` callers pass none. Tests: 0 pass it
    (`packages/harness/test/cli/CliSkills.vitest.ts` sets
    `HostSkillSources.options` instead).
- **Better design:** the process's `HostSkillSources.options` is the one
  owner of the custom roots. `Skills.enabled(roots)` takes roots only;
  `listSkills(context)` takes no options.
- **Deleted:** the `options` parameter of `Skills.enabled`,
  `loadEnabledRuntimeSkills` and `discoverRuntimeSkills`; the `options`
  argument of `listSkills` and the second `collectStringFlagValues` read; the
  two doc sentences "`options` replaces the host's options for one call".
- **Size:** about 25 lines, 2 files.
- **Risk / owner decision:** none. `Skills` is exported from
  `@texra-ai/harness/host`; dropping an optional parameter is a narrowing of a
  published signature, so the API report changes.

### HT-2: `SkillSourceContribution.id` is a key nothing reads, kept for "consumers that will read it"

- **Package:** harness
- **Flags:** speculative generality (an export with no consumer); a comment that describes code that does not exist
- **Evidence:**
  - `packages/harness/src/skills/skillSources.ts:114` declares `id`;
    `:250-252` says "the id stays a checked key for the display and toggle
    consumers that will read it"; `:257-263` throws on a repeated id.
  - `grep -n '\.id\b' packages/harness/src/skills/` finds one hit,
    `skillSources.ts:268` (`tier.id`, the tier's id, not the contribution's).
    No production or test code reads a contribution's `id`.
  - Every contribution is written in this one file
    (`CORE_SKILL_CONTRIBUTIONS` `:126`, `pluginSkillContribution` `:200`,
    the `project` literal `:225`); the only varying input is the plugin id
    list, which `toolTable` already refuses when it repeats
    (`packages/harness/src/tools/toolTable.ts:287`).
  - Open PR #14949 changes this file (it collapses `SkillRoot` into
    `Omit<SkillSource, 'scope'>`); its version still has `id` (`:104`) and the
    duplicate check (`:251`).
- **Better design:** a contribution is `{ tier, roots }`. The duplicate-id
  loop goes; the plugin list's own uniqueness check is the one check.
- **Deleted:** `SkillSourceContribution.id`, seven `id:` literals, the
  duplicate-id loop and its `throw`, the "will read it" sentence.
- **Size:** about 25 lines, 1 file (plus test fixtures that spell `id`).
- **Risk / owner decision:** none.

### HT-3: the duplicate-name and duplicate-path rule for skills is applied twice, per root and again across roots

- **Package:** harness
- **Flags:** repetition (a rule with two owners); special and general code mixed
- **Evidence:**
  - Per root: `packages/harness/src/skills/loadSkills.ts:107-108`
    (`seenNames`, `seenRealPaths`), `:166-179`.
  - Across roots: `:258-259`, `:265-276`, the same two sets and the same two
    issues (`dupRealpathIssue`, `dupNameIssue`).
  - A root's skills reach `accept` in the order the root scan produced them
    (`:128` sorted by entry name; a `source` tier accepts each root's list as
    is at `:336`, the `name` tier re-sorts by the same `entryName` at `:339`),
    so the cross-root pass rejects exactly what the per-root pass rejects. The
    one difference is the message detail: the per-root realpath issue carries
    no skill name (`:167`), the cross-root one does (`:266`), which is why
    `dupRealpathIssue` has an optional third parameter (`:80-90`).
  - `scanCommandFile` (`:192`) is a "root" of one skill and has no dedup at
    all, so the per-root pass already is not a property of every scan.
- **Better design:** a root scan returns what it loaded, in name order, with
  each entry's real path; `discoverSkillSources.accept` is the one place a
  name or a path is refused. A skill that failed to load keeps reporting its
  own errors once, because `accept` sees only loaded skills and the scan
  reports load errors by real path.
- **Deleted:** `seenNames` / `seenRealPaths` and both checks in
  `scanSkillRoot`, the optional `name` parameter of `dupRealpathIssue`.
- **Size:** about 30 lines, 1 file.
- **Risk / owner decision:** one visible change: two directories in one root
  that link to the same broken `SKILL.md` report its load errors twice unless
  the scan keys its error report by real path. Small; no decision needed.

### HT-4: seven of the ten `SkillIssueCode` literals are never branched on, and one exists only through a relabel

- **Package:** harness, cli
- **Flags:** an error kind nothing branches on; non-obvious code; overexposure
- **Evidence:**
  - `packages/harness/src/skills/skillLoader.ts:89-99` declares ten codes and
    exports the type through `packages/harness/src/host.ts` (`SkillIssueCode`,
    `SkillIssueSeverity`).
  - The only reader of `code` in `packages/*/src` is
    `packages/cli/src/commands/skills.ts:34-36`, which asks one question, "is
    a source the user named unusable": `missing_source`, `invalid_source`,
    `source_read_error`. `duplicate_name`, `duplicate_realpath`,
    `invalid_frontmatter`, `invalid_name`, `missing_description`,
    `name_mismatch` and `read_error` have 0 readers in production code.
  - `source_read_error` is produced two ways: directly
    (`loadSkills.ts:233`) and by rewriting a `read_error` after the fact when
    its path happens to equal a required source's
    (`loadSkills.ts:324-331`: `error.code === 'read_error' && error.path ===
    source.path ? { ...error, code: 'source_read_error' }`).
  - `invalid_source` is also what a withheld installed plugin reports, at
    `warning` severity (`runtimeSkills.ts:131-133`), so `texra skills list`
    exits with a usage error when an installed plugin is untrusted, a source
    the user did not name on the command line.
  - `validateRequiredSource` says "Skill source is not a directory" for a
    command source that is required to be a file (`loadSkills.ts:220`).
- **Better design:** an issue is `{ severity, message, path?, name? }` plus
  one boolean the scan sets where it knows it, `source: true` on an issue
  about a required source itself. `scanSkillRoot` takes the source and marks
  its own root read failure, so nothing rewrites a code by comparing paths.
  The CLI asks `issue.source`.
- **Deleted:** `SkillIssueCode` and its ten literals, the `code` argument of
  `issue(...)` at about 20 call sites, the relabel map at
  `loadSkills.ts:324-331`, the `SkillIssueCode` export in `host.ts`.
- **Size:** about 70 lines, 5 files.
- **Risk / owner decision:** **owner decision**: `SkillIssueCode` is a
  published `@texra-ai/harness/host` name (`host.ts:210`), and the `ndjson`
  output of `texra skills list` emits each issue whole as a `skill-issue`
  record (`packages/cli/src/commands/skills.ts:66`,
  `packages/cli/src/schemas/cliOutput.ts:236`), so `code` is on a CLI wire. Also decide whether a withheld installed plugin should
  fail `skills list` (today it does, by sharing `invalid_source`).

### HT-5: the tool switch record has two readers with two error types because its reader lives above `skills/`

- **Package:** harness
- **Flags:** repetition (one read, two owners); misplaced owner
- **Evidence:**
  - `packages/harness/src/tools/plugins.ts:185-201`: `storedDisabledTools`
    (decode → `StateReadFailed`) and `readDisabledTools(store)` (get, decode,
    default to the empty set). Production consumers of `readDisabledTools`: 4
    files (`liveTools.ts:199`, `pluginCatalog.ts:106`,
    `agent/runtime/loop/step.ts:224`,
    `agent/index/BundledAgentDirectories.ts:32`).
  - `packages/harness/src/skills/runtimeSkills.ts:176-186`
    (`readDisabledSkills`) writes the same read by hand:
    `stores.globalState.get(DISABLED_TOOLS_KEY.key)`, `decodeDisabledTools`,
    `ids ?? []`, and maps the failure to a plain `Error` instead of
    `StateReadFailed`. `skills/` is layer 6 and may not import `tools/`
    (layer 7), which is the only reason for the copy.
  - Neither helper touches anything of `tools/`: both need only
    `StateStore` / `StateReadFailed` (`@shared/config/settings`) and the
    decoder already in `packages/harness/src/shared/state/disabledTools.ts`.
- **Better design:** `readDisabledTools` and `storedDisabledTools` move
  beside the key and its decoder in `@shared/state/disabledTools`, which then
  owns the record whole: key, decoder, read. `readDisabledSkills` calls it.
  `decodeDisabledTools`'s "each reader turns the failure into its own error"
  stops being true and the decoder can fail with `StateReadFailed` directly.
- **Deleted:** the hand-written read in `runtimeSkills.ts:179-186`, the
  `Result.mapError` wrapper `storedDisabledTools` (the decoder returns the
  typed error), one error type on the skills listing path.
- **Size:** about 40 lines, 7 files (import moves).
- **Risk / owner decision:** none.

### HT-6: the executions tool passes a context bag seven handlers never read, and two helpers take a caller that is never absent

- **Package:** harness
- **Flags:** pass-through variable; special and general code mixed (a branch for a case that cannot occur)
- **Evidence:**
  - `packages/harness/src/tools/ExecutionsTool.ts:71`:
    `RunToolContext { runId, runs }`, built once at `:322`
    (`{ runId: run.runId, runs: yield* Runs }`).
  - Seven handlers take `context` and do not use it: `showReport` (`:494`),
    `showResultMeta` (`:511`), `showConfig` (`:524`), `showConversation`
    (`:551`), `readFile` (`:607`), `listWorkspaceFiles` (`:639`),
    `readWorkspaceFile` (`:658`). `runs` is read in three places
    (`showSummary`, `handleKill`, `waitForRuns`), each of which already runs
    with `SessionServices` in context and can `yield* Runs`.
  - `listExecutions(caller: RunId | undefined, …)`
    (`executions/executionListing.ts:38`, branch at `:59`) and
    `sendToRun(caller: RunId | undefined, …)` (`executions/send.ts:50`,
    branches at `:70-72`, `:74`, `:83`) each have one caller, the route table
    (`ExecutionsTool.ts:184`, `:188`, `:215`), which passes `context.runId`,
    a `RunId` (`ToolRun.runId`, `agent/core/tools/ToolTypes.ts:209`). The
    "from the user when no run calls" case has 0 callers in production and
    tests.
  - `senderOf(caller: RunId | undefined)`
    (`agent/followUp/followUpMessages.ts:80`) has that one caller too.
- **Better design:** a route handler gets `{ caller, input, runId, rest }`;
  the three that need the registry read `Runs` themselves. `listExecutions`
  and `sendToRun` take `caller: RunId`.
- **Deleted:** `RunToolContext`, seven unused parameters, `senderOf` (its
  one use becomes `{ kind: 'run', runId: caller }`), the `'the user'` /
  `caller ?? 'user'` / `caller === undefined` branches.
- **Size:** about 60 lines, 4 files.
- **Risk / owner decision:** none.

### HT-7: skill sources are a contribution registry with one producer, sorted back into a fixed tier order on every call

- **Package:** harness
- **Flags:** speculative generality (an extension point with one producer); special and general code mixed; repetition (the tier order written as data and recovered by a sort)
- **Evidence:**
  - `packages/harness/src/skills/skillSources.ts:108-117`: `SkillSourceContribution { id, tier, roots(call) }`. Every contribution is written in this file: `CORE_SKILL_CONTRIBUTIONS` (`:126-188`, six literals), the `project` literal (`:225-237`) and `pluginSkillContribution` (`:200-212`), joined by `hostSkillContributions` (`:221-243`).
  - Production producers of the list: 1, `packages/harness/src/effect/processLayer.ts:284-291` (`contributions: hostSkillContributions(options.plugins.map(({ id }) => id), options.skills.projectDataDirName)`). `HostSkillSources` (`skills/runtimeSkills.ts:63-71`) stores that list beside `resourcesPath` and `options`, the other two inputs it was built from.
  - `foldSkillSources` (`skillSources.ts:254-301`) then walks `SKILL_TIERS` (`:65-77`) and, per tier, every contribution whose `tier` matches (`:266-268`): it recovers the order `hostSkillContributions` could have written directly. The `id` column of `SKILL_TIERS` exists only to be matched against `contribution.tier`.
  - Test consumers: `packages/harness/test/skills/RuntimeSkills.vitest.ts:34-48` hand-builds contributions (`{ id: 'test:0', tier, roots: () => [...] }`) to inject fixture roots; `packages/harness/test/cli/CliSkills.vitest.ts:109-112,230-233` call `hostSkillContributions([])`. Neither type is exported from an entry (`host.ts:203-213` exports `HostSkillOptions` and `SkillSourceOptions` only).
  - Open PR #14949 changes `skillSources.ts` (it folds `SkillRoot` into `Omit<SkillSource, 'scope'>`) and keeps the contribution list and its fold.
- **Better design:** `HostSkillSources` holds what the host gave (`HostSkillOptions` plus the plugin ids). One function `skillSourceTiers(host, call)` returns the tiers in precedence order, each written once in sequence: custom roots, project, interop-project, user, installed plugins, interop-user, bundled (the core `skills/` and each plugin's `plugins/<id>/skills`). The path dedupe (first occurrence wins, `required` sticks) stays in that function. The runtime-skills test writes its fixtures into the project and storage roots it already creates instead of injecting contributions.
- **Deleted:** `SkillSourceContribution` (with HT-2's `id` and its duplicate check), `CORE_SKILL_CONTRIBUTIONS`, `pluginSkillContribution`, `hostSkillContributions`, the `id` column of `SKILL_TIERS` and the tier-matching loop in `foldSkillSources`, the `contributions` field of `HostSkillSources`. Subsumes HT-2 if both land.
- **Size:** about 120 lines, 5 files (2 tests).
- **Risk / owner decision:** none; no published name changes. Land after #14949 or in its branch.

### HT-8: "is this plugin switched on" has the switch-only rule in one reader and a raw membership test in three others

- **Package:** harness, texra
- **Flags:** repetition (a rule with several owners); information leakage
- **Evidence:**
  - The rule: only a plugin with a switch (`toggle`) can be off; "a stored id of any other switches nothing" (`packages/harness/src/tools/liveTools.ts:141-148`, `onOf`). It is applied to the catalog's live set (`:160-166`) and, through `ProcessCatalog.onOf` (`tools/sessionTools.ts:93-94`), to each step's pin (`:183-190`), which reads the record itself (`agent/runtime/loop/step.ts:221-226`).
  - Three other readers of the same record test membership without it:
    - bundled agents: `agent/index/BundledAgentDirectories.ts:31-43` (`disabled.has(id)` over every registry entry);
    - bundled skills: `skills/runtimeSkills.ts:144-145` (`pluginOff`: `disabled.plugins.includes(source.plugin)`), over the hand-written read HT-5 names (`:176-186`);
    - the Tools dashboard: `ToolCatalog.disabled` (`liveTools.ts:199`, raw `readDisabledTools`) read at `packages/texra/src/controllers/settingsView/ToolDashboardData.ts:131-134` into `enabled: !disabledIds.has(plugin.id)` beside `toggleable: plugin.toggle !== undefined` (`:184-185`).
  - The record is shared by every composition that opens the same state store, and is kept whole on purpose: "A recorded id that names no plugin of `plugins` is kept: one composition's list is not every list that shares the store" (`tools/toolAvailability.ts:88-90`). So an id a composition lists without a switch is on for its tools (`onOf`) and off for its agents, its skills and its dashboard row. Today's writers (`seedDisabledToolDefaults`, `toolAvailability.ts:92-111`; `setEnabled`, `liveTools.ts:200-212`) only write switched ids of their own composition, which is why the readers agree in practice.
  - Readers of the record: 5 production sites in 5 files (`pluginCatalog.ts:340-356`, `step.ts:224`, `BundledAgentDirectories.ts:32`, `runtimeSkills.ts:179`, `liveTools.ts:199`); its writers: 2.
- **Better design:** the read applies the rule. `readDisabledTools(store)` becomes `switchedOff(table)(store)`, returning only the ids of plugins of `table` that have a switch, beside the key and decoder (HT-5 moves the reader to `@shared/state/disabledTools`; this one needs the table, so it stays in `tools/plugins.ts` or takes the switchable ids as data). Every reader then writes `off.has(id)` and means the same thing. A stronger variant is to have agents, skills and the dashboard read the catalog's live `on` set instead of the store, which leaves the store read with one reader (the switches stream); that changes when a fresh switch is seen at catalog build, so it is the owner's call.
- **Deleted:** `onOf` and `ProcessCatalog.onOf` (the filter moves into the read), `ToolCatalogShape.disabled`'s raw read (it returns the filtered set), the dashboard's second reading of `toggle` for `enabled`.
- **Size:** about 40 lines, 7 files.
- **Risk / owner decision:** none for the conservative design (the answers agree for every record today's writers produce). Land with HT-5.

### HT-9: every diff returns a timeout warning its caller must remember to log, and two callers log it by hand

- **Package:** harness, texra, desktop
- **Flags:** conjoined methods; repetition (one rule, seven sites); silent degradation (a caller that forgets the second call drops the warning)
- **Evidence:**
  - `packages/harness/src/tools/unifiedDiff.ts:33-36` (`DiffHunks { hunks, timeout }`), `:159-188` (`buildDiffHunks` returns the warning as a string), `:190-197` (`reportDiffTimeout` logs it), `:257-265` (`unifiedDiffText` passes it through). The doc says the caller "reports it through `reportDiffTimeout`, so a degraded diff is never silent" (`:155-157`): the guarantee is a convention.
  - The pair is written at every caller: `tools/approval/toolEditApproval.ts:98-102`, `:157-165`, `:187-188`; `packages/texra/src/agent/output/diffComputation.ts:60-61`; `packages/texra/src/controllers/progressView/ProgressDocumentTaskFileActionsController.ts:190-191`. Two write the log by hand: `packages/texra/src/tools/documents/documentResult.ts:55-56` (`if (timeout !== undefined) yield* Effect.logWarning(timeout)`, without the `unifiedDiff` channel; the function, `unifiedDiffOf`, is `unifiedDiffText` plus that log, with 2 callers) and `packages/desktop/src/main/desktopDiffHost.ts:97-103` (restates the channel string `'unifiedDiff'`).
  - Every caller is already inside `Effect.gen`; none uses `timeout` for anything but the log. `toolEditApproval.ts:60-64` (`diffEdit`) also restates `unifiedDiffText`'s identical-text shortcut.
  - Open PR #14953 replaces the desktop's hand-written log with `reportDiffTimeout` (checked on `origin/claude/optimistic-cori-q0n270`); it keeps the pair, and `documentResult.ts` is not in it.
  - Test consumers of the three names: 0.
- **Better design:** `buildDiffHunks` and `unifiedDiffText` are Effects that log their own fallback on the `unifiedDiff` channel and answer only the hunks or the text; the identical-text shortcut lives in `buildDiffHunks` once. Callers write `const hunks = yield* buildDiffHunks(a, b)`.
- **Deleted:** `reportDiffTimeout`, `DiffHunks.timeout` (and `DiffHunks` itself becomes the hunk array), `diffEdit`, texra's `unifiedDiffOf` (its two callers call `unifiedDiffText`), seven report calls, the desktop's hand-written log.
- **Size:** about 60 lines, 8 files.
- **Risk / owner decision:** **owner decision**: `buildDiffHunks`, `reportDiffTimeout`, `unifiedDiffText` and `DiffHunks` are `@texra-ai/harness/host` exports (`packages/harness/src/host.ts:113-120`); two become Effects and one is removed.

### HT-10: a tool path's `fsPath` encodes which filesystem answers it in its spelling, and the edit flow decodes it three times

- **Package:** harness, texra
- **Flags:** information leakage (a decision carried as a path's spelling); repetition; pass-through (a fact dropped and recomputed)
- **Evidence:**
  - `packages/harness/src/tools/pathResolution.ts:31-36`: `fsPath` is "absolute when operating outside the workspace, workspace-relative otherwise", set at `:168` (`call.workingDirectory ? resolved.absolutePath : relative`) and `:195`. The resolution also carries `absolute` (`:30`), the same file.
  - Readers re-derive the filesystem from the spelling: `tools/approval/approvedWrite.ts:62-66` (`nodePath.isAbsolute(path) ? undefined : yield* WorkspaceFs`, then `workspace.resolve(path)` to get the absolute path back for the lane key); `packages/texra/src/tools/latex/ExtractBibliographyTool.ts:96-107` (the same branch, with a four-line comment explaining the encoding).
  - The edit flow has the absolute path, drops it, and rebuilds it: `tools/fileEditFlow.ts:86-90` destructures `fsPath: path` and `absolute: absolutePath`, reads the file at `absolutePath` through the process `FileSystem` (`:95-107`), returns only `path` in its target (`:109-116`), and `applyApprovedFileEdit` rebuilds the absolute form (`:239-243`, `isAbsolute(path) ? path : workspace.resolve(path)`) to test for a custom agent root. So one edit reads through the process filesystem at the absolute path and writes through `WorkspaceFs` at the relative one.
  - The other readers want something else: `attachments.ts:187` uses `fsPath` only for a MIME lookup (`absolute` serves); `ReadTool.ts:241` passes it as `filePath` to `buildFileAttachment`, which only checks it is non-empty when `resolved` is given (`attachments.ts:139-151`); `grep.ts:149` passes it to `rg`, which runs in the same root `relative` is relative to (`:158`).
  - `WritableFileTarget` (`fileEditFlow.ts:52-57`) carries `exists` and `originalContent: ''` for a missing file, and `applyApprovedFileEdit` turns that back into `null` (`:223`), the form `ToolEditProposal` uses (`approval/toolEditApproval.ts:31-32`).
  - `WorkspacePathResolution` and `ToolPathResolution` are published by `@texra-ai/harness/plugins` (`packages/harness/src/plugins.ts:143-144`); `fsPath` readers: 5 in harness, 1 in texra; tests: 0.
- **Better design:** a resolution is `{ relative, absolute, display, external? }`. File I/O uses `absolute`. The one place that chooses a filesystem is `writeApprovedContent`, by the fact it is about (`isPathWithin(workspace.root, absolute)`), or, since the loop guard already refused an escape and the edit flow already reads through the process `FileSystem`, it writes through that too. `grep` passes `relative`. `WritableFileTarget.originalContent` is `string | null` and `exists` goes.
- **Deleted:** `fsPath` (field and two assignments), the `isAbsolute` branches in `approvedWrite.ts`, `fileEditFlow.ts` and `ExtractBibliographyTool.ts` with their comments, the rebuilt absolute path in `applyApprovedFileEdit`, `WritableFileTarget.exists`.
- **Size:** about 50 lines, 8 files.
- **Risk / owner decision:** **owner decision**: a published type loses a field, and whether the approved write keeps `WorkspaceFs`'s confinement as a second check (against a symlink swapped in during the approval wait) or writes through the process filesystem like the read. Under a working directory, `grep` output lines become relative instead of absolute.

### HT-11: Batched: values a caller already holds, passed or checked again

- **Package:** harness, texra, cli
- **Flags:** repetition; an option for a special case; a branch for a case that cannot occur; validating data the code built itself
- **Evidence and fix, each deleting what it names:**
  - a. `ExternalToolCheckResult.tools` (`tools/toolAvailabilityService.ts:19`) restates `plugin.tools`: computed twice in `probeToolGroup` (`tools/toolAvailability.ts:303`, `:312`) and read once, in `packages/texra/src/controllers/settingsView/ToolDashboardData.ts:139,153`, inside a loop that holds `plugin` and that builds the built-in rows' tool names from `plugin.tools` (`:120-122`). Drop the field; the dashboard reads `plugin.tools` for both kinds of row. The type is a `@texra-ai/harness/host` export (`host.ts:266`): a field removal.
  - b. `serializeFilteredConfig(record, category)` (`tools/executions/configView.ts:26-40`): the two callers compute `category` two ways, the executions tool by reading the session view only for it (`tools/ExecutionsTool.ts:538-546`) and the CLI from the config (`packages/cli/src/runtime/history.ts:427-430`). The record decides it (`isTaskConfig`, `shared/schemas/runRecords.ts:34`; `isAgentRunRecord`, `agent/core/definition/RunRecord.ts:26`). Drop the parameter, the view read and the CLI's ternary. Published from `schemas.ts:32`: a signature change.
  - c. `annotateExternalPermission` (`tools/pathResolution.ts:230-238`) starts with `if (resolution.external) return resolution;`; its one caller (`:164-171`) passes a literal with no `external`. Drop the branch.
  - d. `RetryTransientFetchOptions.onFailedAttempt` (`tools/timeouts.ts:110-113`, its `tapError` at `:131-139`) has one user, a debug line in `packages/texra/src/tools/lean/LoogleTool.ts:157-160`. Drop the option and the branch (Loogle's final failure is still reported by `searchOne`). Published from `plugins.ts:239`.
  - e. `SkillSchema` (`skills/SkillSchema.ts:9-18`) re-decodes a skill the loader just built from parts it validated (`skills/skillLoader.ts:267`, `decodeUnknownSync`; `:330`, `decodeUnknownEffect`, whose failure would surface as a `read_error`). Replace with an `interface Skill`. Open PR #14953 edits the schema's checks and keeps it.
  - f. With HT-4: `SkillFrontmatterError` (`skills/skillLoader.ts:30-36`, one producer, one `catchTag` at `:340`) exists to choose `invalid_frontmatter` over `read_error`, a code nothing branches on. It goes with the codes.
- **Size:** about 70 lines, 10 files.
- **Risk / owner decision:** a, b and d touch published SDK names (a field, a parameter, an option); none changes stored data or user-visible behavior.

## Good modules here

- `tools/core/definition.ts` (`defineTool`) and `tools/core/inputSchema.ts` (`nullishWithDefault`): one way to declare a tool and its input.
- `tools/catalogEntries.ts`: a tool's identity digest over its name and schema with every description stripped by keyword (`withoutSchemaDescriptions`), and `mergeEntries`' all-or-nothing owner rule; the frozen `WeakMap` cache of wire parameters is justified in its comment.
- `tools/toolAvailability.ts`: one `RcMap` entry per held root, a sliding `PubSub` of numbered rounds, a per-plugin deadline; the shape M1 asked for.
- `tools/sessionTools.ts` `follow` / `pinStep`: a switch change holds the new set before releasing the old, so a plugin on in both is never rebuilt.
- `tools/approval/approvedWrite.ts` `writeApprovedContent`: the approved edit is merged onto the file as it is now under the file's write lane, and a conflict is a typed error, not an overwrite.
- `tools/timeouts.ts`: the retry decision and the error wording read the same `HttpClientError` reasons, so a failure cannot be retried as transient and then reported as permanent.
- `tools/jsonRpc.ts`: unchanged from round 2's verdict.

## Considered and left alone

- The module-level `memoryTreeLanes` map (`tools/memory/memoryFileSystem.ts:95`): refused with the other `PerKeyLanes` maps in `.agents/docs/refuted-candidates.json`.
- The MCP pool's failed start held as an `RcMap` value (`tools/sessionTools.ts:11-13`, `tools/mcp/mcpConfig.ts`): refused (`MCP-failed-start-rcmap-lookup`, M2).
- `agentCatalogFollower.ts`'s subscriptions and the plan tool's goal recovery: M9 and M4, held by the owner.
- `toolTable.ts:262-264` `NEEDS_NOTHING` for a switched plugin with no probe: the shape M11 landed.
- `readMemoryMeta`'s `Effect.try` and the memory frontmatter fallback: LF-1 (this round). The `killPolicy.ts:2` comment: LC-1a (this round).
- `codemode/discovery.ts`'s hand-written BM25: the header gives the reason SQLite FTS5 does not serve (its tokenizer does not split `read_file` or camelCase), and nothing is stored.
- `formatListingLine` and `formatChildLine` (`tools/executionFormatters.ts:258-278`): two lines for two contexts with one shared timestamp expression; merging them deletes nothing worth a finding.
- `getGitignoreMatcher` returns `ignores` (read by `glob`) and `ignoreFiles` (read by `grep`): one read serving two tools, fine.
- `MemoryStore.pin` re-adding `max` to `cap-reached` (`tools/memory/memoryStore.ts:143-147`): one reader, a three-line nit.
- `buildFileAttachment({ filePath, resolved? })`: two callers, one with a resolution and one without; both forms are used.
- The `Schema.NonEmptyString` edits open PR #14953 makes across nine files of this slice are not design findings.

## Summary

| Id | Title | Package | Flags | Size | Owner decision? |
| -- | ----- | ------- | ----- | ---- | --------------- |
| HT-1 | `skills list --source` reaches discovery twice: process options and a per-call override | harness, cli | option for a special case; repetition; pass-through variable | ~25 lines, 2 files | no (narrows a published signature) |
| HT-2 | `SkillSourceContribution.id` is a key nothing reads | harness | export with no consumer; false comment | ~25 lines, 1 file | no |
| HT-3 | Skill duplicate-name and duplicate-path rule applied per root and again across roots | harness | repetition; special and general mixed | ~30 lines, 1 file | no |
| HT-4 | Seven of ten `SkillIssueCode` literals are never branched on; one exists through a relabel | harness, cli | error kind nothing branches on; non-obvious code; overexposure | ~70 lines, 5 files | yes (published name, CLI ndjson wire, withheld plugin fails `skills list`) |
| HT-5 | The tool switch record has two readers with two error types | harness | repetition; misplaced owner | ~40 lines, 7 files | no |
| HT-6 | Executions tool passes a context bag seven handlers never read; two helpers take a caller never absent | harness | pass-through variable; impossible branch | ~60 lines, 4 files | no |
| HT-7 | Skill sources are a contribution registry with one producer, re-sorted into a fixed tier order | harness | speculative generality; special and general mixed; repetition | ~120 lines, 5 files | no |
| HT-8 | "Is this plugin switched on": the switch-only rule in one reader, raw membership in three | harness, texra | repetition; information leakage | ~40 lines, 7 files | no (stronger variant is the owner's) |
| HT-9 | Every diff returns a timeout warning its caller must log; two log it by hand | harness, texra, desktop | conjoined methods; repetition; silent degradation | ~60 lines, 8 files | yes (published `host` names) |
| HT-10 | `fsPath` encodes the filesystem choice in a path's spelling; the edit flow decodes it three times | harness, texra | information leakage; repetition; pass-through | ~50 lines, 8 files | yes (published type; write confinement) |
| HT-11 | Batched: values a caller already holds, passed or checked again (6 items) | harness, texra, cli | repetition; option for a special case; impossible branch; self-validation | ~70 lines, 10 files | yes for a, b, d (published SDK names) |
