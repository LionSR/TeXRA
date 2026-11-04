# Fewer processing options: decide, don't ask

Date: 2026-11-03
Status: accepted (owner, 2026-11-04)
Origin: owner's observation that the code keeps growing options for special
processing, including declarative ones, against the design philosophy the
repo follows (Ousterhout, _A Philosophy of Software Design_, chapter 19
"Configuration parameters" and chapter 6 "General-purpose modules are
deeper"). Surveyed on `main` at `b411a6d` across the settings catalogs, the
run loop and delegation, `packages/llm`, the document task, the app's UI and
both hosts' request handlers.

## The rule

An option is a decision the code refused to make. Each one doubles the paths a
reader, a test and a resume have to hold in mind, and the special path is the
one nobody exercises. The repo's answer is the one the book gives:

- **Determine it automatically.** If the right value follows from a fact the
  code already holds (the model's capabilities, the credential kind, whether a
  launch names a task), compute it there and delete the knob.
- **Make the special case the general case.** When the "special" path is a
  subset of the general one, run the general one and let the subset fall out.
- **A table is still an option.** A declarative column whose value is the same
  on every row, or derivable from another column, is a special case written as
  data. It hides the same way a flag does and is deleted the same way.
- **One decision has one owner.** Several keys, a per-call input and a tool
  default that all say "may this run do that" are one fact restated.

What follows is the inventory, strongest first. Each item names its producers
and consumers so an implementing PR can follow the trail. The settings removed
here are not persisted beyond `config.json`, which is additive-only: a deleted
key is simply no longer read (`AGENTS.md` "Compatibility and format
retirement"), with a `warn` on first read of an unknown key the catalog once
had.

## 1. Model wire knobs that the route can decide

Seven settings pick a transport or a request field, each read at exactly one
site, each a two-path branch inside the model layer.

| Key                                      | Only read site                                                               | What it selects                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `model.useBackgroundResponses`           | `packages/harness/src/model/modelSettings.ts:106`                            | OpenAI background polling vs streaming (GPT ids, text-only turns)         |
| `model.useGoogleBackgroundResponses`     | `modelSettings.ts:109`                                                       | Google submit-and-poll vs streaming                                       |
| `model.gpt5ReasoningSummary`             | `modelSettings.ts:279` → `packages/llm/src/api/responsesConfiguration.ts:84` | GPT-5 alone omits `summary: 'auto'`; every other reasoning model sends it |
| `model.openaiFastTier`                   | `modelSettings.ts:281` → `responsesConfiguration.ts:156`                     | `serviceTier: 'fast'`                                                     |
| `model.openaiParallelToolCalls`          | `modelSettings.ts:278` → `packages/llm/src/api/configuration.ts:194`         | `parallel_tool_calls`; Anthropic hard-codes `true` at `:93`               |
| `model.useGoogleInteractionsServerState` | `modelSettings.ts:280` → `configuration.ts:119`                              | Google `store`: chain server-side vs resend the transcript                |
| `codeMode.scriptOnly`                    | `packages/harness/src/agent/runtime/agentToolResolution.ts:282-284`          | Offer `script` plus own tools, or every tool; described as an A/B         |

The catalog itself says most of these "have no settings-view row and live in
`.texra/config.json`" (`packages/harness/src/shared/state/stateSettings.ts:199-204`).
With server state off, `useGoogleBackgroundResponses` is silently ignored:
`backgroundCapable` (`packages/llm/src/protocol.ts:104`) answers false, the
bind reports no background, and the turn runs in the foreground, so the
`store` guard at `packages/llm/src/api/googleInteractions.ts:579-585` is
unreachable from the harness. The description promises a fallback the code
performs without saying so.

All of them reach the llm package as `BindSpec.options`
(`packages/llm/src/node.ts:56-76`), whose single producer
(`packages/harness/src/agent/runtime/modelAccess/binding.ts:175-189`) sets every
field, so the defaults at `configuration.ts:156-166` never run, and `background`
there exists only to turn `webSocket` off (`configuration.ts:228-229`).

**Proposal.** Delete the seven keys and the four wire fields of `BindSpec.options`
they feed (`reasoningSummary`, `serverState`, `fastTier`, `background`);
`webSocket` stays (see Rejected) and the harness passes it already combined
with the background decision. The route decides each from facts it holds:

- Background delivery: on whenever the route reports `background: 'supported'`
  and the turn is text-only, which is what the setting's description already
  says. The GPT-only and Google-only conditions become capability flags
  (see §2), not the `config.id.startsWith('gpt')` test at
  `responsesConfiguration.ts:127-130`.
- Reasoning summary: always `'auto'` where the protocol accepts one; GPT-5 is
  not a different case.
- Parallel tool calls: always on. The one documented reason to turn it off
  ("models that require sequential tool run") is a capability, not a user
  preference.
- Server state on Google: keep the one real user choice, data retention, as
  the only survivor. Background delivery already requires it in code
  (`backgroundCapable`); only the description said otherwise.
- `codeMode.scriptOnly`: decided 2026-11-04, script-only wins (the owner's
  code-mode direction; the 2026-10-24 evaluation ran at 0.85x to 0.87x of the
  wall clock at 18% to 66% less cost). Delete the flag and its `injectedWhen`
  branch (`packages/harness/src/tools/builtinPlugins.ts:119`); the two
  journeys that evaluation left (GLM, `agent()`) are the slice's acceptance.

**Give up.** A per-user override of a transport. Nobody has a settings-view
row for one today.

**Acceptance.** `rg "useBackgroundResponses|useGoogleBackgroundResponses|gpt5ReasoningSummary|openaiFastTier|openaiParallelToolCalls|codeMode.scriptOnly" packages` is empty; `BindSpec.options` holds `maxOutputTokens`, `temperature`, `reasoning`, `webSocket` and `fetch`; `readBackgroundToggles` is gone.

_Landed 2026-11-04 (first part): `model.useBackgroundResponses` (its default
was already the rule) and `model.openaiParallelToolCalls` are gone, with
`BindSpec.options.parallelToolCalls`; `readBackgroundToggles` is
`readGoogleBackground`. `model.gpt5ReasoningSummary` followed the same
day on the owner's word: a GPT-5 reasoning request asks for a summary as
every other reasoning model's does, and `BindSpec.options.reasoningSummary`
is gone. `codeMode.scriptOnly` is its own slice: the canned
validation model (CI's `validate` job, the golden store) calls `plan` and
`bash` directly, so flipping to script-only first rewrites that conversation
to call them from scripts, then runs the GLM and `agent()` journeys. Two
keys wait for the owner's word, each a product-visible default:
`model.useGoogleBackgroundResponses` (off: Google text-only turns would stop
streaming) and `model.openaiFastTier` (off: a documented, dearer tier)._

## 2. Declarative columns that are constants or restatements

`ResponsesConfiguration` (`packages/llm/src/turn.ts:162-200`) has three
producers: `vendorRoute`, the ChatGPT case and `firstPartyResponses`
(`packages/llm/src/api/responsesConfiguration.ts:38-159`). Columns that carry
no information across them:

| Column                                                               | Values across the 3 producers                                                                                                                                                                  | Reader                                                                                                        |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `webSocketStreamParameter`                                           | `'implicit'`, `'implicit'`, `'implicit'`                                                                                                                                                       | the `'required'` branch at `packages/llm/src/api/openaiResponsesWebSocket.ts:240` is dead                     |
| `instructions`                                                       | `{kind:'optional'}` ×3                                                                                                                                                                         | the `'required'` and fallback branches at `packages/llm/src/api/openaiResponsesRequest.ts:49-50,104` are dead |
| `supportsStorage`                                                    | always equals `defaults.store` (`:46/:59`, `:100/:114`, `:135/:150`)                                                                                                                           | `openaiResponsesRequest.ts:102`, `packages/llm/src/api/openaiResponsesLower.ts:302`                           |
| `requestDialect`, `toolNamespace: null`, `background: 'unsupported'` | `'compatible'` exactly when `vendorRoute` built the row; the others co-vary with it. `openaiEndpoint` does not: it is the bind's own endpoint test (`responsesConfiguration.ts:143`) and stays | `openaiResponsesRequest.ts:66,119,168`                                                                        |

Two model-id string tests stand in for capabilities the catalog should carry:
`config.id.startsWith('gpt-5')` (`responsesConfiguration.ts:84`) and
`config.id.toLowerCase().startsWith('gpt')` (`:128`). Both read an id that may
already be the short-name rewrite (`packages/harness/src/agent/runtime/modelAccess/ModelAccess.ts:165-172`).

Smaller instances of the same shape:

- `TurnRequest.store` (`packages/llm/src/turn.ts:102-116`) has no production
  producer; `packages/harness/src/agent/runtime/ModelInvoker.ts:459-470` never
  sets it. Anthropic only rejects it (`packages/llm/src/api/anthropicMessages.ts:632`).
- The reasoning schema admits `summary: 'concise' | 'detailed'` and
  `mode: 'standard'` (`turn.ts:74-75`); nothing produces them.
- `ChooseReasoningOptions.strict` (`packages/llm/src/models/reasoningChoice.ts:138-147`)
  has no producer; `routeEfforts` is a second per-route effort ceiling beside
  `CODEX_ROUTE_EFFORTS` in `routeControls` (`:32-35`, `:57-63`).
- The ChatGPT route is named two ways, `route.kind === 'chatgpt-subscription'`
  and `credential.kind === 'chatgpt'`, mapped into each other at
  `binding.ts:172`; "no input files on the plan" is stated once as
  `supportsNativePdf: false` (`packages/llm/src/models/modelRoute.ts:304`) and
  read back as `supportsDocumentInput` (`responsesConfiguration.ts:101`).
- `isUnservedModel` (`modelRoute.ts:118-122`) and `decideModelRoute`'s
  `'unserved'` (`:216`) disagree on retired models.

**Proposal.** Delete the four constant or derived columns and their dead
branches; replace the two id-prefix tests with llm-zoo capability flags
(`supportsBackground`, and no GPT-5 summary exception at all once §1 lands);
narrow the reasoning literals to what is produced; delete `TurnRequest.store`
and `strict`; keep one route-kind discriminator from which `requestDialect` and
`toolNamespace` follow.

**Give up.** Nothing observable. Every deleted value has one producer value.

**Acceptance.** `ResponsesConfiguration` loses `webSocketStreamParameter`,
`instructions`, `supportsStorage` and `requestDialect`;
`rg "startsWith\('gpt" packages/llm` is empty.

_Landed 2026-11-04: `webSocketStreamParameter`, `instructions`,
`supportsStorage` and `toolNamespace` are gone; `requestDialect` is the one
route-kind discriminator (`openai`, `compatible`, `chatgpt`); `TurnRequest.store`
and `ChooseReasoningOptions.strict` are gone; `summary` is `'auto'` alone.
Corrections: `routeEfforts` has a producer (the installed Codex CLI's
levels, `packages/texra/src/tools/agentCli/codexConfig.ts`) and stays; the
two id-prefix tests stay until llm-zoo carries a background capability, and
the GPT-5 summary test with its key above._

## 3. One approval decision

Six settings, two per-call tool inputs and a default answer the same question:
may this run do that without asking?

| Mechanism                                                    | Where                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approvalPolicy`                                             | `packages/harness/src/shared/approvalPolicy.ts`, 11 files                                                                                                                                                                                                                                                           |
| `toolUse.requireEditApproval`, `toolUse.requireBashApproval` | `packages/harness/src/agent/runtime/loop/toolGuard.ts:76-78`; only matter under `ask`                                                                                                                                                                                                                               |
| `codexApprovalPolicy`                                        | `packages/texra/src/tools/agentCli/codex.ts:401-404`, passed through; `on-request`, `untrusted`, `on-failure` branch nowhere                                                                                                                                                                                        |
| `codexSandboxMode`                                           | `packages/texra/src/tools/agentCli/codexImport.ts:203-209`; the per-call `sandbox_mode` wins                                                                                                                                                                                                                        |
| `claudeAgentPermissionMode`                                  | `packages/texra/src/tools/agentCli/claudeAgentImport.ts:137-143`; only `bypassPermissions` is branched (`claudeAgent.ts:194`); the per-call `permission_mode` wins                                                                                                                                                  |
| `allowOrchestratorKill`, `detachSubagentsOnStop`             | `packages/harness/src/tools/executions/killPolicy.ts:28-44`, `packages/harness/src/agent/runtime/runRegistry.ts:495-500`; the latter is overridden by a per-stop argument that no client sends (`RunStopOptions.detachActiveChildren`, `packages/harness/src/agent/runtime/runs.ts:98`; producers set only `false`) |

**Proposal.** The run's `approvalPolicy` is the one owner. The two `toolUse.*`
booleans become the policy's definition of what `ask` asks (both on, or
delete them and ask for every guarded operation). The agent-CLI tools derive
their sandbox and permission mode from the run's policy at launch, which
deletes `codexApprovalPolicy`, `codexSandboxMode` and
`claudeAgentPermissionMode` and the two per-call inputs that shadow them.
`detachActiveChildren` becomes `cascade?: true` or goes, since the setting
already decides and no client overrides it.

**Give up.** Running Codex under a looser sandbox than the TeXRA run that
launched it. That was never a coherent state.

**Acceptance.** The settings catalog has one approval row per host-visible
decision; `rg "codexApprovalPolicy|codexSandboxMode|claudeAgentPermissionMode" packages` is empty.

_Landed 2026-11-04: the two `toolUse.*` toggles, `codexSandboxMode`,
`codexApprovalPolicy`, `claudeAgentPermissionMode` and the two per-call inputs
are gone. `ChildRuns.autoApproved` answers the policy's one reading
(`executableDecision`) when a plugin asks, and the agent-CLI tools derive their
sandbox and permission mode from it: workspace-write / acceptEdits when a person approved
the launch, danger-full-access / bypassPermissions when the run's work is
auto-approved; Codex launches with `approvalPolicy: never`.
`RunStopOptions.detachActiveChildren` and the wire field are gone: a shutdown
cascades, a user stop reads "Keep agents running" (`stop(runId, reason)`,
protocol 52). `allowOrchestratorKill` stays: a capability switch on an
unguarded tool, not an approval._

## 4. Launch option bags whose fields travel together

Each of these is a bag of independent optionals with exactly one producer
pattern, so the "options" are one choice spelled as several.

- **In-band child.** `packages/harness/src/agent/runtime/delegation/inBandSubagentRun.ts:153-179`
  is the only producer of `awaited: true`, `inBand: true` and
  `resume.stopAfterCycle: true`, and `inBand` becomes
  `deliveryMode: 'persistOnly'`, a one-value union
  (`nativeSubagentStrategy.ts:105-107`, read at `childRunLoop.ts:391,435,672`).
  One `awaited: true` on the loop params, from which the strategy derives the
  rest.
- **`ChildLaunch`** (`packages/harness/src/agent/runtime/delegation/AgentTool.ts:162-189`):
  the `agent` tool always passes `task: null`, empty file lists and a
  `schema`; `document_task` (`packages/texra/src/tools/documents/DocumentTaskTool.ts:79`)
  always passes a task, files and `schema: null`. A tagged union
  `{kind:'agent'} | {kind:'task'}` makes the invalid mixes unrepresentable.
- **`CompactionInput.force: 'request' | null`** (`packages/harness/src/agent/runtime/run/compaction.ts:106`):
  the one caller (`:390`) always passes `'request'`, so the `null` branch at
  `:295` never runs; the threshold path is already separate (`:397-420`).
  Delete the field.
- **Strategy hooks with one implementer each**: `runTurn`, `pauseNotice`,
  `onTurnSuccess`, `releaseSessionOwnership` (only
  `packages/texra/src/tools/agentCli/agentCliShared.ts:482-503`),
  `interruptedTurn` (only `packages/harness/src/tools/bash.ts:304`),
  `stopNotice`, `deliveryId` (only `packages/harness/src/agent/runtime/scriptRun.ts:254,298`).
  A closed union of the concrete strategies instead of a bag of optionals.
- **`RegisterRunOptions.provenance` + `descriptionBy`**
  (`packages/harness/src/shared/session/runFacts.ts:246-248`) are set only by
  `packages/harness/src/agent/runtime/forkRun.ts:240-243`, always together: one
  `fork` field.
- **`ProcessLayerOptions.labelRuns` and `seedToolSwitches`**
  (`packages/harness/src/effect/processLayer.ts:64,68`): each set once, by
  `packages/texra/src/controllers/texraProcessLayer.ts:140,146`, the second
  always beside an injected `appState`. Derive both from what is injected.
- **`AgentRuntimeEmitOptions.replayWhenAttached`**
  (`packages/harness/src/agent/runtime/runtimePresentationEvents.ts:37`): every
  producer passes `true`. Make it the behaviour, not an option.

**Give up.** Combinations nobody builds.

**Acceptance.** Each listed field is gone or its type admits only the
combinations a producer builds; the `nativeSubagentStrategy` and
`childRunLoop` interfaces name concrete strategies.

_Landed 2026-11-04: the members that travel together
are one bag each, so a strategy with only some of them no longer type-checks:
`NativeChildStrategy.script` (`deliveryId` + `stopNotice`, the script run's)
with `isTurnInterrupted` required, and `ProcessChildStrategy` a union of the
one-turn command (`interruptedTurn`) and the agent CLI's `cli` (`runTurn`,
`pauseNotice`, `onTurnSuccess`, `releaseSessionOwnership`); named strategy
interfaces were tried and refused by `childRunLoop.ts`'s size cap and the
layer-names baseline, which pins `ProcessChildStrategy` to that module.
`ChildLaunch` followed in its own PR: a chat (`task: null`, `schema`,
`mediaFiles`) or a task (`task`, `files`), normalized once in `agentCall`;
`AgentTool.ts` made room by dropping the header prose that restated the
tool's description and by reading the two resolvers' typed failures with
`Effect.result` (an `Effect.exit` had reported an interruption as an error
result).
`inBand` and `deliveryMode: 'persistOnly'` are gone, the loop reads its own
`awaited`; `CompactionInput.force` is gone (the reason is `forced`'s
argument; `compactIfNeeded` folded into it); `RegisterRunOptions.descriptionBy`
is gone (the fork appends its copied title row to its registration rows);
`ProcessLayerOptions.seedToolSwitches` and `labelRuns` are gone (a store the
process builds is seeded, a handed-in one left alone, `Sessions.layer` seeds
the embedder's; `processLayer` provides `RunLabels` to every host);
`AgentRuntimeEmitOptions.replayWhenAttached` is gone (replay is the
behaviour). Kept: `resume.stopAfterCycle` (a host resume is a second
producer with a varying value). Split off: the `ChildLaunch` union on `task`
(chat: `schema` + `mediaFiles`; task: `files`): `AgentTool.ts` sits two lines
under its size cap, so it lands with a trim of that file._

## 5. The document task's options: one table, one name, every surface

`DocumentTaskOptionsSchema` (`packages/texra/src/shared/plugins/documents.ts:222-239`)
has five switches. Each launcher reaches a different subset, and the tool
renames two of them:

| Option                  | `document_task` tool (`DocumentTaskTool.ts:47-56`) | CLI (`packages/cli/src/commands/workflow.ts:228`) | Launch form (`packages/texra/src/ui/progress/components/FileSelectGroup.ts:183-235`)            |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `autoExtractFigure`     | as `extractFigures`                                | no                                                | yes                                                                                             |
| `autoExtractTikzFigure` | as `extractTikz`                                   | no                                                | yes                                                                                             |
| `attachTeXCount`        | no                                                 | no                                                | yes                                                                                             |
| `autoCompileInputPdf`   | no                                                 | no                                                | yes                                                                                             |
| `reflect`               | yes                                                | yes                                               | no, though `LaunchSurfaceSchema` carries it (`packages/texra/src/shared/session/surface.ts:63`) |

The launch form hand-writes four near-identical checkbox items; the approval
badges (`packages/texra/src/ui/progress/components/ProposalRequestPanel.ts:266-268`)
show three. The YAML `task.rewrite` field is set by one bundled agent
(`packages/extension/resources/agents/write/paper2poster.yaml:13`) and read
once (`packages/texra/src/tools/documents/documentTools.ts:309`), while
`paper2slide`, `ocr` and `transcribe_audio` declare their own `outputs:` and
keep the default; `rewrite` is `outputs.length === 0`.

**Proposal.** One table `{key, label, description}` owned by the documents
plugin, from which the tool's input schema, the CLI flags, the launch form's
items and the approval badges are rendered, under the stored key names. Derive
`rewrite` from `outputs` and delete the field. If a switch should not be
offered on a surface, the table says so; nothing hand-writes a subset.

**Give up.** The tool's two friendlier names. The stored names are the
contract the approval shows.

**Acceptance.** `rg "extractFigures|extractTikz" packages` is empty;
`FileSelectGroup.ts` renders its items from the table; `task.rewrite` is gone
from `documentTask.ts` and the YAMLs.

_Landed 2026-11-04: `DOCUMENT_TASK_OPTIONS`
(`packages/texra/src/shared/plugins/documents.ts`) is the table, a `label`,
`description` and `menu` per stored key; `DocumentTaskOptionsSchema`, the
`document_task` tool's fields, `texra run`'s flags, the launch form's menu
items and the approval badges render from it, so every surface offers every
switch under the stored name (the tool's `extractFigures` and `extractTikz`
are gone, the form gained Critic review, `FileSelectConfig.toolConfig` is
gone). `task.rewrite` is gone: `outputs.length === 0` at its one reader, so a
task that declares `outputs` gets no diff lineage (before, a single-input one
was diffed against its unrelated input). The harness card's dead badge block
went with it; the `badges` section kind stays, since the Codex card states
one (the claim above that the block was its only producer was wrong). No row
or protocol bumps._

The storage layer, error definitions and catch sites, interruption and stop,
and the model-call failure path are inventoried under the same rule in
[storage, errors and stop paths](./2026-11-03-storage-errors-and-stop-paths.md).

## 6. Bounded deletions

Each is a single PR with no design call; grouped here so the thread is in one
place. File as `tech-debt` issues if they are not picked up with the sections
above.

- `pickFiles.fileType` admits `base` and `edited` that no producer sends and
  the desktop rejects (`packages/texra/src/shared/session/hostRequest.ts:120-123`,
  `packages/desktop/src/main/desktopHostRequests.ts:254-257`); the extension's
  `output` picker (`packages/extension/src/commands/files/fileSelectionCommands.ts:89-92`)
  is unreachable and carries a second copy of `inputExtensions`.
- `openInstallGuide.tool` is sent by `DependencyBanner.ts:56` and ignored by
  both hosts (`packages/extension/src/progressView/extensionHostRequests.ts:453-457`,
  `desktopHostRequests.ts:221`).
- `acceptEditedFile`'s `copyMeta` is computed for both hosts and dropped by the
  desktop binding (`desktopHostRequests.ts:344-345`).
- The replacement categories `personal_style`, `max_style`,
  `equation_macros`, `max_style_regex` are off by default with no UI anywhere;
  `packages/texra/src/shared/constants/replacementCategories.ts:4-5` claims a
  LaTeX-tab UI that does not exist. The regex and non-regex key pairs
  (`latex.enabledReplacements*`, `latex.customReplacements*`) are one list
  each.
- `goal.strategy` admits any `builtIn:*` but only `builtIn:goal` exports
  `goal()` (`packages/harness/src/tools/plan/goalScript.ts:55`).
- `latexdiff.tempFileLocation`, `latexdiff.changesOnly` and
  `latex.wrapCritiqueInAlign` are one-reader two-path toggles with no UI row.
- `git.markCommits` gates `git.authorName` and `git.authorEmail`
  (`packages/harness/src/utils/system/execUtils.ts:53-64`): a present name is
  the switch.
- `followUp.receipt` (`packages/harness/src/shared/session/runtimeRequest.ts:122`)
  has producers only in `packages/harness/example/`; keep it only as public SDK.
- CLI: `clone` names its destination twice (`packages/cli/src/commands/clone.ts:153-191`);
  `config agents` has eight flags for three choices
  (`packages/cli/src/commands/config.ts:111-131,201-232`); `--input`,
  `--context`, `--instruction-file` and `--model` are declared in two to four
  command files and collected once (`packages/cli/src/commands/_helpers/globalArgs.ts:261`).
- `RegexRuleSet.flags?` (`packages/texra/src/replacement/types.ts:31`) is set
  by all nine rule sets: required.

_Landed 2026-11-04 (CLI): `clone`'s destination is its second argument and
`--cwd` keeps its one global meaning (the directory the command works in,
which the positional resolves against; `clone` and `init` no longer re-describe
it); `config agents` takes `--agents <inherit|all|team:<team>|list>`,
`--default-team <team|none>` and `--default-agent <agent|none>`, the grammar
the command already printed and the forms used, so five flags and three
"not both" errors are gone and a team is looked up one way for both flags.
Checked and kept: `--input`, `--context`, `--instruction` and `--model` are
declared per command because their help differs per command (the team
orchestrator, `run`'s media and document-task notes), `--model` was never
collected once, and `--instruction-file` is the one identical pair._

## Rejected

- **`websocket.openai`.** The owner ruled to keep the experimental WebSocket
  transport behind its flag (#12869, closed as not planned: "should not be
  re-proposed"). It stays. Its description still promises the ChatGPT backend
  may use the socket while `packages/llm/src/node.ts:193` requires an API key;
  fix the copy, not the flag.
- **Per-provider `useChina` toggles and `endpoint.*` overrides.** Four
  booleans over one generic read (`modelSettings.ts:141-146`) look like §1, but
  the region is a fact only the user knows. Keep; the `endpoint.glm` over
  `glm.codingPlan` precedence (`modelSettings.ts:292`) is a documented ladder
  (#13062).
- **Plugin hooks with one implementer** (`agentBlock`, `decision`,
  `requires`): the SDK surface the harness publishes. Trimming it is the
  general-package note's call, not a special-processing cut.
- **`OpenOptions.persistent`**: every host passes `true`, but the in-memory
  default is the SDK's documented embedding mode.

## Order

§1 and §2 together (one PR per package side: the harness deletes the keys and
the bind fields, the llm package deletes the columns and the id tests). §3
next; it is the one with user-visible copy. §4 is several independent PRs.
§5 is one PR in the app. §6 as issues or as riders on whichever PR touches the
file.
