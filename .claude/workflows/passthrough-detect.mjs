export const meta = {
  name: 'passthrough-detect',
  description: 'Read-only detection of collapsible pass-through / delegation methods in source changed since v0.38.5',
  phases: [{ title: 'Detect', detail: 'one analysis agent per batch, returns pass-through candidates + callers' }],
}

const BATCHES = [
  { name: 'tui', files: [
    'packages/cli/src/chat/tui/runChatTui.tsx',
    'packages/cli/src/chat/tui/App.tsx',
    'packages/cli/src/chat/tui/commands/registerBuiltins.tsx',
    'packages/cli/src/chat/tui/state/streamViews.ts',
    'packages/cli/src/chat/tui/state/cliState.ts',
    'packages/cli/src/chat/tui/state/childControls.ts',
    'packages/cli/src/chat/tui/state/subscribeApprovals.ts',
    'packages/cli/src/chat/tui/state/approvalQueue.ts',
    'packages/cli/src/chat/tui/panes/TranscriptEntry.tsx',
    'packages/cli/src/chat/tui/panes/StaticConversationTranscript.tsx',
    'packages/cli/src/chat/tui/panes/StatusBar.tsx',
    'packages/cli/src/chat/tui/panes/ConversationPane.tsx',
    'packages/cli/src/chat/tui/panes/StreamTabsStrip.tsx',
    'packages/cli/src/chat/tui/forms/SkillsListForm.tsx',
    'packages/cli/src/chat/tui/forms/ModelListForm.tsx',
    'packages/cli/src/chat/tui/forms/AgentListForm.tsx',
    'packages/cli/src/chat/tui/forms/_shared/useAsyncListForm.ts',
    'packages/cli/src/chat/tui/input/BaseTextInput.tsx',
    'packages/cli/src/chat/tui/input/inputKeys.ts',
    'packages/cli/src/chat/tui/input/textInputEditing.ts',
  ] },
  { name: 'agent-runtime', files: [
    'src/agent/runtime/executionRegistry.ts',
    'src/agent/runtime/ModelFactory.ts',
    'src/agent/runtime/ProcessOutputPoller.ts',
    'src/agent/runtime/AgentRunLifecycle.ts',
    'src/agent/runtime/runCoordinators.ts',
    'src/agent/runtime/ExecutionSubscriptionBinder.ts',
    'src/agent/runtime/ExecutionHandle.ts',
    'src/agent/runtime/executeAgent.ts',
    'src/agent/runtime/AgentLaunchContext.ts',
    'src/agent/runtime/StreamStatusService.ts',
    'src/agent/runtime/InterruptRegistry.ts',
    'src/agent/runtime/AgentRuntimeHost.ts',
    'src/agent/runtime/SessionResumeRetrieval.ts',
    'src/agent/runtime/agentToolResolution.ts',
    'src/agent/runtime/toolInjection.ts',
    'src/agent/runtime/idleContinuation.ts',
  ] },
  { name: 'agent-internals', files: [
    'src/agent/modelHandlers/ModelHandler.ts',
    'src/agent/implementations/flows/tooluse/runToolUseFlow.ts',
    'src/agent/output/compileCheck.ts',
    'src/agent/implementations/flows/reflection/nodes/OutputNode.ts',
    'src/agent/output/compileFailureRoundContext.ts',
    'src/agent/toolUse/FollowUpQueue.ts',
    'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts',
    'src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts',
    'src/agent/modelHandlers/openai/modelHandlerOpenAI.ts',
    'src/agent/toolUse/ToolUseFollowUp.ts',
    'src/agent/toolUse/ToolUseFollowUpQueueManager.ts',
    'src/agent/core/flows/RetryState.ts',
    'src/agent/core/flows/ToolUseCycleFlow.ts',
    'src/agent/modelHandlers/google/modelHandlerGoogleGenAI.ts',
    'src/agent/storage/executionLifecycle.ts',
    'src/agent/index/agentRegistry.ts',
  ] },
  { name: 'progressView', files: [
    'packages/extension/src/progressView/ProgressViewProvider.ts',
    'packages/extension/src/progressView/ProgressViewMessageHandler.ts',
    'src/controllers/progressView/backend/ProgressBackend.ts',
    'src/controllers/progressView/backend/WebviewBridge.ts',
    'src/controllers/progressView/ProgressViewCommandHandlers.ts',
    'src/controllers/progressView/backend/state/ProgressViewState.ts',
    'src/controllers/progressView/backend/WebviewUpdater.ts',
  ] },
  { name: 'cli-runtime-commands', files: [
    'packages/cli/src/runtime/multiAgentPresets.ts',
    'packages/cli/src/runtime/modelAccess.ts',
    'packages/cli/src/runtime/agents.ts',
    'packages/cli/src/runtime/loginOptions.ts',
    'packages/cli/src/runtime/workflowInputs.ts',
    'packages/cli/src/runtime/approvalEvents.ts',
    'packages/cli/src/runtime/history.ts',
    'packages/cli/src/runtime/doctor.ts',
    'packages/cli/src/runtime/orchestration.ts',
    'packages/cli/src/runtime/sessionResume.ts',
    'packages/cli/src/runtime/approvalAdapter.ts',
    'packages/cli/src/commands/multiAgent.ts',
    'packages/cli/src/commands/auth.ts',
    'packages/cli/src/commands/_helpers/dispatch.ts',
    'packages/cli/src/commands/_helpers/globalArgs.ts',
    'packages/cli/src/commands/history.ts',
    'packages/cli/src/commands/orchestrate.ts',
    'packages/cli/src/commands/agentsRun.ts',
    'packages/cli/src/commands/agents.ts',
  ] },
  { name: 'tools', files: [
    'src/tools/lean/direct/jsonRpc.ts',
    'src/tools/plan/PlanTool.ts',
    'src/tools/childStream.ts',
    'src/tools/agentCliSessionRegistry.ts',
    'src/tools/subagentDeliveryState.ts',
    'src/tools/codex.ts',
    'src/tools/claudeAgent.ts',
    'src/tools/workPlanGranularityFeedback.ts',
    'src/tools/approval/proposalApproval.ts',
    'src/tools/claudeAgentShared.ts',
    'src/tools/bash.ts',
    'src/tools/ExecutionsTool.ts',
    'src/tools/DelegationTools.ts',
    'src/tools/arxiv/ArxivSearchTool.ts',
    'src/tools/lean/direct/leanSession.ts',
    'src/tools/inquiry/inquiryContinuation.ts',
    'src/tools/EditTool.ts',
    'src/tools/citation/CrossrefSearchTool.ts',
    'src/tools/todo/TodoTool.ts',
    'src/tools/ReadTool.ts',
  ] },
  { name: 'desktop-shared', files: [
    'packages/desktop/src/main/desktopAgentExecution.ts',
    'packages/desktop/src/main/desktopAgentResume.ts',
    'packages/desktop/src/main/platform/index.ts',
    'packages/desktop/src/main/index.ts',
    'src/transcript/StreamSnapshotStore.ts',
    'src/transcript/streamSnapshotRead.ts',
    'src/shared/streams/streamStatusDisplay.ts',
    'src/shared/streams/streamMetadata.ts',
    'src/skills/skillSources.ts',
    'src/skills/runtimeSkills.ts',
    'packages/extension/src/webview/frontend/MainApp.ts',
    'packages/cli/src/orchestration/runOrchestrationTui.tsx',
    'packages/extension/src/commands/agent/resumeFromSnapshot.ts',
    'packages/extension/src/commands/agent/resumeCommand.ts',
  ] },
]

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    batch: { type: 'string' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          symbol: { type: 'string', description: 'the pass-through method/function name and its enclosing class/module' },
          kind: { type: 'string', enum: ['method-passthrough', 'function-wrapper', 'one-call-factory', 'reexport-facade'] },
          forwardsTo: { type: 'string', description: 'the single call it forwards to, verbatim' },
          callers: { type: 'array', items: { type: 'string' }, description: 'file:line of every caller found via grep; use "internal-only" if only called within its own file; "none" if dead' },
          recommendation: { type: 'string', enum: ['collapse', 'keep'] },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          reason: { type: 'string', description: 'why collapse is safe (or why keep: interface contract, test seam, DI boundary, semantic naming, port indirection, etc.)' },
        },
        required: ['file', 'symbol', 'kind', 'forwardsTo', 'callers', 'recommendation', 'risk', 'reason'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['batch', 'candidates', 'notes'],
}

function buildPrompt(batch) {
  const { name, files } = batch
  return [
    `READ-ONLY analysis task on the TeXRA repo. DO NOT EDIT ANY FILE. Return findings only via the structured output.`,
    ``,
    `Hunt for collapsible PASS-THROUGH / DELEGATION code in these ${files.length} files (batch "${name}"), focusing on code changed since the v0.38.5 tag (inspect with \`git diff v0.38.5..HEAD -- <file>\`, but you may flag a pass-through even if it predates the tag as long as it sits in one of these files):`,
    files.map((f) => `  - ${f}`).join('\n'),
    ``,
    `## What counts as a pass-through (the repo's "Flattening abstraction layers" smell)`,
    `- method-passthrough: a class/object method whose body is essentially \`return this.inner.foo(...sameArgs)\` (or \`this.inner.foo(...)\` with no return value), adding no logic, validation, transform, or error handling.`,
    `- function-wrapper: a free function that only forwards to another function/helper with the same (or trivially reordered) args and returns its result. Includes a wrapper that only "creates state + runs a flow + returns its result".`,
    `- one-call-factory: a factory called from exactly ONE site that just constructs and returns an object/closure (the repo's discouraged-factory rule).`,
    `- reexport-facade: a module that only re-exports symbols from elsewhere with no added value, forcing consumers to hop through an extra layer.`,
    ``,
    `## For EACH candidate, do the homework`,
    `- Identify the exact single call it forwards to.`,
    `- Find ALL callers across the WHOLE repo with grep/ripgrep (search src/, packages/, and test-kernel/). List them as file:line. Mark "internal-only" if the symbol is private/used only within its own file, "none" if it appears dead.`,
    `- Recommend collapse vs keep, with a risk level and a concrete reason.`,
    ``,
    `## Recommend KEEP (not a real win) when the indirection is load-bearing`,
    `- It satisfies an interface / abstract method / port (e.g. a Platform port, host capability, PocketFlow Node hook) — the indirection IS the contract.`,
    `- It is a documented dependency-injection / test seam with direct unit tests (TuiStateAndFocus, SlashRegistry, etc.).`,
    `- It crosses a platform boundary deliberately (VS Code-free core forwarding to a host port).`,
    `- It has many callers across many files (collapsing would be a broad, risky churn, not a clean win) — flag it but recommend keep unless it is genuinely dead or single-call.`,
    `- The name documents intent at the call site in a way the target's name does not.`,
    ``,
    `Prefer high-confidence, low-risk, few-caller collapses. It is fine to return zero candidates. Be precise: a method that adds ANY logic beyond forwarding is NOT a pass-through.`,
    ``,
    `Read-only tools only: git diff/show/log, ripgrep/grep, file reads. Make NO edits and run NO state-changing commands. Return the structured findings.`,
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
log(`Pass 4 detection: scanning ${BATCHES.reduce((n, b) => n + b.files.length, 0)} files across ${BATCHES.length} batches for pass-through methods, 5-wide pool`)

const results = await runPool(BATCHES, 5, (batch) =>
  agent(buildPrompt(batch), {
    label: `detect:${batch.name}`,
    phase: 'Detect',
    schema: SCHEMA,
  }).then((r) => r || { batch: batch.name, candidates: [], notes: 'agent returned null (skipped or failed)' }),
)

const all = results.flatMap((r) => (r.candidates || []).map((c) => ({ ...c, batch: r.batch })))
const collapse = all.filter((c) => c.recommendation === 'collapse')
log(`Pass 4 detection done: ${all.length} pass-through candidates, ${collapse.length} recommended for collapse`)
return { results, collapseCandidates: collapse }
