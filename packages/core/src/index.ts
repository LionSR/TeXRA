/**
 * `@texra/core` — the curated public surface of the TeXRA agent core.
 *
 * This is the single entry point a host (the VS Code extension, the CLI, the
 * Electron desktop app, or a future embedder) should depend on, analogous to a
 * single SDK package: import the run entry, the typed config/result, the
 * injected host port, the telemetry channel, the agent registry, and the
 * platform composition root from here — not via deep `@agent/*` / `@platform`
 * path aliases into internals.
 *
 * Everything re-exported here is host-neutral (VS Code-free): this package
 * typechecks with only `@types/node`, so a `vscode` dependency leaking into the
 * surface fails the build. The set is a subset of what `@texra-ai/cli` already
 * imports, which is what guarantees it stays Node-importable.
 *
 * NOTE: deep `@agent/*` imports still work and are not being migrated in bulk
 * (that is intentionally out of scope). This module establishes the curated
 * surface; steering existing call sites onto it can follow incrementally.
 */

// ── Platform composition root + service contract ──
// Hosts call initPlatform() once at startup with their concrete services;
// core code reads them via platform().
export {
  initPlatform,
  platform,
  tryPlatform,
  tryGlobalState,
  type Platform,
} from '@platform/platform';

// ── Agent configuration & category ──
export {
  AgentConfigSchema,
  type AgentConfig,
  type AgentConfigPayload,
} from '@agent/core/AgentConfig';
export { AgentCategory } from '@agent/core/AgentDataclass';

// ── Execution-request validation (host → core contract) ──
// `validateExecutionRequest` is the non-throwing {valid,message} variant UI
// hosts use; headless callers may parse with AgentConfigSchema directly.
export {
  validateExecutionRequest,
  type ExecutionRequest,
  type ValidatedExecutionRequest,
  type ExecutionValidationResult,
} from '@agent/core/executionRequests';

// ── Run entry points ──
export { executeAgent, getAgentPath } from '@agent/runtime/executeAgent';
export {
  runValidatedExecutionRequest,
  type RunExecutionRequestOptions,
} from '@agent/runtime/runExecutionRequest';
export {
  type AgentFlowResult,
  AgentFlowResultSchema,
} from '@agent/runtime/AgentFlowResult';

// ── Host port (injected by the consumer; receives progress events) ──
export {
  type AgentRuntimeHost,
  noopAgentRuntimeHost,
} from '@agent/runtime/AgentRuntimeHost';

// ── Telemetry: the AgentTrace discriminated-event channel ──
// SDK consumers attach their own subscriber via trace.subscribe(...).
export {
  type AgentTrace,
  type AgentTraceSubscriber,
  type AgentEvent,
  TraceEmitter,
  noopTrace,
} from '@agent/trace';

// ── Agent registry (discover/resolve agent definitions) ──
export {
  loadAgents,
  getAgent,
  resolveAgent,
  getWorkflowAgents,
  getToolUseAgents,
  type AgentEntry,
  type ResolvedAgent,
} from '@agent/index';

// ── Execution storage (per-run KV + history) ──
export {
  getExecutionStore,
  registerExecution,
  listExecutions,
  deleteExecution,
  type ExecutionKVStore,
  type ExecutionListingEntry,
} from '@agent/storage';
