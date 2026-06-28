/**
 * `@texra/core` — the curated public surface of the TeXRA agent core.
 *
 * Single entry point a host (the VS Code extension, the CLI, the Electron
 * desktop app, or a future embedder) depends on — like one SDK package —
 * instead of deep `@agent/*` / `@platform` imports into internals.
 *
 * Minimal usage:
 *
 *   import { initPlatform, validateExecutionRequest, runAgent } from '@texra/core';
 *   initPlatform(services);                       // once, at startup
 *   const v = validateExecutionRequest({ config });
 *   if (v.valid) await runAgent(v.request, { runtimeHost });
 *
 * For per-chunk streaming/lifecycle callbacks or subagent lineage, use the
 * lower-level `runAgentStream` engine instead of `runAgent`.
 *
 * Everything re-exported here is host-neutral (VS Code-free): the package
 * typechecks with only `@types/node`, so a `vscode` dependency leaking into the
 * surface fails the build. Deep `@agent/*` imports still work and are not being
 * migrated in bulk; this module is the curated entry, adopted incrementally.
 */

// ── 1. Platform composition root ──
// Hosts call initPlatform() once at startup; core reads services via platform().
export {
  initPlatform,
  platform,
  tryPlatform,
  tryGlobalState,
  type Platform,
} from '@platform/platform';

// ── 2. Agent configuration & identity ──
export {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
export { AgentCategory } from '@agent/core/definition/AgentDataclass';
export type { ExecutionId } from '@shared/schemas';

// ── 3. Building a run request (host → core contract) ──
// `validateExecutionRequest` is the non-throwing {valid,message} variant UI
// hosts use; headless callers may AgentConfigSchema.parse(...) and build a
// ValidatedExecutionRequest directly.
export {
  validateExecutionRequest,
  type ExecutionRequest,
  type ValidatedExecutionRequest,
  type ExecutionValidationResult,
} from '@agent/core/execution/executionRequests';

// ── 4. Running an agent ──  (the section to read first)
/**
 * START HERE. The high-level entry every host uses: defaults the executionId,
 * applies register-on-fresh / reuse-on-resume, runs the agent, and (for a
 * workflow result) invokes openWorkflowOutput. Use this unless you need
 * streaming callbacks or subagent lineage.
 */
export { runAgent, type RunAgentOptions } from '@agent/runtime/runAgent';
/**
 * Lower-level streaming/lineage dispatcher behind runAgent. Use ONLY for
 * per-chunk streaming/lifecycle callbacks (onStreamResolved/onProgress/
 * onCompleted/onError) or subagent lineage (isSubagent/parentStreamId/
 * delegationDepth) — the caller owns executionId and registerExecution.
 */
export {
  executeAgent as runAgentStream,
  type ExecuteAgentOptions,
} from '@agent/runtime/executeAgent';
export {
  type AgentFlowResult,
  AgentFlowResultSchema,
} from '@agent/runtime/AgentFlowResult';
/**
 * @deprecated Prefer `AgentFlowResult` and narrow on `category === 'workflow'`.
 * This named category type remains as a compatibility adapter for existing SDK
 * consumers while the public result surface converges on the union.
 */
export type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
// Per-run control handle (F-2): the run's live handle, exposed via `onRun`.
// Its `.result` promise settles with the terminal `ResultEvent` (always
// resolves), and `.trace` is the run's discriminated-event channel.
export { type AgentRunHandle } from '@agent/runtime/executionRegistry';

// ── 5. Host port (consumer-injected progress-event sink) ──
export {
  type AgentRuntimeHost,
  noopAgentRuntimeHost,
} from '@hosts/AgentRuntimeHost';

// ── 5b. Session ownership (per-session runtime-state container) ──
// One owner per session for interrupt / execution / coordinator / subscription
// state plus the trace flusher set. `defaultSession` wraps the existing
// process singletons by identity (behavior-neutral); hosts that need isolation
// construct their own `new SessionHandle({ hostChannel })`.
export {
  SessionHandle,
  defaultSession,
  type SessionHandleInit,
} from '@agent/runtime/SessionHandle';

// ── 6. Telemetry: the AgentTrace discriminated-event channel ──
// SDK consumers attach their own subscriber via trace.subscribe(...).
export {
  type AgentTrace,
  type AgentTraceSubscriber,
  type AgentEvent,
  type ResultEvent,
  TraceEmitter,
  noopTrace,
} from '@agent/trace';
// `ResultEvent`'s member types, so consumers can name the discriminant of
// `event.error.kind` and the `usage` shape without deep internal imports.
export type { AgentErrorKind } from '@common/errors';
export type { RunUsageTotals } from '@agent/core/usage/RunUsageAccumulator';

// ── 7. Agent registry (discover/resolve agent definitions) ──
export {
  loadAgents,
  getAgent,
  resolveAgent,
  getAgentsByCategory,
  type AgentEntry,
  type ResolvedAgent,
} from '@agent/index';

// ── 8. Execution storage (per-run KV + history) ──
// registerExecution is normally handled by runAgent; call it directly only
// when bypassing the wrapper (e.g. a custom streaming host on runAgentStream).
export {
  getExecutionStore,
  registerExecution,
  listExecutions,
  deleteExecution,
  type ExecutionKVStore,
  type ExecutionListingEntry,
} from '@agent/storage';
