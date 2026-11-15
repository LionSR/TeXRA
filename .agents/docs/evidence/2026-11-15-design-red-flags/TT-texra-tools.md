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
    `SETUP_INVOKABLE_COMMANDS`; the tool description (`:76`) re-types 15 of
    them by hand (it omits `texra.openGettingStarted`, `texra.removeApiKey`
    and `texra.showMainView`, so the model is not told three commands it may
    invoke). `InstallVscodeExtensionTool.ts:22-25` builds
    `ALLOWED_EXTENSIONS` from two constants and the description (`:102`)
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
    `InvokeCommandTool.ts:70-75` (`hostCapability: 'commands'`, then
    `if (!commands) … 'VS Code command invocation is unavailable in this
    host.'`), `SendToTerminalTool.ts:51-58,98`,
    `InstallVscodeExtensionTool.ts:50-55,100`. The second check exists
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

