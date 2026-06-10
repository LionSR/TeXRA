export const meta = {
  name: 'simplify-since-0385-pass2',
  description: 'Pass 2: declarative refactor of all TUI/CLI batches + simplify-retry of 4 rate-limited backend batches',
  phases: [
    { title: 'Declarative', detail: 'TUI/CLI batches: make new code more declarative' },
    { title: 'Backend-retry', detail: 'agent/tools/shared batches that were rate-limited' },
  ],
}

// mode 'declarative' = simplify + push toward declarative patterns (TUI/CLI).
// mode 'simplify'    = plain behavior-preserving simplification (backend retry).
const BATCHES = [
  { name: 'tui-app', mode: 'declarative', files: [
    'packages/cli/src/chat/tui/runChatTui.tsx',
    'packages/cli/src/chat/tui/App.tsx',
    'packages/cli/src/chat/tui/commands/registerBuiltins.tsx',
  ] },
  { name: 'tui-state', mode: 'declarative', files: [
    'packages/cli/src/chat/tui/state/streamViews.ts',
    'packages/cli/src/chat/tui/state/cliState.ts',
    'packages/cli/src/chat/tui/state/childControls.ts',
    'packages/cli/src/chat/tui/state/transcriptViewportMode.ts',
    'packages/cli/src/chat/tui/state/transcriptProjection.ts',
    'packages/cli/src/chat/tui/state/transcriptScroll.ts',
    'packages/cli/src/chat/tui/state/transcript.ts',
    'packages/cli/src/chat/tui/state/streamStatus.ts',
    'packages/cli/src/chat/tui/state/subscribeApprovals.ts',
    'packages/cli/src/chat/tui/state/approvalQueue.ts',
  ] },
  { name: 'tui-panes', mode: 'declarative', files: [
    'packages/cli/src/chat/tui/panes/TranscriptEntry.tsx',
    'packages/cli/src/chat/tui/panes/StaticConversationTranscript.tsx',
    'packages/cli/src/chat/tui/panes/StatusBar.tsx',
    'packages/cli/src/chat/tui/panes/EntryErrorBoundary.tsx',
    'packages/cli/src/chat/tui/panes/ConversationPane.tsx',
    'packages/cli/src/chat/tui/panes/transcriptViewport.ts',
    'packages/cli/src/chat/tui/panes/ToolUseRow.tsx',
    'packages/cli/src/chat/tui/panes/TipRow.tsx',
    'packages/cli/src/chat/tui/panes/StreamTabsStrip.tsx',
  ] },
  { name: 'tui-views', mode: 'declarative', files: [
    'packages/cli/src/chat/tui/forms/SkillsListForm.tsx',
    'packages/cli/src/chat/tui/input/inputKeys.ts',
    'packages/cli/src/chat/tui/render/noColorOutput.ts',
    'packages/cli/src/chat/tui/forms/ModelListForm.tsx',
    'packages/cli/src/chat/tui/modals/ExternalInquiry.tsx',
    'packages/cli/src/chat/tui/forms/AgentListForm.tsx',
    'packages/cli/src/chat/tui/input/BaseTextInput.tsx',
    'packages/cli/src/chat/tui/forms/_shared/useAsyncListForm.ts',
    'packages/cli/src/chat/tui/render/DiffView.tsx',
    'packages/cli/src/chat/tui/input/textInputEditing.ts',
    'packages/cli/src/chat/tui/modals/TranscriptViewer.tsx',
    'packages/cli/src/chat/tui/forms/_shared/FormFrame.tsx',
    'packages/cli/src/chat/tui/render/ansiMarkdown.ts',
    'packages/cli/src/chat/tui/render/Markdown.tsx',
  ] },
  { name: 'cli-runtime-a', mode: 'declarative', files: [
    'packages/cli/src/runtime/multiAgentPresets.ts',
    'packages/cli/src/runtime/modelAccess.ts',
    'packages/cli/src/runtime/clipboardText.ts',
    'packages/cli/src/runtime/agents.ts',
    'packages/cli/src/runtime/loginOptions.ts',
    'packages/cli/src/runtime/workflowInputs.ts',
    'packages/cli/src/runtime/approvalEvents.ts',
    'packages/cli/src/runtime/toolUseResumeData.ts',
    'packages/cli/src/runtime/runModel.ts',
  ] },
  { name: 'cli-runtime-b', mode: 'declarative', files: [
    'packages/cli/src/runtime/tools.ts',
    'packages/cli/src/runtime/history.ts',
    'packages/cli/src/runtime/cliConfig.ts',
    'packages/cli/src/runtime/doctor.ts',
    'packages/cli/src/runtime/initPlatform.ts',
    'packages/cli/src/runtime/apiStatus.ts',
    'packages/cli/src/runtime/agentResolution.ts',
    'packages/cli/src/runtime/orchestration.ts',
    'packages/cli/src/runtime/sessionResume.ts',
    'packages/cli/src/runtime/chatDefaults.ts',
    'packages/cli/src/runtime/historyLabels.ts',
    'packages/cli/src/runtime/oauthProviderDisplay.ts',
    'packages/cli/src/runtime/globalArgs.ts',
    'packages/cli/src/runtime/defaultAgents.ts',
    'packages/cli/src/runtime/approvalAdapter.ts',
    'packages/cli/src/runtime/approvalPolicyAvailability.ts',
    'packages/cli/src/runtime/supabaseAuth.ts',
  ] },
  { name: 'cli-commands', mode: 'declarative', files: [
    'packages/cli/src/commands/multiAgent.ts',
    'packages/cli/src/commands/auth.ts',
    'packages/cli/src/commands/loginProviderPicker.tsx',
    'packages/cli/src/commands/_helpers/dispatch.ts',
    'packages/cli/src/commands/_helpers/globalArgs.ts',
    'packages/cli/src/commands/_helpers/runFileInstruction.ts',
    'packages/cli/src/commands/history.ts',
    'packages/cli/src/commands/orchestrate.ts',
    'packages/cli/src/commands/_helpers/toolUseRunInstruction.ts',
    'packages/cli/src/commands/agentsRun.ts',
    'packages/cli/src/commands/agents.ts',
    'packages/cli/src/commands/tools.ts',
    'packages/cli/src/commands/workflow.ts',
    'packages/cli/src/commands/init.ts',
    'packages/cli/src/commands/root.ts',
  ] },
  { name: 'agent-runtime-b', mode: 'simplify', files: [
    'src/agent/runtime/executeAgent.ts',
    'src/agent/runtime/AgentLaunchContext.ts',
    'src/agent/runtime/mediaVisionWarning.ts',
    'src/agent/runtime/StreamStatusService.ts',
    'src/agent/runtime/InterruptRegistry.ts',
    'src/agent/runtime/AgentRuntimeHost.ts',
    'src/agent/runtime/SessionResumeRetrieval.ts',
    'src/agent/runtime/AgentFlowResult.ts',
    'src/agent/runtime/agentToolResolution.ts',
    'src/agent/runtime/delegationPolicy.ts',
    'src/agent/runtime/toolInjection.ts',
    'src/agent/runtime/idleContinuation.ts',
  ] },
  { name: 'agent-internals', mode: 'simplify', files: [
    'src/agent/modelHandlers/ModelHandler.ts',
    'src/agent/implementations/flows/tooluse/runToolUseFlow.ts',
    'src/agent/output/compileCheck.ts',
    'src/agent/implementations/flows/reflection/nodes/OutputNode.ts',
    'src/agent/output/compileFailureRoundContext.ts',
    'src/agent/toolUse/FollowUpQueue.ts',
    'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
    'src/agent/implementations/flows/tooluse/modelSwitchState.ts',
    'src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts',
    'src/agent/modelHandlers/openai/modelHandlerOpenAI.ts',
    'src/agent/toolUse/ToolUseFollowUp.ts',
    'src/agent/implementations/flows/tooluse/nodes/ToolUseWaitNode.ts',
    'src/agent/core/flows/RetryState.ts',
    'src/agent/core/flows/ToolUseCycleFlow.ts',
    'src/agent/modelHandlers/google/modelHandlerGoogleGenAI.ts',
    'src/agent/toolUse/ToolUseFollowUpQueueManager.ts',
  ] },
  { name: 'tools', mode: 'simplify', files: [
    'src/tools/lean/direct/jsonRpc.ts',
    'src/tools/plan/PlanTool.ts',
    'src/tools/childStream.ts',
    'src/tools/agentCliSessionRegistry.ts',
    'src/tools/subagentDeliveryState.ts',
    'src/tools/codex.ts',
    'src/tools/lean/lspTypes.ts',
    'src/tools/claudeAgent.ts',
    'src/tools/workPlanGranularityFeedback.ts',
    'src/tools/approval/proposalApproval.ts',
    'src/tools/claudeAgentShared.ts',
    'src/tools/bash.ts',
    'src/tools/ExecutionsTool.ts',
    'src/tools/DelegationTools.ts',
    'src/tools/arxiv/ArxivSearchTool.ts',
    'src/tools/approval/latexPreview.ts',
    'src/tools/lean/direct/leanSession.ts',
    'src/tools/inquiry/inquiryContinuation.ts',
    'src/tools/EditTool.ts',
    'src/tools/citation/CrossrefSearchTool.ts',
    'src/tools/todo/TodoTool.ts',
    'src/tools/ReadTool.ts',
  ] },
  { name: 'shared-misc', mode: 'simplify', files: [
    'src/shared/streams/streamStatusDisplay.ts',
    'packages/cli/src/orchestration/runOrchestrationTui.tsx',
    'packages/extension/src/webview/frontend/MainApp.ts',
    'src/shared/streams/streamMetadata.ts',
    'src/skills/skillSources.ts',
    'src/latex/arxivProcessor.ts',
    'src/utils/system/platformPaths.ts',
    'packages/cli/src/onboarding/runOnboarding.tsx',
    'packages/cli/src/init/runInitWizard.tsx',
    'packages/extension/src/commands/agent/resumeFromSnapshot.ts',
    'src/skills/runtimeSkills.ts',
    'packages/extension/src/webview/frontend/components/LoginBanner.ts',
    'packages/extension/src/settingsView/frontend/tabs/LaTeXTab.ts',
    'packages/extension/src/extension.ts',
    'packages/extension/src/commands/latex/latexdiffCommands.ts',
    'src/platform/interfaces/toolAvailability.ts',
    'src/agent/storage/executionLifecycle.ts',
    'src/shared/schemas/streamState.ts',
    'packages/extension/src/settingsView/handlers/latexSettingsHandlers.ts',
    'src/types/which.d.ts',
    'src/shared/schemas/output.ts',
    'src/auth/SupabaseSession.ts',
    'src/agent/index/agentRegistry.ts',
    'packages/extension/src/commands/agent/resumeCommand.ts',
  ] },
]

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    batch: { type: 'string' },
    edited: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          summary: { type: 'string', description: 'what changed and why it is behavior-preserving' },
        },
        required: ['file', 'summary'],
      },
    },
    skipped: { type: 'array', items: { type: 'string' } },
    risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
    notes: { type: 'string' },
  },
  required: ['batch', 'edited', 'risk', 'notes'],
}

const CONVENTIONS = [
  `## Repo conventions (from CLAUDE.md / AGENTS.md), follow these`,
  `- Prose/comments: NO em dashes, no AI-slop, no narrating capabilities. Match surrounding comment density and idiom. Prefer deleting a redundant comment over rewording it.`,
  `- Zod v4 is the single source of truth for data shapes: derive types via z.infer, compose with .extend()/.pick(), avoid z.custom<T>() when a real schema exists, prefer discriminatedUnion. Use .prefault()/.catch()/.nullish() idioms.`,
  `- Platform coupling: VS Code-free zones (src/agent, src/model, src/latex, src/tools, src/controllers, src/shared, src/transcript, webview frontends, packages/cli/**) must NOT import 'vscode'. Reach host services via platform() from '@platform'. Use isFile()/isDirectory() from '@utils/files/fsEntryType', isFileNotFoundError() from '@common/errors'.`,
  `- Avoid the discouraged factory/wrapper anti-patterns and flatten unnecessary abstraction layers (nodes create+run flows directly; delete unused wrappers rather than leaving re-exports).`,
  `- No render-time workarounds: renderers transform and display only, with no wall-clock reads, synthetic ids, DOM existence checks, or dedup at render time. If a renderer needs that, the upstream data model is missing it (flag under "skipped").`,
  `- TUI files (packages/cli/src/chat/tui/**): respect the Ink discipline. Root scrollback owns finalized root history via <Static> (dedupe by stable id), the live region stays minimal, renderers are stateless (view toggles live in shared signal state, not local component state), no line-count erase "fixes" for resize. Headless/--print parity is sacred: never let Ink chrome leak into the non-TTY path.`,
  `- CLI (packages/cli/**) follows clig.dev and leans on citty for parsing/help and picocolors for color. Prefer existing libraries over bespoke implementations.`,
  `- Prefer importing existing shared helpers over re-implementing; match existing naming and file idioms.`,
].join('\n')

const HARD_CONSTRAINTS = [
  `## Hard constraints`,
  `- Edit ONLY the files in your list. Never touch files with unrelated uncommitted working-tree changes (the user is concurrently editing some UI/style files; stay clear).`,
  `- Behavior-preserving ONLY. If a change is speculative, alters timing/ordering, or you are not confident it is equivalent, DO NOT make it. Record it under "skipped". Zero edits is a valid outcome.`,
  `- Do NOT run builds, typecheck, lint, tests, or any git state-changing command (no add/commit/stash/checkout). A central typecheck runs after you. Read-only git (diff/show/log) and read-only file tools are fine.`,
  `- Do NOT edit package.json, tsconfig, lockfiles, configs, or generated files.`,
  `- Leave your edits uncommitted in the working tree.`,
].join('\n')

const DECLARATIVE = [
  `## Additional goal for this batch: make the new TUI/CLI code MORE DECLARATIVE`,
  `Beyond plain simplification, refactor toward declarative patterns where it stays behavior-identical and genuinely reads cleaner:`,
  `- Data-driven rendering/dispatch: replace repeated imperative JSX blocks or long if/else ladders that differ only by data with a map over a module-level config/table of {key, label, render, ...} entries. Replace imperative value-selection chains with lookup maps or switch expressions over a discriminated union.`,
  `- Derive, do not mutate: compute view values from props and shared signal state (state/cliState.ts and friends) as pure derivations. Pull view toggles (collapse/expand/focus/selection) out of local component state into shared signal state if a new toggle was added imperatively. Renderers stay pure props -> JSX.`,
  `- Hoist branch tables and magic values to module-level const config so the render/handler body reads as a declaration of intent, not a procedure.`,
  `- CLI commands: prefer citty's declarative meta/args/subCommands config over imperative argv branching; express defaults and option sets as data tables where that is cleaner.`,
  `Do NOT over-engineer: only convert imperative code to declarative when it removes real duplication or branching and preserves behavior exactly (same outputs, same ordering, same effects). A tiny one-off conditional is fine to leave imperative. If a declarative form would change render order, effect timing, or short-circuit semantics, keep the imperative form and note it under "skipped".`,
].join('\n')

function buildPrompt(batch) {
  const { name, mode, files } = batch
  const head = [
    `You are a code-simplifier on the TeXRA repo. Work on the source ADDED or CHANGED since the v0.38.5 release tag, in EXACTLY these ${files.length} files (batch "${name}"):`,
    files.map((f) => `  - ${f}`).join('\n'),
    ``,
    `## See what changed`,
    `For each file inspect the committed diff since the release: \`git diff v0.38.5..HEAD -- <file>\`. Read the full current file too. You may READ any other file for context, but MUST NOT edit any file outside your list.`,
    ``,
    `## Goal`,
    `Improve clarity, consistency, and maintainability of the NEW/CHANGED code while preserving behavior EXACTLY. Look for: duplicated logic to share; unnecessary wrapper/indirection layers and trivial one-call factories (inline); dead code, unused vars/params/imports; deeply nested conditionals that flatten cleanly; redundant type assertions or hand-rolled types where a derived/native type fits; verbose constructs with an idiomatic shorter form; comments that merely restate code. Keep changes scoped to the code the diff touched and its immediate surroundings; do NOT refactor untouched pre-existing code far from the change. Some of these files were already lightly simplified in an earlier pass; work from the current file state.`,
  ]
  const body = mode === 'declarative' ? [DECLARATIVE, CONVENTIONS, HARD_CONSTRAINTS] : [CONVENTIONS, HARD_CONSTRAINTS]
  const tail = [
    `## Quality bar`,
    `Apply edits with Edit/Write directly. After editing, re-read each changed file to confirm it is coherent and imports are still correct. Then return the structured summary: every edited file with a one-line behavior-preserving rationale, anything notable skipped and why, an overall risk rating, and notes.`,
  ]
  return [...head, ``, ...body.flatMap((s) => [s, ``]), ...tail].join('\n')
}

// Bounded concurrency so we do not trip server-side rate limiting again.
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function runner() {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner))
  return results
}

phase('Declarative')
log(
  `Pass 2: ${BATCHES.filter((b) => b.mode === 'declarative').length} TUI/CLI batches (declarative) + ${BATCHES.filter((b) => b.mode === 'simplify').length} backend batches (simplify-retry), 5-wide pool`,
)

const results = await runPool(BATCHES, 5, (batch) =>
  agent(buildPrompt(batch), {
    label: `${batch.mode === 'declarative' ? 'declarative' : 'retry'}:${batch.name}`,
    phase: batch.mode === 'declarative' ? 'Declarative' : 'Backend-retry',
    agentType: 'code-simplifier:code-simplifier',
    schema: SCHEMA,
  }).then((r) => r || { batch: batch.name, edited: [], skipped: [], risk: 'none', notes: 'agent returned null (skipped or failed)' }),
)

const totalEdited = results.reduce((n, r) => n + (r.edited ? r.edited.length : 0), 0)
log(`Pass 2 done: ${totalEdited} files edited across ${results.length} batches`)
return { results }
