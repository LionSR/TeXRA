# SSOT consolidation, part 2: the edge domains plan 1 does not own

Status: proposed
Date: 2026-08-04
Method: twelve-area read-only audit swarm against `main` @ `f4b7999f67`
(post-#9705, post-#9710), each area following 2–3 candidate facts across all
consumers before reporting.

#9705 ("one struct, one home, one wire" for run identity) and the companion
`2026-08-03-ssot-consolidation-plan.md` (plan 1) consolidated the core: run
classification, status lifecycle, usage folding, projection rails, host
sequence folds. This proposal is the audit of everything **outside** those two
documents' scope. The same disease — one fact, many vocabularies; re-derivation
by string parsing; transform middle-layers; render-time workarounds — is alive
at the edges, and several instances have already produced live bugs.

Plan 1's hard constraints (§0.1) apply verbatim here. In particular: no new
bus/router layers, no single-caller extractions, frozen wires stay frozen,
`.catch()` never on persisted data, per-host interaction registries stay.

## 0. Diff against plan 1 and the run-classification PRD

Items the audit surfaced that are **already owned** — do not re-file. This
proposal extends some of them; the extension is stated where it applies.

| Already-owned item                                   | Owner                           | This proposal's relation                                                               |
| ---------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| `roundStage`/`phaseStage` null↔undefined transforms  | plan 1 A2                       | **extended by L1** — A2 heals nullability; L1 adopts the #9710 `StreamStage` union     |
| `viaChatGptSubscription → usageRoute` transform ×2   | plan 1 A4                       | **extended by H4** — the audit found four copies plus a re-authored edge-function enum |
| Agent YAML double parse / two `inherits` walks       | plan 1 A7                       | untouched; H2's category authority fix must land on A7's single-parse end state        |
| `replayTrace` hand-copies                            | plan 1 C7                       | untouched                                                                              |
| `pendingDescriptions` race buffer                    | plan 1 C8                       | untouched (audit independently re-found it; correct ruling)                            |
| Phase appearance maps                                | plan 1 D1                       | untouched                                                                              |
| `statusBarDisplay` raw `MODEL_CONFIGS` branch        | plan 1 D6                       | **strengthened by G1** — D6's fix (read the registry) is insufficient; see G1          |
| Non-VS-Code unavailable-tools base list ×2           | plan 1 F11                      | **extended by N-table** — `inquiry` is double-declared in a second vocabulary too      |
| Group-status legacy readers (`data.status`)          | plan 1 A1 / #9627               | untouched; ride the 2026-10-31 retirement                                              |
| CLI dual state engine, session view-model            | run-classification PRD Part III | step 16 still live; untouched here                                                     |
| Run identity, lineage, `outcome` vs `terminalStatus` | #9705                           | excluded domain; not re-audited                                                        |

## 1. Workstream G — live bugs (wave 0, independent, no decisions needed)

Each of these is user-visible or data-corrupting **today**. They are small,
isolated fixes; land them before any structural workstream.

### G1. CLI status bar understates Kimi Code context pressure ~4×

`packages/cli/src/chat/tui/panes/statusBarDisplay.ts:173-185` re-derives the
effective context window from `MODEL_CONFIGS[model]`, special-casing only
`chatgpt-subscription`. A `kimi-code-subscription` turn runs under the
262 144-token coding-endpoint cap (`kimiCodeSubscriptionRouting.ts:120-142`),
but the gauge computes against the 1M registry window. Plan 1 D6 already orders
"CLI reads `getRuntimeModelConfig` everywhere" — **that fix does not cure this
bug**, because the registry window is exactly the wrong value for the
subscription route. The extension gets this right because the handler stamps
the effective window onto context-state events and `UsagePanel.ts:202` renders
it verbatim.

**Fix:** carry the handler-computed effective window on the usage/context wire
the CLI already subscribes to; delete `effectiveContextWindow`. Implement
together with D6, not after it.

### G2. GPT-5 tier reasoning cap: three implementations, drifted in three dimensions

The policy "included-access GPT-5 requests are capped per tier" lives in:

- `supabase/functions/relay/index.ts:140-143` + `reasoning.ts:20-55` — caps
  **only `xhigh`** (the enforcement authority).
- `src/controllers/modelAccess/installTexraModelAccess.ts:30-48` — caps
  **`xhigh` and `max`**.
- `src/controllers/settingsView/SettingsModelSelectionController.ts:274-289` —
  gates the badge on the model's **default** effort, not the requested one.

Plus two name-test vocabularies: `isGpt5Model` (relay, strips `provider/`
prefix) vs `isGpt5ModelName` (`src/model/modelNames.ts:8`). A user requesting
`max` passes the relay but is capped client-side; the badge misses models that
merely accept `xhigh` via override.

**Fix:** relay stays the enforcement authority (server copy is unavoidable).
Collapse the two client copies into one exported
`includedAccessReasoningCap(modelName, requestedEffort, tier)`; align the
client cap set with the relay's `xhigh`-only semantics (or deliberately widen
both); one shared `isGpt5` predicate family.

### G3. Three Monaco language tables, drifted in both directions

- `src/shared/monaco/monacoLoader.ts:229` — `monacoLanguageForPath` (switch).
- `packages/desktop/src/shared/desktopDiffMessages.ts:59-95` — record, missing
  `lean`, `bbl`, `toml`, `rs`, `go`, `c/cpp`, `mjs/cjs`, `jsonc` that the
  desktop editor table (same app!) maps.
- `packages/extension/src/progressView/frontend/components/monacoLanguage.ts:7-54`
  — no `tex/sty/cls/bib` entries at all: `.tex` tool-edit diffs render as
  `plaintext` despite the latex Monarch grammar being registered.

**Fix:** one exported table + `monacoLanguageForPath` in `@shared/monaco`
(parameterized with `languageForPath` for basename specials); delete the other
two tables.

### G4. Desktop Review recovers the file path by regex-stripping the diff title

`desktopDiffHost.ts:68` does `title.replace(/^Tool edit:\s*/, '')` on a title
authored at `desktopToolEditApproval.ts:120`, even though
`DesktopShowDiffMessage.displayPath`'s doc comment says "no fallback
reconstruction". Already broken: `desktopProgressFileActions.ts:80-84` passes
`Compare: <base> <-> <edited>`, so the Review workbench indexes that diff under
a bogus path. The extension's title format
(`VscodeToolEditApprovalHost.ts:199`) has also diverged from the regex.

**Fix:** pass the display path structurally into `openDiff` (or derive from
`proposed.filePath`); keep `title` as pure chrome; delete the regex.

### G5. `housekeeping/pack.ts` re-encodes legacy output stems with the raw model name

`pack.ts:274-281` builds `${base}_r${i}_${model}.xml` with the un-normalized
model, while the actual writer used `normalizeLegacyModel` (dots stripped).
`packAdditionalXmlFiles` silently misses legacy `.xml` outputs for any model
whose name contains a dot (`gpt-4.5` → on-disk `gpt45`). `housekeeping/utils.ts:45,67`
in the same directory goes through the SSOT and is correct. This is one
instance of the six-grammar problem in M1; fix the bug now via the M1 owner,
do not wait for the full consolidation.

**Fix:** build candidates via `legacyWorkflowOutputStem` /
`midEraWorkflowOutputStem` + `WORKFLOW_RAW_OUTPUT_EXT`.

### G6. `texra.memory.enabled` default: backend `true`, frontend signal `false`

`src/agent/features.ts:12` and `SettingsViewHost.ts:64-68` read default `true`;
`settingsState.ts:106` initializes `memoryEnabled = trackedSignal(() => false)`.
Before the backend snapshot lands, the Memory tab renders "off" for users who
have memory on — the exact first-paint flash the `DEFAULT_GIT_MARK_COMMITS`
comment (`stateSettings.ts:49-56`) was written to prevent.

**Fix:** extract `DEFAULT_MEMORY_ENABLED` beside the git defaults; reference
from all three sites. (Pattern instance of K1; fix this one now.)

### G7. Desktop recording flow double-posts `stopped` on transcription failure

`desktopAgentExecution.ts:986-1016` hand-reimplements the recording flow (its
comment admits the duplication) and posts `stopped` twice on rejection — the
exact behavior the extension's `acknowledgeStop` guard
(`RecordingManager.ts:58-65`) exists to prevent. The status union is declared
three times (`progressView/outbound.ts:269-275`,
`RecordingManager.ts:12-13`, `desktopAgentExecution.ts:542-550`) across two
wire vocabularies (one `UPDATE_RECORDING` command vs three main-view commands).

**Fix:** one shared `RecordingStatusSchema` + one host-neutral recording
controller emitting typed events; hosts adapt "post to my webview" only. The
double-post is fixed by deleting the desktop re-implementation, not by patching
it.

### G8. CLI human-facing text re-encodes `RunOutcome` through the retired `ExecutionStatus`

A cancelled run reads `stopped` in the CLI's own TUI/history labels but
`interrupted` at `terminalStatus.ts:38`, `workflowOutput.ts:242,257,293,340` —
user-visible two-vocabularies-one-fact drift, and it keeps the retired enum
alive as a display vocabulary. (Legitimate frozen-wire uses at
`traceAssembler.ts:55` and `history.ts:424` stay.)

**Fix:** route the three sites through `formatStreamStatusLabel(outcome,
{style:'cli'})`; annotate `runOutcomeToExecutionStatus` as wire/export-only.

## 2. Workstream H — `AgentCategory`: one vocabulary end-to-end

The same consolidation #9705 applied to run identity, one domain over. Today
the `'workflow' | 'toolUse'` fact has at least six shadow encodings, two
competing authorities, and a silent-default bug on the launch wire.

### H1. Launch wire re-encodes the enum as a boolean, and picker wire as five booleans

- `src/shared/schemas/mainView/state.ts:23` — `SessionTypeSchema` re-spells the
  enum's values with no schema tie.
- `executionFormState.ts:34-40` degrades it to `isToolUseAgent: boolean`;
  `executeMessage.ts:43` puts the **optional** boolean on the wire — any sender
  omitting it silently launches as workflow (`MainViewExecutionController.ts:41`
  re-derives the enum back).
- `agentOptionsBuilder.ts:18-27` flattens category+source into
  `isToolUse/isOrchestrator/isRemote/isCustom/isInline`, all optional
  (`state.ts:103-109`); `isToolUse` duplicates `category`, and
  `isRemote/isCustom/isInline` are a lossy re-encoding of `source` — a fifth
  source value silently renders no badge. The settings view already does this
  correctly (`AgentSelectionItemSchema`, `settingsView/data.ts:162-168`).

**Fix:** `agentCategory: AgentCategorySchema` on `MainViewExecuteMessage` (and
`category`+`source` beside `isOrchestrator` on `AgentOptionDataSchema`);
delete the boolean, `SessionTypeSchema`'s literal list, and the four derived
booleans; renderers derive badges.

### H2. Category dual authority: YAML field vs directory source, four reconciliation rules

- `agentYamlScanner.ts:206-210` — OR rule (source wins).
- `agentLoad.ts:94-101` — injects only when omitted (YAML wins).
- `inlineAgents.ts:143-147` — absent ⇒ workflow.
- `remoteAgentMeta.ts:53-60` — DB column re-mapped through `isToolUse` even
  though the enum was already validated.

For a YAML in `tool_use_agents/` declaring `agentCategory: workflow`, the
registry says `toolUse` while the loaded settings parse as `workflow` —
rosters and launch resolution would classify differently from the runtime.
Latent: no bundled YAML trips it today, and nothing validates the conflict.
All 24 bundled YAMLs declare the field.

**Fix:** the declared field is authoritative; one shared
`categoryForDefinition(settings, source)` normalizer used by scanner and
loader; warn-or-reject on directory/declaration conflict. Land on top of plan
1 A7's single-parse end state, not beside it.

### H3. Shadow declarations and display labels

- `agentCreatorFlow.ts:29` exports a second `AgentCategory` type — same name,
  same values, imported by `agentCreatorCommands.ts:8`.
- Literal-union parameters at `frontend/agents/register.ts:29` and
  `settingsView/handlers/agentHandlers.ts:426`.
- Display labels: shared map exists (`icons.ts:95-96`), longer form exists
  (`proposalFields.ts:67-73`), yet three hosts inline
  `category === 'toolUse' ? 'Tool Use' : 'Workflow'` (`agentCreatorFlow.ts:382`,
  `agentHandlers.ts:432`, `desktopAgentSettingsController.ts:391`) — and the
  wording has forked (`'Tool Use'` vs `'tool-use agent'`).

**Fix:** delete the shadow type; retype the parameters; one
`agentCategoryDisplayLabel(category)` in the shared layer consumed everywhere;
the proposal-fields longer form composes from it.

### H4. `UsageRoute`: extend plan 1 A4 to all four copies, plus the display vocabularies

A4 owns the `usage.ts`/`streamData.ts` pair. The audit found two more
derivations of the same legacy boolean (`src/agent/types/NormalizedUsage.ts:55-62`,
and a **re-authored** `UsageRouteSchema` enum + derivation in
`supabase/functions/log-usage/usageValidation.ts:13-18,47-54`), plus per-host
display vocabularies: `UsagePanel.ts:56-85` switch, the CLI's second 4-value
`CliModelAccessRoute` re-encoding with two more label tables
(`modelAccessRoute.ts:120-160`), and a third switch in the edge function.
Wording has drifted ('Included TeXRA access' vs 'relay').

**Fix:** A4's single exported transform, called from all three repo schemas;
the edge function gets a vendored copy of the enum with a wire-contract
comment (or stops accepting the legacy boolean when the window closes —
`usage.ts:44-55` currently carries **no date or retirement note**, violating
the repo's compat-annotation rule; add one). One shared
`UsageRoute → {label, title, subscription}` display table; the CLI derives
retrospective arms from `UsageRoute` directly.

### H5. "Is an orchestrator root": name lists + fabricated catalog entries

`src/shared/constants/agents.ts:10-27` hard-codes orchestrator name lists as a
parallel vocabulary to the delegation-tool scan (`hasDelegationTool`,
`delegationTools.ts:45`); `TeamPlan.ts:493-514` intersects both;
`SettingsAgentCatalogController.ts:240-269` fabricates catalog rows with
`tools: ['delegate_agent']` and a knowingly false `source: 'builtInToolUse'`
(two of three named roots are relay-served) purely to make `hasDelegationTool`
return true; `:89-95` unions the two vocabularies in a third reconciliation.
This is the fabricated-registry-row pattern #9705 deleted.

**Fix:** the resolved tool list is the single authority; where the catalog is
not loaded, carry a `{name, delegationCapable: true}` hint struct through the
preview planner instead of forging entries.

## 3. Workstream I — tool-call display inputs: parse once, render the struct

The display-relevant shape of tool inputs is re-derived by string-sniffing in
every display host, because the runtime tool schemas are host-only. AGENTS.md
already records this bug class (the memory-tool `path` incident).

- `toolSections.ts:197-258` re-derives the memory tool's 8-command union with
  raw `command ===` branches and per-field `typeof` guards, re-implementing the
  `insert_text ?? new_str` alias at `:238`; its comment admits the
  re-derivation.
- `toolSections.ts:94-139` documents that three edit tools have "no single
  canonical schema" for display; `DiffView.tsx:66-118` sniffs
  `old_string|old_str` / `path|file_path` in the CLI;
  `toolRenderers.tsx:189-202` re-classifies edit tools by name-substring beyond
  `toolDisplayKind`.
- Same pipeline, second discipline violation: raw vs normalized tool-name
  keying mixed inside `formatToolUseTemplate` — sections, timeouts, and
  language maps key off raw `ctx.toolName` (`toolSections.ts:633-653`,
  `helpers.ts:75,80,167`) while icon/kind use `normalizeToolName`; a
  namespaced `claude:Edit` gets half the display rules.

Related root cause in the delegation path: `ToolUseDispatchNode.ts:500-506`
persists the **raw model input** (shorthand vocabulary), so
`proposalInput.ts:60-72` must hand-mirror the shorthand→`toolConfig` mapping
the runtime already applied at `DelegationTools.ts:158-162`, and
`DELEGATION_TOOL_CATEGORY` (`shared/constants/delegationTools.ts:30-34`) exists
as an unguarded second name→category map to route the re-parse.

**Fix:** browser-safe display-input schemas per display concern in
`src/shared/schemas/`; compose the runtime tool input schemas from those
leaves; renderers `safeParse` once and switch on the discriminant. Persist the
canonical proposal (or resolved `toolConfig`) on the tool-use log entry;
delete `extractionShorthandToolConfig` and `DELEGATION_TOOL_CATEGORY`.
Normalize the tool name once at the top of `formatToolUseTemplate` and pass
only the canonical key inward. The CLI's external-variant sniffing (Claude
Code names) is a true external boundary — keep it, but normalize into the same
display struct once.

## 4. Workstream J — model policy: one predicate per fact

- **Reasoning-level override predicate ×2, byte-identical** —
  `ModelHandler.ts:770-776` vs `SettingsModelSelectionController.ts:292-298`
  (including the DeepSeek disjunct; the `#7101` triage comment lives on only
  one copy). Export `supportsReasoningLevelOverride(config)` from
  `reasoningEffort.ts`; both consume.
- **Claude adaptive thinking by prefix-sniffing** —
  `claudeAgentShared.ts:44-50` prefix-matches `claude-opus-/sonnet-/fable-` to
  re-derive what llm-zoo already declares (`supportsAdaptiveThinking`);
  `ClaudeAgentModelSchema` (`agentCliSettings.ts:67-72`) is a hand-maintained
  subset of the registry catalog. Resolve through llm-zoo; prefix fallback only
  for unrecognized ids (the SDK accepts arbitrary ones).
- **`effectiveRounds` re-derived ×4, remote agents never get it** —
  `agentYamlScanner.ts:178-181`, `inlineAgents.ts:172-179` (throws where the
  scanner warns), `runReflectionFlow.ts:147-155` (hand-copies the branch logic
  and re-spells `.prefault(2)` as `?? 2`), `userVars.ts:552-564`; remote
  entries leave `rounds` permanently absent
  (`remoteAgentMeta.ts:52-66`) while the CLI renders planned rounds from it.
  One exported `effectiveRounds(setting, prompt)`; all four consume; remote
  entries compute it once their YAML loads.
- **Remote agent tool metadata cached in three places** — DB `tools` column,
  globalState `REMOTE_AGENT_META_CACHE`, merge rule `dbTools ?? cached?.tools`
  with independent refresh triggers; the roster can show a stale tool list
  indefinitely. Keep one cache or stamp both with the YAML revision.

## 5. Workstream K — settings catalog: finish the migration

The `STATE_SETTINGS` catalog + `readPlatformSetting` is the intended SSOT (the
git defaults and the CLI `/config` panel are the exemplars). The migration is
half-done; every finding here is the same shape: the catalog owns the fact, a
pre-catalog read path restates it.

- **K1. Provider region/routing defaults: 4–5 vocabularies, two divergent read
  paths.** `providers.ts:105-152` registry `region.default`, `providers.ts:315-356`
  `defaultValue` restatements (with "false" spelled as absence), catalog
  `.prefault()` literals, `providerConfig.ts:127-141` `?? true/false`
  fallbacks — and the UI reads via `globalState.get(key, def.defaultValue ??
false)` (`SettingsProfileController.ts:208-215`) while the runtime reads via
  `readPlatformSetting`. Drift shows the user one value and the model handler
  another. Build the routing settings from the registry; resolve UI defaults
  via `stateSettingByKey`.
- **K2. Config-backed core-setting defaults restated as literals at ~12 read
  sites** — `getConfig('texra.bib.zoteroPort', 23119)`,
  `getConfig('texra.maxImageDimension', 2000)`,
  `useBackgroundResponses` default `true` in **five** places (including two
  `PROVIDER_SETTINGS` rows with divergent descriptions for the same key), etc.
  Route through `getValidatedConfig(path, leaf, getCoreSettingDefault(path))`;
  delete `defaultValue` from config-backed `PROVIDER_SETTINGS` entries; merge
  the duplicate `useBackgroundResponses` rows.
- **K3. State-backed defaults bypassing the catalog** —
  `allowOrchestratorKill`/`detachSubagentsOnStop`/`streaming.global` restated
  in handlers, tools, and frontend signals; frontend placeholder signals
  contradicting schema defaults (G6 is the live instance). Extend the
  named-const pattern; add the missing catalog rows.
- **K4. Settings-tab copy drift.** The catalog comment promises tabs read
  labels/descriptions from the rows; five pairs have already diverged
  (`'Mark agent commits'` vs `'Mark TeXRA commits'`, etc.). Either drive tab
  toggles from `settingsViewSettingByKey(key).title/description`, or declare
  the catalog prose CLI-only and delete the promise from the comment.
- **K5. LaTeX field→key map ×2** — `REPLACEMENT_CONFIG_FIELDS`
  (`LatexConfigPersistenceController.ts:18-24`) vs `LATEX_CONFIG_FIELD_TO_KEY`
  (`LaTeXTab.ts:130-137`); nothing type-links the key strings. Export one
  combined map from `@shared/constants/latex`.

## 6. Workstream L — progress view: adopt the post-#9710 shapes

- **L1. `StreamStage` end-to-end (extends A2).** #9710 created the canonical
  `StreamStage` union ("consumers hold one `stage` field rather than two
  independently-optional ones") and the CLI adopted it; the entire
  progress-view stack still threads the pair: declared twice in
  `streamState.ts:120-131`, again in `outbound.ts:294-295`, split back into two
  update handlers at `ProgressFactApplier.ts:158-165`, healed per-field in two
  merge transforms, and re-singularized by a hand-coded "phase first" fallback
  with a parallel label table in `progressBadgeFormatter.ts:18-77`. Mutual
  exclusion is unenforced. Store `stage: StreamStage | null` end-to-end;
  renderers call `formatStageLabel`; delete the shims and fallbacks. Do A2's
  nullability heal **as part of** this, not as a separate intermediate state.
- **L2. Two wire encodings of the same four backend-owned facts.**
  `StreamMetadataSchema` (`streamState.ts:113-136`) vs `activeState`
  (`outbound.ts:291-300`) — same source (`StreamExecutionState`), two
  projections (`WebviewUpdater.ts:395-423`, `ProgressFactApplier.ts:694-704`),
  two frontend merge transforms; the `badges` wrapper and the
  optional-vs-nullable distinction exist for no structural reason. One
  `StreamMetadata`-shaped struct built once by `buildStreamMetadata`; delete
  `toActiveStreamContentSync` and one merge transform. (Plan 1 §0.1.8
  sanctions the snapshot+targeted dual path — this item unifies the **shape**,
  not the paths.)
- **L3. Exhaustion-reason verdicts bypass their SSOT predicate.**
  `isChatGptSubscriptionLimitError` (`shared/schemas/errors.ts:181-189`,
  "the predicate stays the one place that owns the verdict") is used only by
  the CLI; five sites branch on raw strings
  (`ProgressApiKeyRetryController.ts:130-144`, `eventHandlers.ts:329`,
  `RetryRequestPanel.ts:70`, `ProgressViewMessageHandler.ts:276`), with the
  chatgpt→openai fallback mapping hardcoded inline. Add the Copilot
  counterpart; route all five through the predicates; move the
  fallback-provider mapping beside them.
- **L4. Streaming-entry liveness: one writer, three divergent readers, no
  schema.** `isRunningStreamingTextEntry` (`StreamLog.ts:41-46`, canonical) is
  re-implemented in `baseLogFormatter.ts:22-37` and in the CLI
  (`subscribeStreamLog.ts:208-214`, with divergent no-status fallback semantics
  and no message-type gate). The payload is an unschema'd bare string. One
  browser-safe `isStreamingTextRunning(messageType, data)` in
  `@shared/schemas/log.ts` (primitives in, so the extension's wire type can
  use it); consider a small `StreamingTextDataSchema`. Distinct from plan 1 A1
  (which covers legacy **group** rows riding the #9627 retirement — this
  vocabulary is current, with no death date).
- **L5. Stage-kind vocabulary ×5.** `'run'|'round'|'phase'|'session'` declared
  inline at `trace/events.ts:82`, `AgentTrace.ts:35`, `shared/streams/stage.ts:17`,
  a module-local zod enum (`taskGroup.ts:6`), and re-authored as raw strings in
  `NESTED_STAGE_KINDS` (`replayTrace.ts:43`). Adding a kind compiles everywhere
  while `GroupLogPayloadSchema.kind`'s `.catch(undefined)` drops it and the
  trace-viewer's exclusion set misidentifies it. Export one enum; derive
  `NESTED_STAGE_KINDS` as "all kinds except `'run'`".

## 7. Workstream M — naming grammars with one owner

- **M1. Legacy/mid-era `_r{N}` output-filename grammar: six parsers/encoders.**
  `mergeFileUtils.ts:11-15,25-29,46-60` (three regexes),
  `fileListingRules.ts:185-211` (end-anchored variant, comment admits no owner
  covers it), `fileMapping.ts:40,50` (`split('_r')[0]` — breaks on bases
  containing `_r`), `pack.ts:274-281` (the G5 live bug). Owner exists and says
  so: `src/shared/constants/workflowOutput.ts`. Consolidate all token parsing
  there; keep the 2027-04-21 retirement window with one reader. (Also fixes
  the `src/latex/` → `@agent/utils` layering inversion for filename parsing.)
- **M2. "Is a latexdiff artifact" classified three ways** —
  `diffFileNameManager.ts:105-139` (owner, end-anchored, careful) vs
  `diffOperations.ts:247` (`includes('_diff')` substring) vs the generic
  `'_diff'` ignored-keyword (`fileHandlingRules.ts:85`, substring in listing —
  silently excludes user files like `chapter_diff.tex`). Route the first
  through the owner; decide and document the listing filter's looser semantics.
- **M3. `/executions/{id}/files/{path}` virtual grammar: four template-literal
  writers, two split-based parsers** (`ProgressFollowUpController.ts:505-508`,
  `subagentResults.ts:59`, `ExecutionsTool.ts:1089`, `summaryFormat.ts:170`;
  parsers `executionsDisplay.ts:19-31`, `ExecutionsTool.ts:399-401`). One
  builder/parser pair exported from a shared module.
- **M4. File-category vocabulary in 3+ places** — hand-authored
  `ExtensionCategory` union (`fileTypeUtils.ts:12-13`, bridged to the zod enum
  only by an `as` cast; includes a dead `'audio'` arm; its doc comment points
  at a deleted type), `MAIN_VIEW_ATTACHABLE_DROP_CATEGORIES` re-listing,
  `['bib','bbl','cls','sty']` hardcoding `context − input`
  (`MainViewDroppedFilesController.ts:100`), per-host category→command maps
  (`fileSelectionRegistry.ts:24-56` vs `desktopFileSelection.ts:44-59` — three
  identical entries). Derive the context-only set from `FILE_HANDLING_RULES`;
  `satisfies`-check the union against the zod enum; share the command map in a
  controller-layer module.

## 8. Workstream N — small duplications batch (mechanical, one PR or opportunistic folds)

| #   | Fact                                                      | Sites (authoritative → copies)                                                                                                                                                        | Fix                                                                               |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| N1  | Standard file+shell toolset                               | — → `ToolDashboardData.ts:81` (typed), `agentCreatorFlow.ts:62-66`, `agentTemplateRenderer.ts:34-43` (both plain strings; descriptions already drifted)                               | one `DEFAULT_CORE_TOOL_NAMES` export; three consumers                             |
| N2  | `inquiry` CLI-unavailability (extends F11)                | — → `hideFromCli: true` (`externalToolDefs.ts:526-529`, listing-only) vs hardcoded in `CLI_UNAVAILABLE_TOOLS` (`unavailableTools.ts:30-31`, runtime)                                  | runtime list derives from the defs flag                                           |
| N3  | Workflow journal `result` typed `unknown`                 | should be validated once → `workflowScriptRun.ts:67-75` (throws) vs `workflowScriptDeliverySummary.ts:56-73` (silently skips) — same corrupt data, divergent policy                   | parse into `AgentFinalResult` at the journal boundary; one shared legacy policy   |
| N4  | Delivery-summary parallel state machine                   | canonical fold `workflowScriptRun.ts:312-424` → second fold + third status vocabulary `workflowScriptDeliverySummary.ts:45,79-98,111-113`                                             | hand the collector the projected `WorkflowCallProgress` records                   |
| N5  | `<workflow-summary>` tag literal                          | `deliveryTags.ts` registry → literal minted at `workflowScriptDeliverySummary.ts:121`, re-declared at `subagentFollowup.ts:217`                                                       | add to `DELIVERY_TAG`; reference both sides                                       |
| N6  | Journal key shape (16 hex)                                | minter `runWorkflowScript.ts:38-56` → regex re-declared `persistence.ts:33`                                                                                                           | export the key producer/schema; reference from persistence                        |
| N7  | Codex synthetic tool names                                | `CODEX_*_TOOL` consts (`codex.ts:16-19`) → re-spelled in `toolDisplayName.ts:23-26`, `formatters/constants.ts:193-196`                                                                | key both maps off the constants                                                   |
| N8  | `CLI_HISTORY_RESUMABLE_STATUS`                            | `HISTORY_RUN_STATUS.RESUMABLE` (same module already imported; add the named import) → literal `history.ts:101` + 3 consumers                                                          | delete the constant                                                               |
| N9  | `OutputFileSummary.location` flatten→rehydrate            | `FileLocation` struct → string enum losing `executionId` (`output.ts:91-99,189-199`) → hand rehydration (`desktopAgentLaunch.ts:54-73`, non-exhaustive)                               | helper returns a ready `FileLocation`; desktop emits verbatim                     |
| N10 | `WORK_TYPES` onboarding taxonomy                          | `AGENT_MODE_PRESETS` owns id/name/description/icon → five re-authored rows (`desktopOnboarding.ts:54-90`), silently drops unlisted presets                                            | extend preset schema with onboarding phrasing; panel becomes a projection         |
| N11 | Polish-failure wire message ×3                            | controller owns `createPolishErrorUpdate` + `failed` arm → hand-built copies `ProgressViewMessageHandler.ts:776-790`, `desktopAgentExecution.ts:918-933` (toast/log policy diverging) | route both hosts through the controller's `failed` arm                            |
| N12 | Paste pipeline (clipboard → named base64 + chip text)     | shared naming/persist half exists → extraction+chip half forked (`pasteHandler.ts:27-53` vs `FollowUpInput.ts:325-380`)                                                               | extract the shared browser-safe routine; each view keeps only its send/stash step |
| N13 | Pasted-image wire payload `{base64, mediaType, fileName}` | — → inline `z.object` ×2 (`mainView/inbound.ts:191-196`, `progressView/inbound.ts:116-124`)                                                                                           | one `PastedImageFieldsSchema`, spread at both sites                               |
| N14 | Env-var-shadows-secret policy                             | — → triplicated `process.env[key]` precedence (`electronSecrets.ts:69-73`, `vscodeSecrets.ts:19-23`, `cliSecrets.ts:34`; vscode comment says "matching" the others)                   | one `envOverridingSecrets(inner, env)` wrapper in `@platform/defaults`            |
| N15 | Desktop log line format                                   | writer `desktopAppLog.ts:121` ↔ regex reader `logsPane.ts:66-67`, no shared constant                                                                                                  | emit JSON-lines, or export the format/regex pair from one module                  |
| N16 | Workbench tab-id scheme                                   | private builder `desktopTaskShell.ts:166-169` → hand-built at `renderer/main.ts:351,1469` (silent no-op risk)                                                                         | export the builder; use at both sites                                             |
| N17 | `source:name` agent-key parse                             | `agentKey`/`agentName` helpers exist → third slice-arithmetic parser `cli/runtime/agents.ts:116-121`                                                                                  | add `parseAgentKey` next to `agentKey`; one consumer                              |
| N18 | Undated legacy transform                                  | repo rule: date + retirement note on every compat reader → `usage.ts:44-55` has none (introduced 2026-07-04, retirable ≥2026-10-04)                                                   | annotate now; delete with H4's window                                             |

## 9. What the audit found clean (do not "fix")

Pricing (one formula per billing model), provider registry (all lists derived),
subscription eligibility flags, vision/media capability reads, IPC command
literals and schema-driven dispatch, checkpoint/journal identity and KV-key
ownership, delegation availability injection, pasted-image naming/validation,
file-listing rules SSOT, run-storage disk layout, media classification, trace
export pipeline (one path, both hosts), the trace-viewer's layering, desktop's
reuse of shared controllers, CLI formatting (`@utils/text` throughout),
`knownKeys.ts` derivation, tool display-kind/icon/preview SSOT with its
registry guard, MCP prefix parsing (one site). The post-#9705 backbone is
sound; this proposal deliberately contains no core-layer restructuring.

## 10. Execution order

- **Wave 0 (now, independent):** G1–G8 (live bugs), plus N18's annotation. G5
  lands through the M1 owner; G6 through the K-pattern; neither waits for its
  workstream.
- **Wave 1 (small, high-yield):** H3, H4 (with A4), J, L4, L5, N-table rows
  N1–N8. Mostly export-one/delete-two edits with compile-time guards.
- **Wave 2 (structural, independent of each other):** H1+H2 (AgentCategory —
  sequence after plan 1 A7), I (display-input schemas; biggest blast radius,
  highest drift payoff), K (settings catalog completion), L1+L2 (progress-view
  shapes — fold A2 in), M1–M4.
- **Wave 3:** L3, H5, N9–N17, and the reconciliation pass: every deletion here
  that removes a compat arm gets a #6981 ledger row; anything touching plan 1
  items updates that plan's ledger too.

## 11. Decisions needed from the owner

1. **G2 cap semantics**: relay enforces `xhigh`-only; client caps `xhigh`+`max`.
   Which is the policy? (The badge/copy implies the client is the intended one.)
2. **H2 authority**: declared `agentCategory` field authoritative (recommended —
   all 24 bundled YAMLs declare it) vs directory source. Conflict handling:
   warn or reject?
3. **K4 copy authority**: catalog prose drives all hosts' labels, or catalog is
   CLI-only and the settingsView keeps its own copy (then delete the catalog's
   promise comment).
4. **M2 listing filter**: does the `'_diff'` ignored-keyword keep its looser
   substring semantics (user-facing exclusion rule) or adopt the owner's
   end-anchored grammar?
5. **I scope**: display-input schemas for the memory + edit + write tools first
   (the sniffed ones), delegating the long tail to later PRs — or one full
   sweep?
6. **H4 edge function**: vendored enum copy with wire-contract comment, or stop
   accepting the legacy boolean at the 2026-10-04 window close?

## 12. How this goes wrong (pre-mortem, brief)

- **Double-homing during migration.** Every workstream here creates a temporary
  second home. Plan 1 §10.18's rule applies: a PR either finishes its fold or
  doesn't land; no half-migrated plateaus (§10.11).
- **Behavior changes smuggled inside refactors.** G7, L1, and N3 change
  observable behavior (double-post, badge precedence, throw-vs-skip). Ship
  those labeled as behavior fixes with regression tests, per plan 1 §10.9.
- **Layering violations dressed as sharing.** Display-input schemas (I) must
  live in `src/shared/schemas/` and stay browser-safe; the trace-viewer must
  not gain a `src/controllers` import (plan 1 §10.7). M1's consolidation moves
  parsing _out_ of `@agent/utils` reach for `src/latex/`, not deeper in.
- **Frozen wires.** The progress-view IPC literals, CLI NDJSON keys, and
  persisted formats named in plan 1 §0.1.6 stay frozen; L1/L2 change internal
  shapes only, and any wire-visible change rides the #6984 deprecation clock.
- **Re-audit drift.** This proposal cites line numbers against `f4b7999f67`;
  re-verify at PR time — two audits in this sweep watched their findings get
  deleted by landing PRs mid-investigation.
