# Single source of truth and one owner: the 2026-09-23 whole-architecture pass

Date: 2026-09-23
Status: proposed
Baseline: `main` at `bac10c1af1`.
Origin: a `find-simplification` pass with one charter: every fact has one
authoritative representation and one writer, no two mechanisms do one job,
and every piece of mutable state, lifecycle, registry and channel has one
named owner.

## Method

Eleven read-only mappers each covered one seam: session ledger, model
routing, tools and delegation, settings and config, platform and hosts,
persistence, host UI state, wire schemas, agents and resources, signals and
logging, and latex/controllers/workspace. Every mapper held the September
records as its do-not-redo list: the ten notes in this directory,
`config/ratchets/refuted-candidates.json`, the post-refactor survey, the
single-owner liveness, ownership-audit and current-value notes under
`../architecture/`, and the rulings ledger. Open ideation over the merged map
raised candidates. A shortlist pass deduplicated and ranked them into twelve.
Each of the twelve then went through three gates. A net-gain verifier came
first. Two independent refute-by-default skeptics followed: one re-counted
every claimed consumer, and the other checked the candidate against rulings,
persisted formats and headless parity. Sub-items that either skeptic refuted
are dropped from the filed records and listed in section 3. That keeps them
from being re-mined.

All twelve survived in part. Eleven are bounded deletions filed as
`tech-debt` issues. One changes user-visible behaviour and reverses recorded
rulings, so it is written out in section 2 for an owner decision.

## 1. Filed issues

| #   | Issue                                                     | One owner afterwards                                                                                                    | Net LoC (corrected)                                                             |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | ISSUE0 Provider-hosted-tool residue                       | the local `web_search` tool is the only web-search system; its row carries the query and nothing else                   | about -450 (the usage-field cut waits for the next `SESSION_EVENT_FORMAT` bump) |
| 2   | ISSUE1 One reader per cataloged setting                   | the settings catalog row is the only reader and the only vocabulary                                                     | about -130                                                                      |
| 3   | ISSUE2 Auth-plane forwarding shells                       | `invalidateRemoteAgentsAfterSignOut` and `SupabaseSessionCoordinator`; finishes #11389                                  | about -95                                                                       |
| 4   | ISSUE3 Wire vocabulary under second names                 | one name per shared wire type                                                                                           | about -30                                                                       |
| 5   | ISSUE4 `SupabaseSessionLog` port and desktop logger ports | the redacting log sink (child of #12886)                                                                                | about -80                                                                       |
| 6   | ISSUE5 CLI transcript ring duplicate-row guard            | the session fold and the local-notice counter own row-id uniqueness                                                     | see issue                                                                       |
| 7   | ISSUE6 Delegation, agent-index and session pass-throughs  | callers reach the owner directly                                                                                        | about -70                                                                       |
| 8   | ISSUE8 Write-only `Platform` singleton                    | the process runtime owns lifecycle, agent directories and the tool-missing reporter                                     | about -100                                                                      |
| 9   | ISSUE9 Storage forwarders                                 | the storage owners; `UpdateCheckRecords` stays under the 2026-09-22 current-value decision                              | about -70                                                                       |
| 10  | ISSUE10 One endpoint precedence ladder                    | `resolveRouteEndpoint`; subscription profiles return one effective config                                               | about -65                                                                       |
| 11  | ISSUE11 `run.stop` default policy (bug)                   | the `run.stop` arm resolves an unset `detachActiveChildren`; fixes progress-view Stop ignoring "Keep subagents running" | about -12                                                                       |

The issues hold the evidence (`path:line`, grepped consumer counts), the
exact symbols that stop existing, and the risk.

## 2. Needs an owner ruling: two AI agent-creation systems

The two skeptics split on this one. The consumer lens upheld an
extension-only retirement. The policy lens refuted the wider version:
desktop parity is false, because the creator agent's external roots are
registered only in the extension, and removing the wizard changes
user-visible behaviour. The candidate is therefore recorded here instead of
filed.

TeXRA has two ways to create an agent with AI. The first is the `texra.createAgentWithAI` wizard, which exists only in VS Code: a quick-pick for tool groups, then a single helper-model call through `runAgentCreator`, with a rendered-template fallback. The second is the bundled `creator` tool-use agent (`packages/extension/resources/tool_use_agents/creator.yaml`), a conversational agent that writes agent YAML with file tools. Each has its own taxonomy of the available tools: `TOOL_GROUPS` in the wizard and `tool_catalog.md` for the creator. Keeping both means two owners for one user action. Inside the extension the wizard could be removed and the command re-pointed to a `creator` run, which would leave the creator agent as the one owner. Removing it changes user-visible behaviour, though, and reverses two recorded rulings, so it needs an owner decision; it is not a mechanical deletion. Whatever the ruling, `tool_catalog.md` is drifting from the registry independently and should be fixed.

### Evidence

The wizard stack has one production consumer chain, and nothing else imports it (grepped at HEAD bac10c1af1):

- Settings view `packages/extension/src/settingsView/handlers/agentHandlers.ts:273` calls `texra.createAgentWithAI`. The command is registered at `packages/extension/src/commands/extensionCommandHandlers.ts:223` and bound at `packages/extension/src/commands/extensionCommandSurface.ts:143`. Its handler `handleCreateAgentWithAI` is imported only at `extensionCommandSurface.ts:11`.
- `packages/extension/src/commands/agent/agentCreatorCommands.ts` (312 lines) is the only production importer of `src/agent/implementations/agentCreator/agentCreatorFlow.ts` (534 lines: `runAgentCreator`, `buildCreatorConfig`, `CreatorConfig`, `CreatorTemplateFiles`, `TOOL_GROUPS`, `ToolGroup`, `AgentCreatorUI`), at `agentCreatorCommands.ts:15`. The test importers are `src/test-kernel/agent/AgentCreatorOrchestration.vitest.ts` (283) and `src/test-kernel/commands/AgentCreatorTemplateSchema.vitest.ts` (63).
- `validateAgentYamlContent` (`src/agent/runtime/agentLoad.ts:31`) has one production caller, `agentCreatorFlow.ts:13/:450`. Its test block is `src/test-kernel/agent/runtime/agentLoad.vitest.ts:73` to about `:123`.
- `promptToAddAgentToConfig` (`packages/extension/src/frontend/agents/register.ts:17`, 67-line file) has one consumer: `agentCreatorCommands.ts:17/:244`.
- The `@agent/templates` barrel (`src/agent/templates/index.ts`, 18 lines) has one importer: `agentCreatorCommands.ts:7`. It was introduced deliberately to replace the host deep import `@agent/templates/agentTemplateRenderer` (`index.ts:1-15`). So it can be deleted only together with the wizard; re-pointing that one importer to the deep path would widen `host-agent-import-baseline`.
- The templates `packages/extension/resources/templates/agentCreatorWorkflow.yaml` (120) and `agentCreatorToolUse.yaml` (64) are read only by `agentCreatorCommands.ts:46-47`. They are also listed at `packages/cli/scripts/validate-pack.mjs:18-19`.
- Ratchet rows: `config/ratchets/host-agent-import-baseline.json:18` (`@agent/implementations/agentCreator/agentCreatorFlow`), `:23` (`@agent/templates`) and `config/ratchets/file-size-baseline.json:62` (`agentCreatorFlow.ts: 534`). `knip-baseline.json` has no row for any of this.
- A replacement launch path already exists: `packages/extension/src/commands/latex/latexCommands.ts:86-97` dispatches `texra.execute` with `{ agent, agentCategory: AgentCategory.ToolUse, instruction }`.

Tool catalog drift, independent of the ruling:

- `packages/extension/resources/docs/agent-creation/tool_catalog.md:3` says it lists "Every tool available to tool-use agents". Eight user-facing registered tools have zero hits in the file: `ask_user_question`, `claude_code`, `codex`, `github_subscription`, `inline_comment`, `inquiry`, `open_pdf`, `report_review_issue`. About ten more registry tools are also absent (`probe_environment`, `verify_setup`, `apply_team`, `invoke_command`, `read_config`, `update_config`, `send_to_terminal`, `list_api_keys`/`unset_api_key`, `install_vscode_extension`), but these are setup-only and correctly left out.

### Proposal

The owner is asked to rule on option A. Option B stands on its own.

**A. Extension-only wizard retirement (needs an owner ruling).** Re-point `createAgentWithAI` inline in `extensionCommandSurface.ts` to `texra.execute` with `{ agent: 'creator', agentCategory: AgentCategory.ToolUse, instruction }`, following `latexCommands.ts:86-97`. The following would then no longer exist:

- `runAgentCreator`, `buildCreatorConfig`, `CreatorConfig`, `CreatorTemplateFiles`, `TOOL_GROUPS`, `ToolGroup`, `AgentCreatorUI` (file `agentCreatorFlow.ts` deleted)
- `handleCreateAgentWithAI` (file `agentCreatorCommands.ts` deleted)
- `promptToAddAgentToConfig` (file `frontend/agents/register.ts` deleted)
- the `@agent/templates` barrel (`src/agent/templates/index.ts`)
- `validateAgentYamlContent` and its test block
- `agentCreatorWorkflow.yaml`, `agentCreatorToolUse.yaml`, and their two entries in `validate-pack.mjs`
- `AgentCreatorOrchestration.vitest.ts` and `AgentCreatorTemplateSchema.vitest.ts`
- ratchet rows `host-agent-import-baseline.json:18`, `:23` and `file-size-baseline.json:62`, all of which shrink

Afterwards the `creator` tool-use agent is the one AI agent-creation owner in the extension, and `tool_catalog.md` is the one tool taxonomy it reads. `agentHandlers.ts:270-282` currently calls `refreshAfterAgentMutation` as soon as the command returns. A `texra.execute` launch resolves before the agent file exists, so that refresh must move to the existing agent-file watcher or be dropped.

**B. Doc drift fix (no ruling needed).** Add the eight missing user-facing tools to `tool_catalog.md`, keeping its delegation guidance.

### Refuted / out of scope

- **"One system on every host" and deleting the desktop refusal** (`packages/desktop/src/main/desktopAgentSettingsController.ts:495-507`). `creator.yaml:28-35` renders `BUILTIN_WORKFLOW_DIR`, `BUILTIN_TOOLUSE_DIR`, `CUSTOM_AGENTS_DIR` and `AGENT_DOCS_DIR` from `listExternalRoots()` (`src/agent/prompt/userVars.ts:272-288`, which defaults each to `''`). `registerExternalRoot` has production callers only in `packages/extension/src/frontend/setup.ts:48,57,66,70,111`. On the desktop and the CLI the directories are therefore empty and out-of-workspace writes are refused. This premise was already refuted in `.agents/docs/archived/simplification/2026-08-26-simplification-survey-round2.md:3742-3772`. The desktop refusal honestly records a real gap. Moving root registration into a host-neutral composition step is the unfiled prerequisite for cross-host parity; it adds code and is not part of this record.
- **A host-neutral creator run-request builder beside `setupLaunch.ts`.** Without desktop parity it has a single caller, and single-caller extractions are banned.
- **A `TOOL_CATALOG` prompt variable in `userVars.ts` with a `BUILTIN_TOOLS` relocation.** It adds a userVars key and a schema field to replace hand-written markdown, a first-sentence render loses the delegation guidance, and two taxonomy representations would remain.
- **Deleting the `@agent/templates` barrel on its own.** That widens `host-agent-import-baseline`. It goes only together with option A.
- **The drift size of "about 17 missing tools".** The real figure is 8. The rest are setup-only tools.

### Estimated delta

- Option A: about −1480 net LoC. That is 1461 lines across the eight deleted files, plus the `validateAgentYamlContent` definition (about 17) and its test block (about 50), 3 ratchet rows and 2 `validate-pack.mjs` lines, less about +15 for the inline `texra.execute` dispatch. Element delta: −8 files, −9 exported symbols (7 in `agentCreatorFlow.ts`, `handleCreateAgentWithAI`, `promptToAddAgentToConfig`), −1 exported function (`validateAgentYamlContent`), −1 barrel, −2 host→`@agent` specifiers, −1 file-size row, −1 parallel tool taxonomy (`TOOL_GROUPS`).
- Option B: about +8 lines of documentation.

### Risk

Option A is a user-visible behaviour change, and the shipped command keeps its name while its behaviour changes completely:

- The quick-pick tool-group wizard, which runs one helper-model call, becomes an open-ended conversation on a tool-capable model. The user needs a runnable non-helper model at launch.
- The rendered-template fallback is lost. This reverses the 2026-07-12 fallback-audit ruling "keep validated template" (`.agents/docs/archived/bug-fix/2026-07-12-fallback-audit.md:1448`).
- The "add to agent dropdown" prompt (`agentCreatorCommands.ts:244`) disappears.
- The `refreshAfterAgentMutation` call at `agentHandlers.ts:281` stops doing anything useful.
- It conflicts with the 2026-09-17 readiness reverify (`.agents/docs/implemented/simplification/2026-09-17-agent-sdk-readiness-reverify.md:164-172`) and manifest open item 1 (`.agents/docs/proposed/architecture/2026-09-10-agent-sdk-tier-1-manifest.md:293-295`). Both keep the `runAgentCreator` boundary open "correctly" pending a `HostInteractions` design. Deleting the wizard would close that item by removal rather than by design, and the owner should rule on that explicitly.

Recent commits on these files (#13013, #13008, #12975, #12946) are refactors, not product rulings on the wizard. Option B is low risk.

## 3. Refuted sub-items (do not re-mine)

These parts of the twelve candidates were refuted by at least one skeptic at
`bac10c1af1`:

- **Settings.** `goalFeatureFlag.ts` has no catalog row for `texra.goal.enabled`,
  so converting it adds a row. The `getPreferShortModelNames` and
  `responsesWebSocketSelected` reads take a `StateStore` only, and
  converting them spreads `SettingsStores` through the callers. The
  `SettingsModelSelectionController` and `latexdiffCommands` swaps are
  like-for-like. Warn-then-default does not satisfy fallback audit P1.6.
- **Auth.** A bare `yield* invalidateRemoteAgentsAfterSignOut()` drops the
  best-effort contract and would skip `_onDidChangeSessions.fire` on a
  defect. The header prose of `authFlowEffects.ts` is the only anchor for the
  "post-auth invalidation is a host boundary" ruling and has to move, not
  vanish. Inline `Pick`/`Omit` over the `Init` types nets zero. The
  `CodexSessionStatus`/`XaiSessionStatus` rename was refuted on 2026-08-25.
- **Wire vocabulary.** `SessionTypeSchema` is a deliberate canon-per-surface
  alias (#9816). `@common/errors` is a documented public surface, not a
  convenience barrel. A shared `CredentialOriginSchema` merges two domains
  for zero net elements. The `API_PROVIDERS` alias is a wash.
- **Logging.** Routing `appendDesktopLogLine` through `writeLogEntry` collides
  with synchronous-facades step 6. New module-level `createLog` constants run
  against that proposal's retirement of `createLog`. The desktop console
  mirror stays a second writer and belongs to that proposal. Its unredacted
  bytes are redacted on read.
- **UI folds.** `taskGroupDisplayStatus` is already one shared projection with
  three callers, and `sessionView.ts` D5 forbids a settled-groups rewrite.
  `UsageMonitor.lastSeenTotals` is the only source on the interrupt arm.
  `ToolRowModel.showOutput` renamed is churn (R5).
- **Pass-throughs.** `requireDelegationParent` was refuted in wave 8, because
  `requireToolRun` returns a `ToolRun`, not a `DelegationParent`.
- **Platform singleton.** The ESLint composition-root rule is the only lint
  pin on composition roots and stays. A CLI module-local `Lifecycle` would be
  a second handle. `AgentPackage.vitest.ts` does not pin the borrow rule.
- **Storage.** Deleting the `UpdateCheckRecords` tag reverses the accepted
  2026-09-22 current-value decision.
- **Model routing.** `getRuntimeModelConfig` is the D6 registry accessor, and
  direct `MODEL_CONFIGS` reads count as bypasses. `XAI_SUBSCRIPTION_ENDPOINT`
  is a separate fact by design. Deriving `PROVIDER_ROUTING_SETTINGS` from the
  registry and turning the `BASE_URLS` closures into rows are cosmetic.
- **Run control.** The approve-all sweep is host-kept under the 2026-09-09
  host-shared-controllers ruling. `focusedChildAcceptsFollowUps` is the
  stricter PRD 10.1 rule. `ExecutionsTool` keeps its own policy read because
  it needs `accepted()`.
- **Agent creation.** Desktop parity for the creator agent, a `TOOL_CATALOG`
  prompt variable, and deleting the `@agent/templates` barrel on its own,
  which would widen `host-agent-import-baseline`.
