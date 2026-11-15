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
