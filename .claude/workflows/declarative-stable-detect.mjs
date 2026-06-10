export const meta = {
  name: 'declarative-stable-detect',
  description: 'Read-only detection of imperative->declarative opportunities in STABLE code (pre-0.38.5 hotspots)',
  phases: [{ title: 'Detect', detail: 'analyze switch/if-else hotspots; flag table candidates with test coverage' }],
}

const BATCHES = [
  { name: 'commands-keymap', files: [
    'src/shared/commands/accelerators.ts',
    'packages/extension/src/commands/history/chatExportFormatter.ts',
    'packages/extension/src/commands/latex/latexHousekeepingNotifications.ts',
  ] },
  { name: 'model-handlers', files: [
    'src/agent/modelHandlers/openrouter/modelHandlerOpenRouterNative.ts',
    'src/agent/modelHandlers/anthropic/modelHandlerAnthropic.ts',
    'src/agent/modelHandlers/support/AnthropicStreamHandler.ts',
  ] },
  { name: 'transcript-tui', files: [
    'src/transcript/TexraTranscriptRecorder.ts',
    'packages/cli/src/chat/tui/panes/TodosPlanPanel.tsx',
    'packages/cli/src/chat/tui/state/subscribeRuntimeHost.ts',
  ] },
  { name: 'progress-formatters', files: [
    'packages/extension/src/progressView/frontend/formatters/logFormatters/toolFormatters.ts',
    'packages/extension/src/progressView/frontend/components/TaskGroupList.ts',
    'packages/extension/src/progressView/frontend/components/RequestPanelsState.ts',
    'packages/extension/src/progressView/frontend/components/TexraDiffView.ts',
  ] },
  { name: 'tools-desktop', files: [
    'src/tools/memory/MemoryTool.ts',
    'src/tools/github/githubSubscriptionTool.ts',
    'src/tools/lean/direct/directLspAdapter.ts',
    'packages/desktop/src/main/desktopShellIpc.ts',
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
        type: 'object', additionalProperties: false,
        properties: {
          file: { type: 'string' },
          location: { type: 'string', description: 'function/symbol + line range' },
          pattern: { type: 'string', description: 'the imperative shape: switch ladder mapping cases to values, if/else chain, repeated near-identical blocks, hardcoded sequence' },
          proposal: { type: 'string', description: 'the declarative form: a module-level lookup table / Record / data array the code indexes or iterates' },
          testCoverage: { type: 'string', description: 'name the vitest/test file + cases that exercise this code, or "none found" after searching test-kernel/ and src/test/' },
          behaviorNote: { type: 'string', description: 'why the rewrite is exactly behavior-preserving (same outputs, ordering, fallthrough/default, short-circuit)' },
          risk: { type: 'string', enum: ['low', 'medium', 'high'] },
          value: { type: 'string', enum: ['low', 'medium', 'high'] },
          recommend: { type: 'string', enum: ['apply', 'propose', 'keep'] },
        },
        required: ['file', 'location', 'pattern', 'proposal', 'testCoverage', 'behaviorNote', 'risk', 'value', 'recommend'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['batch', 'candidates', 'notes'],
}

function buildPrompt(batch) {
  const { name, files } = batch
  return [
    `READ-ONLY analysis on the TeXRA repo. DO NOT EDIT ANY FILE. Return findings only via the structured output.`,
    ``,
    `These are STABLE, well-tested files (they predate the recent refactor work). Find imperative code that would genuinely read better as DECLARATIVE data, in batch "${name}":`,
    files.map((f) => `  - ${f}`).join('\n'),
    ``,
    `## What to look for`,
    `- a switch / if-else ladder whose arms map a discriminant to a VALUE (label, icon, color, message, config) and differ only by data -> a module-level lookup table (Record / Map / tuple array) the code indexes.`,
    `- repeated near-identical blocks (JSX, event wiring, command/handler registration, push({...}) sequences) varying only by a few values -> map over a config array.`,
    `- a hardcoded ordered sequence (steps, columns, fields, status->display) -> one data table the renderer/handler walks.`,
    `- behavior selected by a chain of boolean flags -> a discriminated config keyed by the case.`,
    ``,
    `## Reject (recommend "keep") when the switch/ladder is NOT a value map`,
    `- each arm runs DISTINCT logic (side effects, different control flow, early returns, awaits) rather than producing a value.`,
    `- the arms call different functions with different signatures (a dispatch that a table would obscure or de-type).`,
    `- converting would lose exhaustiveness checking (assertNever) or discriminated-union payload type-narrowing.`,
    `- converting would change evaluation order, short-circuit, or fallthrough semantics.`,
    `A legitimate switch is fine; only flag genuine value-maps and clean data-driven wins.`,
    ``,
    `## Homework per candidate (this is stable code, so be rigorous)`,
    `- exact file + function + line range.`,
    `- the proposed table shape and how the call site indexes it.`,
    `- SEARCH for tests that exercise it: ripgrep the symbol/behavior across src/test-kernel/ and src/test/; name the test file + cases, or say "none found".`,
    `- a concrete behavior-preservation argument (same outputs for every input, same ordering, same default).`,
    `- risk, value, and a recommendation: "apply" (high-confidence, behavior-preserving, ideally test-covered), "propose" (good but worth human sign-off), or "keep".`,
    ``,
    `Prefer high-value, low-risk, test-covered wins. It is fine to return zero candidates for a file whose switches are all legitimate. Read-only tools only (git/grep/file reads); make NO edits.`,
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
log(`Stable declarative detection: ${BATCHES.reduce((n, b) => n + b.files.length, 0)} hotspot files, ${BATCHES.length} batches`)

const results = await runPool(BATCHES, 5, (batch) =>
  agent(buildPrompt(batch), { label: `detect:${batch.name}`, phase: 'Detect', schema: SCHEMA })
    .then((r) => r || { batch: batch.name, candidates: [], notes: 'agent returned null' }),
)

const all = results.flatMap((r) => (r.candidates || []).map((c) => ({ ...c, batch: r.batch })))
const apply = all.filter((c) => c.recommend === 'apply')
log(`Detection done: ${all.length} candidates (${apply.length} recommend apply)`)
return { results, candidates: all }
