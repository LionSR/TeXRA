# TT. The app's tool plugins (`packages/texra/src/tools/`)

Read at `cb22acd`. Covered: `packages/texra/src/tools/` (19,022 lines):
`registry.ts`, `agentCli/`, `setup/`, `github/`, `lean/`, `zotero/`,
`arxiv/`, `inquiry/`, `documents/`, `latex/`, `comment/`, `media/`,
`approval/`, `userQuestion/` and the root tool files. Paths below are
relative to `packages/texra/src/tools` unless they start with `packages/`.
Consumer counts are `grep -rw` over `packages/*/src` (production) and over
`packages/*/test`, `packages/*/tests`, `src/` (tests).

`node_modules` is not installed in this checkout, so no Effect API could be
opened in `node_modules/effect`. Every Effect API named below is one the
repo already calls at the cited site, or one an earlier report verified
against 4.1.2 and is cited as such; nothing is cited from memory.

Open PRs in this slice: #14953 touches twelve files here but only swaps
`Schema.String.check(Schema.isMinLength(1))` for `Schema.NonEmptyString`
(read from `origin/claude/optimistic-cori-q0n270`); #14959 touches
`documents/documentTools.ts`. Neither fixes a finding below.

---

### TT-1: An agent-CLI launch is three shared functions each provider calls in order, with the claim, the name and four strings threaded between them

- **Package:** texra
- **Flags:** temporal decomposition; pass-through variable; an option for a
  special case; repetition
- **Evidence:** `agentCli/agentCliShared.ts` exports three steps of one
  operation: `dispatchAgentCliTool` (`:155`), `launchAgentCliSession`
  (`:102`) and `buildAgentCliTurn` (`:238`). Each has exactly two callers,
  `codex.ts` and `claudeAgent.ts` (3 production files, 5/6/6 refs; 0 test
  files), and each provider calls them in the same order with its own glue
  between:
  - The thread claim is a pass-through variable through four frames:
    `dispatchAgentCliTool` hands it to `launch(claim)`
    (`agentCliShared.ts:197`), the provider hands it to its
    `launchXSession(…, claim)` (`codex.ts:433,467`; `claudeAgent.ts:416,446`),
    which hands it to `buildXTurn({ claim })` (`codex.ts:495`;
    `claudeAgent.ts:506`), which hands it back to the shared
    `buildAgentCliTurn({ claim })` (`codex.ts:347`; `claudeAgent.ts:357`)
    where it is finally closed (`agentCliShared.ts:276-278`). No provider
    frame reads it.
  - The provider's name is given twice per call: `agentName` to the dispatch
    and again to the launch (`codex.ts:429` `CODEX_AGENT_NAME`, `:485` the
    literal `'codex'`; `claudeAgent.ts:409,480`), and a third time as the
    delivery's `family` (`codex.ts:351,360` `'codex'`;
    `claudeAgent.ts:365,375` `'claude-agent'`).
  - Five display strings per provider, three of them derivable from one
    label: `threadLabel: 'Codex thread'`, `registerFailedMessage: 'Failed to
    register Codex run.'`, `summaryLabel: 'Codex'`, plus `launchedLine` and
    `followUpLine` (`codex.ts:432,488,497-499`; `claudeAgent.ts:414,483,508-510`).
    The two `followUpLine`s differ only in `thread_id` / `session_id`.
  - `delivery` and `errorDelivery` are callbacks that build the same record
    in both providers: `{ family, runId, prompt, attributes: [{ name:
    'thread-id' | 'session-id', value }], wallTime, response, usage, lines }`
    (`codex.ts:350-364`; `claudeAgent.ts:364-380`). `runId` and `prompt` are
    values the shared code already holds (`agentCliShared.ts:90,84`); the
    provider receives `runId` only to hand it back.
  - `isTurnError?` / `turnErrorMessage?` are "omitted by providers (codex)
    that always throw on failure" (`agentCliShared.ts:226-228`): an option
    for one provider. Its default text `'The provider reported a failed turn
    without throwing.'` (`:270`) cannot be reached, because the one provider
    that passes `isTurnError` also passes `turnErrorMessage` with its own
    `||` default of the same sentence (`claudeAgent.ts:361-363`).
    `errorDelivery(turn | null, err)` (`:225`) takes two values of which one
    is always null.
  - Codex's usage is computed twice per turn, once by `getUsage` and once
    inside `delivery` (`codex.ts:349,357`).
  - The receipt prints the run id twice: `` `Run ID: ${runId}` `` and
    `` `Run: ${runId}` `` (`agentCliShared.ts:140-141`).
    `2026-11-06-root-designs-pr1-compromises.md:314` notes the pair "on a
    subagent's receipt" as pre-existing; this is the agent-CLI copy.
- **Better design:** one function owns the launch,
  `agentCliTool(provider)(input)`, and a provider is a record of what
  differs: `{ name, label, threadNoun, claims, resumeId(input),
  prepare(input) → Effect<{ modelRef, launchedDetail, turn: (logger) =>
  Effect<TurnOutcome, Error> }> }` where `TurnOutcome = { response, usage,
  threadId, lines?, failure? }`. The shared code refuses the one-shot run,
  takes and closes the claim, registers the child, measures wall time, logs
  usage and builds both deliveries from `TurnOutcome` and the `runId` it
  minted. A failed-but-returned turn is `failure` on the outcome, so
  `isTurnError`, `turnErrorMessage` and the nullable pair of
  `errorDelivery` go. A provider writes its SDK stream and its options and
  nothing about claims, run ids or receipts.
- **Deleted:** `dispatchAgentCliTool`, `launchAgentCliSession`,
  `buildAgentCliTurn` as three exports (one stays); `AgentCliLaunchParams`
  and `AgentCliTurnParams`; `isTurnError`, `turnErrorMessage`, the
  unreachable default; `registerFailedMessage`, `summaryLabel`,
  `threadLabel`, `followUpLine` (derived from `label` and `threadNoun`);
  `buildCodexTurn` and `buildClaudeAgentTurn`; the `claim` parameter of
  `launchCodexSession`, `launchClaudeAgentSession`; the duplicated `Run:`
  line.
- **Size:** about 250 changed lines, net −90, in 3 files
  (`agentCliShared.ts`, `codex.ts`, `claudeAgent.ts`).
- **Risk / owner decision:** dropping the second run-id line changes the
  text a model reads in a tool result: owner decision for that one line.
  The rest is none; #14953 changes one schema line in `claudeAgent.ts` and
  does not conflict.

### TT-2: Which credential Claude Code will use is decided at launch and decided again, differently, by the availability check

- **Package:** texra
- **Flags:** repetition (a rule with two owners); a comment that is false
  (a status line that can be false)
- **Evidence:** the launch owns the precedence "OAuth > env API key >
  managed secret" in `buildClaudeAgentEnv`
  (`agentCli/claudeAgentConfig.ts:160-217`): `hasClaudeOauthCredential`
  (`:50-109`) reads `CLAUDE_CODE_OAUTH_TOKEN`, the credential file under
  `CLAUDE_CONFIG_DIR` and, on macOS, the keychain; when any is present the
  API key is removed from the child's environment (`:198-201`). The
  availability check re-derives the answer from different inputs
  (`agentCli/claudeAgentPlugin.ts:54-98`): it reads `apiKey(Secrets,
  'anthropic')` and the `CLAUDE_CODE_OAUTH_TOKEN` variable only, never the
  credential file or the keychain, and it does not apply the precedence. A
  user signed in with `claude login` who also has a key stored gets
  "Auth detected: ANTHROPIC_API_KEY (TeXRA Settings)." on the Plugins page
  (`:88-89,95`) while the launch strips that key and uses the login session.
  With no key and a login session the card says "No ANTHROPIC_API_KEY or
  CLAUDE_CODE_OAUTH_TOKEN detected: the CLI will use whatever `claude login`
  session you have" (`:96`), a guess where the launch has the fact.
  `hasClaudeOauthCredential` is file-local (2 refs, 1 file);
  `buildClaudeAgentEnv` has one production caller (`claudeAgent.ts:461`) and
  one test file. The probe also re-implements "an unreadable secret store is
  not an unset key" with its own `Config.String(anthropicApiKeyEnv)` read
  (`claudeAgentPlugin.ts:59-79`), which `buildClaudeAgentEnv` already orders
  correctly (the env key is checked before `Secrets` is touched, `:204`).
- **Better design:** `claudeAgentConfig.ts` exports one
  `claudeCodeAuth: Effect<{ kind: 'oauth-token' | 'login-session' | 'env-key'
  | 'managed-key' | 'none'; env }, SecretsFailed, …>`. The launch takes
  `env`; the availability check prints `kind`. The card then says what the
  next launch will do.
- **Deleted:** the probe's own key and token reads and its `authBits`
  assembly (`claudeAgentPlugin.ts:54-98`, about 45 lines), the
  `anthropicApiKeyEnv` module constant, the plugin's imports of `apiKey`,
  `Config`, `Option`, `Secrets`.
- **Size:** about 90 changed lines, net −35, in 2 files.
- **Risk / owner decision:** the card's status text changes (it starts
  naming a login session): user-visible wording, owner decision. On macOS
  the check would run the keychain probes (up to five `security` spawns of
  1 s each, `claudeAgentConfig.ts:85-104`) on each dashboard refresh; decide
  whether the card may pay that or reports `login-session` only from the
  file.

### TT-3: "Keep a found answer for the process, retry a miss, one probe at a time" is hand-written twice in `agentCli/`

- **Package:** texra
- **Flags:** a hand-written version of what Effect provides; shared mutable
  state; repetition
- **Evidence:**
  - `agentCli/vendorPackages.ts:248-270` `createCachedBinaryResolver`: a
    `SynchronizedRef.makeUnsafe` created at module load for each of its two
    callers (`claudeAgentImport.ts:90`, `codexImport.ts:136`; 3 production
    files, 0 test files), `modifyEffect` as the one-at-a-time lock, and a
    `catchDefect` that turns a thrown `which.sync` into a failure (`:268`).
    This is the remainder of **H10** (`2026-11-06-design-red-flags-round-2/H-app-tools.md:697-700`;
    the catalogue marks H10 `landed (#14786)`, which moved the arXiv limiter
    only; `2026-11-07-design-red-flags-lenses/general-special.md:697-699`
    lists the resolver as "known"). It is still in the tree.
  - New: `agentCli/codexConfig.ts:129-135,183-250` holds the same rule a
    second way: `CodexRouteEfforts`, a `Context.Reference` whose default is a
    mutable `Map` (a process singleton nothing ever provides: 3 refs, 1
    file), beside a module-level `codexRouteEffortLanes = new Map<string,
    PerKeyLane>()` (2 refs) and `withPerKeyLane` as the lock, with three
    hand-placed "do not cache" returns (`:197-213`, `:219-227`) and two
    hand-placed `set`s (`:215,228`).
  - Outside the slice the rule has a third copy,
    `packages/texra/src/utils/system/binaryResolver.ts:51-53,113-120`
    (`FoundTools`, a `Context.Reference` over an `LRUCache`, "A miss is not
    kept").
- **Better design:** one helper in `packages/texra/src/utils/system/`,
  `keepFound(lookup)`, over `Effect.cachedWithTTL` with the time to live
  computed from the `Exit` (hit: forever; miss or failure: zero). The repo
  already uses that form at
  `packages/harness/src/tools/pluginCatalog.ts:63`, and H verified it
  against 4.1.2 (`H-app-tools.md:848-851`). The keyed case
  (`codexRouteEfforts`, `findTool`) is the same helper per key held in one
  map the plugin's layer owns. A probe is then `lookup` and a statement of
  what counts as found.
- **Deleted:** `createCachedBinaryResolver`'s `SynchronizedRef` and
  `catchDefect`; `CodexRouteEfforts`, `codexRouteEffortLanes`, the
  `cached != null` read and the two `set`s in `probeRouteEfforts`; with the
  third site, `FoundTools` and its `LRUCache` import.
- **Size:** about 120 changed lines, net −40, in 3 files (4 with
  `binaryResolver.ts`).
- **Risk / owner decision:** none. The helper has three callers, so it is
  not a single-caller extraction. `LEAN-lake-lane-server-semaphore`
  (refused) is about `lakeCommands.ts` and is not reopened.

### TT-4: The setup tools state their allowlists twice and re-check what the offer already decided

- **Package:** texra
- **Flags:** repetition; special and general code mixed (a branch that
  cannot run); a comment that restates the code
- **Evidence:** four instances of one species in `setup/`.
  - (a) Allowlist as data and again as prose. `InvokeCommandTool.ts:12-37`
    lists 18 command ids in `LEAN4_SETUP_COMMANDS` and
    `SETUP_INVOKABLE_COMMANDS`; the tool description (`:99`) re-types 15 of
    them by hand (it omits `texra.openGettingStarted`, `texra.removeApiKey`
    and `texra.showMainView`, so the model is not told three commands it may
    invoke). `InstallVscodeExtensionTool.ts:22-25` builds
    `ALLOWED_EXTENSIONS` from two constants and the description (`:101`)
    spells `James-Yu.latex-workshop, leanprover.lean4` as literals.
    `ConfigTools.ts:53-55,144` shows the right form in the same directory:
    `ALLOWLIST_TEXT` is derived from the list.
  - (b) `ConfigTools.ts:34-41` names its six writable settings as stored-key
    strings (`'texra.bib.defaultPath'`, …) and looks each up in the catalog
    with a `throw` for a key that is not there (`catalogEntry`, `:45-51`).
    The rows themselves are exported constants
    (`packages/texra/src/shared/settings/texraSettings.ts:137`
    `BIB_DEFAULT_PATH_SETTING`, `:148` `ZOTERO_PORT_SETTING`, `:175`
    `TIKZ_INPUT_DIRECTORY_SETTING`, `:301` `GIT_COMMITS_TO_SHOW_SETTING`,
    `:313` `SOX_PATH_SETTING`), which `zotero/plugin.ts:18` and
    `registry.ts:117` already import. A renamed key fails at the first
    `update_config` call instead of at compile time.
  - (c) A tool offered only where its host capability is served checks for
    the capability again and words its own error:
    `InvokeCommandTool.ts:71-75,97` (`hostCapability: 'commands'`, then
    `if (!commands) … 'VS Code command invocation is unavailable in this
    host.'`), `SendToTerminalTool.ts:52-58,98`,
    `InstallVscodeExtensionTool.ts:50-55,99`. The second check exists
    because the service member is optional
    (`setup/platform.ts:57-76`) while the offer is decided from a separate
    list (`registry.ts:262-268`). **H9** (held by the owner with #14773)
    covers how the capability names are produced; it does not list these
    three in-tool branches, which its fix makes unreachable.
  - (d) `ApplyTeamTool.ts:40-45,62-70`: the schema refuses a `teamId`
    outside `TEAM_IDS`, then the body handles `result.status === 'unknown'`
    under a comment that says it "only fires if the enum and the preset list
    ever disagree"; both come from `TEAM_CHOICES` two lines apart
    (`:30-31`).
  - (e) `registry.ts:69-92`: a 24-line block comment in the middle of the
    import list restates each setup tool's one-line purpose, which each
    tool's `description` owns.
- **Better design:** (a) both descriptions join their list, as
  `ALLOWLIST_TEXT` does. (b) `UPDATABLE_SETTINGS` is a list of setting rows;
  the input literal is derived from their stored keys and `updateConfig`
  takes the row. (c) with H9: the capability's service is required where
  the tool is offered, so a tool reads it without a branch; until then,
  leave. (d) apply the team by preset (`applyTeam(preset, …)`), or delete
  the branch and let a mismatch be a defect.
- **Deleted:** two hand-typed allowlists in descriptions; `catalogEntry`
  and its `throw`; the `'unknown'` branch of `apply_team`; the registry's
  block comment; with H9, three "unavailable in this host" branches.
- **Size:** about 80 changed lines in 5 files.
- **Risk / owner decision:** (a) changes tool descriptions (three more
  commands named): prompt text, review as the resolved prompt. (c) waits on
  the owner's H9 decision. #14953 changes one schema line in two of these
  files.


### TT-5: How to install and sign in to a probed plugin's dependency is written up to five times per plugin, and the copies disagree

- **Package:** texra
- **Flags:** repetition (a fact with several owners); a comment or message
  that is false; special and general code mixed (prompt text for a state
  the model cannot be in)
- **Evidence:** a probed plugin's card has structured fields for the
  install and sign-in commands (`ToolPluginSetup.installCommand`,
  `authCommand`, `installUrl`; `registry.ts:118-130`), and the dashboard
  renders them as buttons beside the free-text `installGuide`,
  `configNotes`, `authNote` and the availability check's `statusDetail`
  in one card (`packages/texra/src/controllers/settingsView/ToolDashboardData.ts:139-183`,
  `packages/extension/src/settingsView/frontend/components/plugins/PluginCard.ts:285-305`).
  Each plugin restates the structured facts in the text fields:
  - Codex: `npm install -g @openai/codex` in the status message
    (`agentCli/codexPlugin.ts:39-41`), the guide (`:68`), the command
    (`:80`) and the tool description (`agentCli/codex.ts:442`); `codex
    login` in the guide (`codexPlugin.ts:74`), `authCommand` (`:83`),
    `configNotes` (`:86`) and the tool description (`codex.ts:443`).
  - Claude Code: `npm install -g @anthropic-ai/claude-code` in the status
    message (`agentCli/claudeAgentPlugin.ts:48-50`), guide (`:117`),
    command (`:132`) and tool description (`agentCli/claudeAgent.ts:425`);
    the three sign-in routes in guide (`claudeAgentPlugin.ts:122-126`),
    `configNotes` (`:137`), `authNote` (`:138`) and tool description
    (`claudeAgent.ts:426`).
  - Zotero: "Requires Better BibTeX" in the card description
    (`zotero/plugin.ts:93`), guide (`:96`), `configNotes` (`:106-107`)
    and three tool descriptions (`ZoteroSearchTool.ts:198`,
    `ZoteroCollectionsTool.ts:217`, `ZoteroExportTool.ts:84`). Wolfram:
    guide (`wolframPlugin.ts:26`) and `configNotes` (`:35`).
  - **They disagree on Windows.** `preferredInstallCommand` offers
    `winget` there because "a global npm install leaves only shell shims on
    Windows, which TeXRA cannot spawn" (`agentCli/availabilityProbes.ts:99-101,114-115`),
    and the binary lookup rejects those shims on purpose
    (`agentCli/vendorPackages.ts:218-233`). The not-found status the same
    card shows still says "Install via: npm install -g
    @anthropic-ai/claude-code" on every platform
    (`claudeAgentPlugin.ts:48-50`, with only a WSL suffix appended,
    `availabilityProbes.ts:23-25,85`), and so does the tool description.
    Following the status line on Windows leaves the binary "not found".
  - **The tool-description copies are unreachable.** A plugin with
    `availability` has "its tools withheld while the dependency is
    missing" (`packages/harness/src/tools/plugins.ts:117-121`), so the
    model sees `codex`, `claude_code` and the three Zotero tools only after
    the requirement those sentences state is met. (Zotero's tools are
    offered only when Better BibTeX answers: `available: bbt`,
    `zotero/plugin.ts:87`.)
  - `binaryNotFoundMessage` is an option of `probeSdkBinaryStatus`
    (`availabilityProbes.ts:48`) with two callers, each passing a sentence
    built from the package name that the same file's `installCommand`
    holds.
- **Better design:** the structured fields are the one owner. The
  not-found status is built by `probeSdkBinaryStatus` from the card's
  `installCommand` (the platform-picked one) and the plugin's name; the
  guide keeps only what has no field (alternative installers, which
  scopes or keys exist); `configNotes` keeps only facts no other field
  states (a switch's effect, polling caps); tool descriptions drop the
  install and requirement sentences. A plugin author then writes each
  command once.
- **Deleted:** the `binaryNotFoundMessage` option and its two sentences;
  the install and sign-in sentences in five tool descriptions
  (`codex.ts:442-443`, `claudeAgent.ts:425-426`, three Zotero tools); the
  repeated requirement and command lines in four `configNotes` and three
  guides.
- **Size:** about 60 changed lines, net −35, in 9 files.
- **Risk / owner decision:** **owner decision**: tool descriptions are
  prompt text (review as the resolved prompt) and the dashboard copy is
  user-visible. #14953 changes one schema line in `claudeAgent.ts`,
  `ZoteroSearchTool.ts` and `ZoteroExportTool.ts`, not the descriptions.

### TT-6: A polled GitHub list (request, since-cursor, ETag, seen ids) is held in two places and assembled by hand at six sites

- **Package:** texra
- **Flags:** repetition; information leakage (each poller knows how a
  list resource's cursor and ETag advance); a hand-written version of a
  rule another helper already owns
- **Evidence:** `readNewItems` (`github/poller.ts:273-308`) owns the
  seen-id set and the `since` cursor of a list (`SeenItems`, `:262-265`),
  but not the request or its ETag. Every list read rebuilds the rest:
  - six list reads: issue comments of an issue
    (`github/issuePoller.ts:48-55,78`), of a pull request
    (`github/pullPoller.ts:180-186,241`; the same endpoint and handling as
    the issue poller's), review comments and reviews of a pull request
    (`pullPoller.ts:188-200,243-249`), and a repository's issue and review
    comments (`github/repoPoller.ts:145-146,156-157,205-221`). Each writes
    the `per_page=100` URL, the `since` parameter from
    `prior?.X?.sinceCursor`, the ETag from `prior?.etags.X`, and stores
    `X: res.seen` and `etags.X` separately.
  - The ETag that should advance with the list is a second field set in
    two ways: `etagOf` (`pullPoller.ts:356-361`, 3 uses, one file) and an
    inline ternary in the issue poller (`issuePoller.ts:85-89`), each over
    a separate `etags` record (`pullPoller.ts:70-75`,
    `issuePoller.ts:36`).
  - The repository poller writes its own `since` closure instead of
    `withSince` (`repoPoller.ts:143-144`), because it needs the seed cursor
    as a fallback, then passes that seed again to `readNewItems`
    (`:208,219`): one fact applied in two places. It sends no ETag for any
    of its three lists (`:156-158`), so its fixed-URL pulls list
    (`:150`) costs a rate-limited request every minute where a conditional
    one would return 304.
  - `withSince` (`githubPaths.ts:11-15`, 2 consumers) and
    `getNewestTimestamp` (`:18-30`, 1 consumer, `poller.ts:306`) make up
    `githubPaths.ts`; both exist only for this assembly.
  - Consumers: `readNewItems` 4 production files, 1 test file
    (`packages/texra/test/tools/PollingSourceBase.vitest.ts`, which calls
    it directly); `SeenItems` 4 files; `etagOf` 1 file. The state is the
    in-memory value `pollTarget` keeps in a `Ref` (`poller.ts:93-97`), not
    a stored format.
- **Better design:** `poller.ts` owns a list resource:
  `pollList(path, schema, prior: ListCursor | undefined, { since?: true,
  seed? }) → Effect<{ cursor: ListCursor | undefined; fresh: T[] }>` with
  `ListCursor = { ids, since, etag }`. It adds `per_page` and `since`
  (falling back to `seed`), sends the ETag, reads new items and keeps the
  ETag of a 200. Each poller's state holds one `ListCursor` per list; the
  pull and issue pollers read issue comments through the same call.
- **Deleted:** `etagOf`; the issue poller's ETag ternary; the list members
  of the three `etags` records (`issueComments`, `reviewComments`,
  `reviews`, `comments`); the repository poller's `since` closure and its
  second seed; `githubPaths.ts` (its two functions become file-local in
  `poller.ts`); `SeenItems` as an export.
- **Size:** about 130 changed lines, net −45, in 6 files (one test).
- **Risk / owner decision:** none. The repository lists start sending
  ETags, which only saves rate budget.

### TT-7: The model and effort an agent CLI runs with is resolved once per provider over two exported halves, and its note is logged in two places

- **Package:** texra
- **Flags:** repetition; shallow module; single-caller extraction;
  temporal decomposition (select, then reason, at each caller)
- **Evidence:**
  - `agentCli/agentCliModel.ts` exports `selectAgentCliModel` (`:42-60`)
    and `agentCliReasoning` (`:66-87`), two steps every caller runs in
    order, plus `AgentCliModelRule` (`:27-33`). Each has two consumers,
    `claudeAgentShared.ts` and `codexConfig.ts`; 0 test files.
  - Each provider then writes the same procedure: read the model and
    effort settings, select, reason, return a provider-named record of
    `ref`, model id, `effort`, `note`: `readClaudeCodeRun` over the
    single-caller `claudeCodeRun` (`agentCli/claudeAgentShared.ts:95-140`;
    `claudeCodeRun` has 1 caller, `:130`) returning `ClaudeCodeRun`
    (`:66-75`), and `codexRun` (`agentCli/codexConfig.ts:82-118`)
    returning `CodexRun` (`:55-63`), the same five-field shape under
    another name.
  - The policy's note is logged at two different points: inside
    `readClaudeCodeRun` (`claudeAgentShared.ts:135-137`) and in the Codex
    thread constructor (`agentCli/codex.ts:385-387`), and each provider
    appends it again to its `launchedLine` (`codex.ts:498`,
    `claudeAgent.ts:509`).
  - Two hand-written type-equality helpers guard the same vocabulary
    against the two SDKs: `_AssertExact`/`_IsExact`
    (`claudeAgentShared.ts:46-55`) and `_AssertTrue`
    (`codexConfig.ts:39-42`).
- **Better design:** `agentCliModel.ts` exports one
  `agentCliRun(cli, stores, input?, routeEfforts?)` where `cli` is the
  rule plus its two setting rows and its log channel. It reads the
  settings, selects, chooses (asking `routeEfforts` for the route ceiling
  only when the first choice is above `high`, which is Codex's case), logs
  the note once and returns `{ config, effort, choice }`. Claude maps that
  to `thinking`, Codex to its backend slug. With TT-1 this is the
  provider record's `prepare`.
- **Deleted:** `selectAgentCliModel`, `agentCliReasoning` and
  `AgentCliModelRule` as exports; `claudeCodeRun`; `ClaudeCodeRun` and
  `CodexRun` as two interfaces; one of the two note-log sites; one of the
  two type-assertion helpers.
- **Size:** about 70 changed lines, net −35, in 4 files.
- **Risk / owner decision:** none.

### TT-8 (batched): Small items, each deleting what it names

- **Package:** texra
- **Flags:** silent degradation; an option for a special case; code for
  tests; repetition; a branch that cannot run
- **Evidence and fix:**
  - a. **arXiv download into an empty root.** `ArxivDownloadTool.ts:86`
    turns a session with no workspace into `workspaceRoot: ''`
    (`(yield* WorkspaceFs).root ?? ''`), and the processor joins its
    destination onto it (`packages/texra/src/latex/arxivProcessor.ts:444-446`),
    so the source lands relative to the process's current directory with
    no word to the agent; the VS Code command does the same
    (`packages/extension/src/commands/latex/arXivCommands.ts:100`). Fail
    with a `ToolError` when the session has no workspace. Both callers also
    pass `autoIndent` beside `formatter: autoIndent ? … : null`
    (`ArxivDownloadTool.ts:94-98`, `arXivCommands.ts:100-104`), two facts
    for one decision (`arxivProcessor.ts:105-110,455-459`): a `formatter`
    of `null` already says "do not indent". Delete `autoIndent` from
    `DownloadSourceOptions`. #14959 does not touch these files.
  - b. **`texraPlugins({ editors? })` falls back for tests only.**
    `registry.ts:352-359` makes the registry optional and builds a fresh
    one when absent; the one production caller always passes it
    (`packages/texra/src/controllers/texraProcessLayer.ts:83-84`). Six
    test call sites rely on the fallback
    (`src/test-kernel/controllers/session/goldenStore.vitest.ts:233`,
    `schemas/rowVersions.vitest.ts:73`,
    `agent/RunScopedToolOverlay.vitest.ts:107`, `support/texraApp.ts:23`,
    `tools/ToolCatalogNames.vitest.ts:23`,
    `tools/ToolAvailabilitySeeding.vitest.ts:31`). Make it required; the
    test support passes `makeEditorHost()`.
  - c. **`LatexFileResolution` restates its own field.**
    `latex/figureExtractionShared.ts:21-24,64,72` returns `{ path,
    display }` where `display` is `path.display`; its three callers
    destructure both. Return the resolution. `buildLimitedAttachments`'s
    `paths.length === 0 || limit <= 0` guard (`:85-87`) cannot run: the
    limits are the constants 20 and 12 (`ExtractFiguresTool.ts:29`,
    `ExtractTikzFiguresTool.ts:37`) and both callers return early on an
    empty list (`ExtractFiguresTool.ts:46-48`, `ExtractTikzFiguresTool.ts:78`).
    #14953 changes only `texPathField` in this file.
  - d. **`classifyImportError?` is an option for one provider.**
    `agentCli/availabilityProbes.ts:49,64` exists so Codex can relabel an
    import failure that says "Unsupported platform"
    (`agentCli/codexPlugin.ts:35-38`); the message already says it, under
    the generic label. Delete the option and the callback.
  - e. **TT-4(a)'s species once more.** `probe_environment`'s description
    hand-lists the probed LaTeX tools (`setup/ProbeEnvironmentTool.ts:328`)
    that `PROBED_LATEX_TOOLS` derives from the catalog
    (`packages/texra/src/shared/constants/latexToolchain.ts:449-452`);
    join the list, as the description already does for
    `IMAGE_TOOL_LABEL`.
- **Size:** about 60 changed lines in 12 files (6 of them tests, one line
  each).
- **Risk / owner decision:** (a) a no-workspace session's download now
  fails instead of writing outside any project: user-visible, owner
  decision. (e) is prompt text. The rest none.

---

## Good modules here

- `github/poller.ts` `pollTarget`: one fiber per target, state written once
  per successful poll, each GitHub failure tag mapped to one reaction, a
  defect ending only that target. The shape H2 asked for; TT-6 only moves
  the list bookkeeping into it.
- `agentCli/agentCliShared.ts` `StreamedToolCards`: one owner of the
  open-card lifecycle both SDK drivers share, with the fail-on-teardown
  rule stated once.
- `inquiry/inquiryActions.ts` `recordInquiryDecision`: the retried
  decision re-delivers from the record, keyed on the turn, so a repeat is
  a no-op by construction rather than by a flag.
- `editorHost.ts` `makeEditorHost`: one registry serves both the tools'
  service and the harness's `HostCapabilities`, so the offer and the
  implementation cannot drift.
- `arxiv/plugin.ts`: the rate limit as the plugin's process layer over
  `effect/persistence/RateLimiter`, the form H10 asked for.
- `zotero/plugin.ts` availability: an unreachable endpoint reads "not
  running" with the transport tag logged, so a fault stays distinguishable
  from an absent Zotero.
- `lean/leanTypes.ts` command tables and `lean/LspTools.ts`'s prose derived
  from them (also praised by round 2).
- `setup/ConfigTools.ts` `ALLOWLIST_TEXT`: the description joined from the
  list, the form TT-4(a) and TT-8(e) ask for elsewhere.

## Considered and left alone

- The icons and `terminalOutput` keyed by tool name on `TexraPlugin`
  (`registry.ts:150-156`): found by the general-special lens
  (`2026-11-07-design-red-flags-lenses/general-special.md:91-92`, GS1).
- The in-tool "capability unavailable" branches beside an offer gated on
  that capability, outside `setup/`: `comment/InlineCommentTool.ts:84-94`,
  `DiagnosticsTool.ts:97-103,144-150`, `OpenPdfTool.ts:54-55`. The same
  species as TT-4(c); they wait on **H9**, held by the owner.
- The `claude-agent` plugin id kept "for back-compat with persisted
  disabled-tool preferences" (`agentCli/claudeAgentPlugin.ts:34-37`): the
  same alias H9 names for `github-pr-subscription`; held with H9.
- The per-host temp-file strategy of the tool-edit diff
  (`approval/tempFileManager.ts`): refused, `RT-tool-edit-staging-one-owner`.
- `media/audio.ts` sits under `tools/` but is no tool (one consumer,
  `packages/texra/src/controllers/session/hostDraftRequests.ts`): a move,
  not a deletion.
- `new AbortController()` in `agentCli/claudeAgent.ts:164`: the lint
  rule's one permanent resident (`oxlint.config.mts:370-374`); the SDK
  takes a controller, not a signal.
- Codex's turn card (`agentCli/codex.ts:228-243`) and
  `ClaudeBackgroundTaskTracker` beside `StreamedToolCards`: their teardown
  differs (failed with a wall time, completed as "session ended"), so
  folding them in would add an option.
- `documents/`: covered by round 2's I-findings (landed) and HP-1
  (`RunFileService`'s document-task state); nothing new found.
- `lean/direct/`: H5 to H8 landed; `LEAN-lake-lane-server-semaphore`
  refused.
- The regex LaTeX scanning behind the extraction tools: open proposal
  `2026-11-14-unified-latex-for-latex-extraction.md`.
- `ExtractBibliographyTool.ts:96-107`'s filesystem chosen from `fsPath`'s
  spelling: HT-10.
- The agent-CLI cards' flat `tool.end` fields: open proposal
  `2026-11-14-tool-card-result-and-delivery-shapes.md` §1.

## Summary

| Id | Title | Package | Flags | Size | Owner decision? |
| -- | ----- | ------- | ----- | ---- | --------------- |
| TT-1 | An agent-CLI launch is three shared steps each provider calls in order, with the claim, name and strings threaded between | texra | temporal decomposition, pass-through variable, option for a special case, repetition | ~250 lines, 3 files | yes, one receipt line |
| TT-2 | Which credential Claude Code uses is decided at launch and again, differently, by the availability check | texra | repetition, false status line | ~90 lines, 2 files | yes, card wording and probe cost |
| TT-3 | "Keep a found answer, retry a miss, one probe at a time" hand-written twice in `agentCli/` (H10 remainder) | texra | hand-written Effect primitive, shared mutable state, repetition | ~120 lines, 3–4 files | no |
| TT-4 | Setup tools state allowlists twice and re-check what the offer decided | texra | repetition, special and general mixed, comment restating code | ~80 lines, 5 files | yes for (a) prompt text; (c) waits on H9 |
| TT-5 | Install and sign-in facts of a probed plugin written up to five times, disagreeing on Windows; tool descriptions state unreachable requirements | texra | repetition, false message, special and general mixed | ~60 lines, 9 files | yes, prompt and dashboard text |
| TT-6 | A polled GitHub list's request, cursor, ETag and seen ids held in two places and assembled at six sites | texra | repetition, information leakage | ~130 lines, 6 files | no |
| TT-7 | Agent-CLI model and effort resolved per provider over two exported halves; note logged in two places | texra | repetition, shallow module, single-caller extraction, temporal decomposition | ~70 lines, 4 files | no |
| TT-8 | Batched: arXiv download into an empty root, `autoIndent` beside `formatter`, a test-only `editors` fallback, a duplicated `display`, a one-provider option, one more hand-typed list | texra | silent degradation, option for a special case, code for tests, repetition, unreachable branch | ~60 lines, 12 files | yes for (a) behavior and (e) prompt text |
