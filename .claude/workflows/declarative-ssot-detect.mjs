export const meta = {
  name: 'declarative-ssot-detect',
  description: 'Read-only detection of declarative refactors and single-source-of-truth consolidations in code changed since v0.38.5',
  phases: [{ title: 'Detect', detail: 'one analysis agent per batch; finds imperative->declarative + duplicated definitions' }],
}

const BATCHES = [
  { name: 'tui', files: [
    'packages/cli/src/chat/tui/runChatTui.tsx', 'packages/cli/src/chat/tui/App.tsx',
    'packages/cli/src/chat/tui/commands/registerBuiltins.tsx', 'packages/cli/src/chat/tui/state/streamViews.ts',
    'packages/cli/src/chat/tui/state/cliState.ts', 'packages/cli/src/chat/tui/state/childControls.ts',
    'packages/cli/src/chat/tui/state/subscribeApprovals.ts', 'packages/cli/src/chat/tui/state/approvalQueue.ts',
    'packages/cli/src/chat/tui/panes/TranscriptEntry.tsx', 'packages/cli/src/chat/tui/panes/StatusBar.tsx',
    'packages/cli/src/chat/tui/panes/ConversationPane.tsx', 'packages/cli/src/chat/tui/panes/StreamTabsStrip.tsx',
    'packages/cli/src/chat/tui/forms/ModelListForm.tsx', 'packages/cli/src/chat/tui/forms/AgentListForm.tsx',
    'packages/cli/src/chat/tui/forms/SkillsListForm.tsx', 'packages/cli/src/chat/tui/input/inputKeys.ts',
    'packages/cli/src/chat/tui/input/textInputEditing.ts',
  ] },
  { name: 'agent-runtime', files: [
    'src/agent/runtime/executionRegistry.ts', 'src/agent/runtime/ModelFactory.ts',
    'src/agent/runtime/ProcessOutputPoller.ts', 'src/agent/runtime/AgentRunLifecycle.ts',
    'src/agent/runtime/runCoordinators.ts', 'src/agent/runtime/ExecutionSubscriptionBinder.ts',
    'src/agent/runtime/ExecutionHandle.ts', 'src/agent/runtime/executeAgent.ts',
    'src/agent/runtime/AgentLaunchContext.ts', 'src/agent/runtime/StreamStatusService.ts',
    'src/agent/runtime/AgentRuntimeHost.ts', 'src/agent/runtime/SessionResumeRetrieval.ts',
    'src/agent/runtime/AgentFlowResult.ts', 'src/agent/runtime/agentToolResolution.ts',
  ] },
  { name: 'agent-internals', files: [
    'src/agent/modelHandlers/ModelHandler.ts', 'src/agent/modelHandlers/openai/modelHandlerOpenAI.ts',
    'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts', 'src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts',
    'src/agent/modelHandlers/google/modelHandlerGoogleGenAI.ts', 'src/agent/implementations/flows/tooluse/runToolUseFlow.ts',
    'src/agent/implementations/flows/tooluse/modelSwitchState.ts', 'src/agent/output/compileCheck.ts',
    'src/agent/output/compileFailureRoundContext.ts', 'src/agent/toolUse/FollowUpQueue.ts',
    'src/agent/toolUse/ToolUseFollowUp.ts', 'src/agent/toolUse/ToolUseFollowUpQueueManager.ts',
    'src/agent/core/flows/ToolUseCycleFlow.ts', 'src/agent/core/flows/RetryState.ts',
    'src/agent/storage/executionLifecycle.ts', 'src/agent/index/agentRegistry.ts',
  ] },
  { name: 'progressView', files: [
    'packages/extension/src/progressView/ProgressViewProvider.ts', 'packages/extension/src/progressView/ProgressViewMessageHandler.ts',
    'src/controllers/progressView/backend/ProgressBackend.ts', 'src/controllers/progressView/backend/WebviewBridge.ts',
    'src/controllers/progressView/ProgressViewCommandHandlers.ts', 'src/controllers/progressView/backend/state/ProgressViewState.ts',
    'src/controllers/progressView/backend/WebviewUpdater.ts',
  ] },
  { name: 'cli-runtime-commands', files: [
    'packages/cli/src/runtime/multiAgentPresets.ts', 'packages/cli/src/runtime/modelAccess.ts',
    'packages/cli/src/runtime/agents.ts', 'packages/cli/src/runtime/loginOptions.ts',
    'packages/cli/src/runtime/workflowInputs.ts', 'packages/cli/src/runtime/approvalEvents.ts',
    'packages/cli/src/runtime/history.ts', 'packages/cli/src/runtime/doctor.ts',
    'packages/cli/src/runtime/apiStatus.ts', 'packages/cli/src/runtime/orchestration.ts',
    'packages/cli/src/runtime/approvalAdapter.ts', 'packages/cli/src/runtime/cliConfig.ts',
    'packages/cli/src/commands/multiAgent.ts', 'packages/cli/src/commands/auth.ts',
    'packages/cli/src/commands/_helpers/dispatch.ts', 'packages/cli/src/commands/_helpers/globalArgs.ts',
    'packages/cli/src/commands/orchestrate.ts', 'packages/cli/src/commands/agentsRun.ts',
  ] },
  { name: 'tools', files: [
    'src/tools/lean/direct/jsonRpc.ts', 'src/tools/lean/direct/leanSession.ts', 'src/tools/lean/lspTypes.ts',
    'src/tools/plan/PlanTool.ts', 'src/tools/childStream.ts', 'src/tools/agentCliSessionRegistry.ts',
    'src/tools/subagentDeliveryState.ts', 'src/tools/codex.ts', 'src/tools/claudeAgent.ts',
    'src/tools/claudeAgentShared.ts', 'src/tools/workPlanGranularityFeedback.ts', 'src/tools/approval/proposalApproval.ts',
    'src/tools/approval/latexPreview.ts', 'src/tools/bash.ts', 'src/tools/ExecutionsTool.ts',
    'src/tools/DelegationTools.ts', 'src/tools/arxiv/ArxivSearchTool.ts', 'src/tools/citation/CrossrefSearchTool.ts',
  ] },
  { name: 'transcript-shared', files: [
    'src/transcript/StreamSnapshotStore.ts', 'src/transcript/streamSnapshotRead.ts',
    'src/transcript/streamDataPaths.ts', 'src/transcript/StreamLog.ts',
    'src/shared/schemas/streamSnapshot.ts', 'src/shared/schemas/streamData.ts',
    'src/shared/schemas/streamState.ts', 'src/shared/schemas/output.ts',
    'src/shared/streams/streamStatusDisplay.ts', 'src/shared/streams/streamMetadata.ts',
    'src/skills/skillSources.ts', 'src/skills/runtimeSkills.ts',
    'packages/desktop/src/main/desktopAgentExecution.ts', 'packages/cli/src/orchestration/runOrchestrationTui.tsx',
  ] },
]

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    batch: { type: 'string' },
    declarative: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          file: { type: 'string' },
          location: { type: 'string', description: 'function/symbol + line range' },
          pattern: { type: 'string', description: 'the imperative shape (switch ladder, if/else chain, repeated structural block, hardcoded sequence)' },
          proposal: { type: 'string', description: 'the declarative form: a module-level lookup table / data-driven map / config the code iterates' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          value: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string' },
        },
        required: ['file', 'location', 'pattern', 'proposal', 'risk', 'value', 'reason'],
      },
    },
    ssot: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['duplicated-constant', 'duplicated-type', 'duplicated-union', 'duplicated-logic', 'parallel-structure', 'schema-vs-interface', 'repeated-literal'] },
          symbol: { type: 'string', description: 'what is duplicated' },
          locations: { type: 'array', items: { type: 'string' }, description: 'every file:line where the duplicate appears (search the WHOLE repo)' },
          canonical: { type: 'string', description: 'where the single source of truth should live, and how consumers reference it' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          value: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string', description: 'why these are truly the same thing (not coincidentally-similar), and any semantic caveat' },
        },
        required: ['kind', 'symbol', 'locations', 'canonical', 'risk', 'value', 'reason'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['batch', 'declarative', 'ssot', 'notes'],
}

function buildPrompt(batch) {
  const { name, files } = batch
  return [
    `READ-ONLY analysis on the TeXRA repo. DO NOT EDIT ANY FILE. Return findings only via the structured output.`,
    ``,
    `Find two kinds of opportunity in these ${files.length} files (batch "${name}"), focused on code changed since v0.38.5 (use \`git diff v0.38.5..HEAD -- <file>\` plus the full current file):`,
    files.map((f) => `  - ${f}`).join('\n'),
    ``,
    `## 1. DECLARATIVE: imperative code that should be data-driven`,
    `- switch/if-else ladders whose branches differ only by data -> a module-level lookup table (Record / Map / tuple array) the code indexes or iterates.`,
    `- repeated near-identical blocks (JSX, event wiring, command/handler registration, option building) that vary only by a few values -> map over a config array.`,
    `- hardcoded ordered sequences (steps, columns, fields, status->label/icon/color) -> a single data table that the renderer/handler walks.`,
    `- behavior selected by a chain of boolean flags -> a discriminated config keyed by the case.`,
    `Note: earlier passes already converted several TUI/CLI ternaries to tables (apiStatus hints, status-bar segments, agent rows); look for what remains, INCLUDING backend (agent runtime, tools, progress view, model handlers).`,
    ``,
    `## 2. SINGLE SOURCE OF TRUTH: the same thing defined in more than one place`,
    `- the same constant / string literal / magic value written at multiple sites (esp. command names, status strings, keys, paths, channel names).`,
    `- the same TYPE or UNION restated in multiple files (incl. one file's union being a subset/superset of another's), or an inline structural type duplicating a named one.`,
    `- a Zod SCHEMA and a hand-written interface/type that describe the same shape but can drift (schema-vs-interface): the type should be \`z.infer\` of the schema.`,
    `- parallel data structures that encode the same domain knowledge in two shapes (e.g. an array of ids AND a Record keyed by those ids; a list of cases AND a switch over them) that must be kept in sync by hand.`,
    `- duplicated derivation/validation/formatting logic (the same computation implemented in two places).`,
    `For each, list EVERY occurrence (grep/ripgrep the whole repo: src/, packages/, test-kernel/), name where the single canonical definition should live, and how consumers reference it.`,
    ``,
    `## Judgment`,
    `- Only report TRUE duplicates / genuine declarative wins. Two things that look similar but are semantically distinct and free to evolve independently are NOT SSOT violations (say so if you considered and rejected one).`,
    `- Flag a semantic caveat when consolidation requires a naming/ownership decision (e.g. two unions that are equal today but model different concepts).`,
    `- Prefer high-value, low-risk, behavior-preserving changes. Note when a declarative rewrite would change evaluation order / short-circuit semantics (then it is NOT safe).`,
    `- It is fine to return empty arrays. Be precise with file:line locations.`,
    ``,
    `Read-only tools only: git diff/show/log, ripgrep/grep, file reads. Make NO edits. Return the structured findings.`,
  ].join('\n')
}

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

phase('Detect')
log(`Declarative+SSOT detection across ${BATCHES.reduce((n, b) => n + b.files.length, 0)} files, ${BATCHES.length} batches, 5-wide pool`)

const results = await runPool(BATCHES, 5, (batch) =>
  agent(buildPrompt(batch), { label: `detect:${batch.name}`, phase: 'Detect', schema: SCHEMA })
    .then((r) => r || { batch: batch.name, declarative: [], ssot: [], notes: 'agent returned null' }),
)

const dec = results.flatMap((r) => (r.declarative || []).map((c) => ({ ...c, batch: r.batch })))
const ssot = results.flatMap((r) => (r.ssot || []).map((c) => ({ ...c, batch: r.batch })))
log(`Detection done: ${dec.length} declarative candidates, ${ssot.length} SSOT candidates`)
return { results, declarative: dec, ssot }
