/**
 * `@texra-ai/harness/plugins`: the harness's built-in plugins, as the values
 * an embedder lists for `Sessions.layer({ platform, plugins })`.
 * `harnessBuiltins` is every built-in. An embedder adds its own plugins
 * beside them.
 *
 * A plugin's tool reads the run its call works for through `ToolContext`:
 * `requireRun` (the run, or the shared refusal) and `callerRun` (the run,
 * if any), typed `ToolRun`. A plugin's tool may require `PluginToolServices`
 * (never the harness's own call services), and reaches the session's runs
 * only through `ChildRuns`: it launches a child, and sends a run its input
 * (`RunInbox`). A plugin that owns a block of an agent file (`AgentBlock`)
 * reads an agent's block with `agentBlockOf`.
 *
 * An app defines a plugin with `definePlugin`; its tools return `executed` or
 * `errorResult`, give an omitted input field its default with
 * `nullishWithDefault`, and resolve a path the model names against the
 * call's roots with `resolveToolPath`. A plugin's process services are its
 * `ProcessPluginLayer`; work that outlives its step holds the session layer
 * with `PluginHold`; a plugin that records the decisions on a request kind
 * is that kind's `RequestDecisionHook`. The process's plugin table is the
 * `ToolRegistry` service. A tool refuses a call by failing with `ToolError`;
 * `fileOps` takes the `WriteFilter` its `write_file` applies.
 */
export {
  codemode,
  fileOps,
  goal,
  harnessBuiltins,
  memoryWorkflow,
  multiAgent,
  web,
} from '@tools/builtinPlugins';
/** The name of the `multiAgent` plugin's tool, which runs a named agent as
 *  a child of the calling run: an agent whose tools name it orchestrates. */
export { AGENT_TOOL_NAME } from '@shared/constants/delegationTools';
export {
  definePlugin,
  type PluginArm,
  type PluginDefinition,
  type PluginRow,
} from '@tools/plugins';
export type { WriteFilter } from '@tools/WriteTool';
export {
  agentBlockOf,
  PluginHold,
  ToolRegistry,
  type AgentBlock,
  type AgentBlockResult,
  type ProcessPluginLayer,
  type RecipeChange,
  type RequestDecisionHook,
} from '@tools/toolTable';
export { errorResult, executed } from '@tools/core/result';
export { ToolError } from '@shared/schemas';
export { nullishWithDefault } from '@tools/core/inputSchema';
export {
  assertNoParentTraversal,
  parseWorkingDirectory,
  resolveToolPath,
  type ToolPathCall,
  type ToolPathResolution,
  type WorkspacePathResolution,
} from '@tools/pathResolution';
/** The `web` plugin's fetch tool, typed with what its call requires, for a
 *  host that calls it outside a run (the editor's Copilot tools). */
export { WebFetchTool } from '@tools/web/WebFetchTool';
// The memory tool's tree as a host reads and edits it outside a run, over
// the session's storage view.
export {
  MemoryStore,
  type MemoryPinResult,
  type MemoryPreview,
} from '@tools/memory/memoryStore';
export type { MemoryViewItem } from '@shared/tools/memoryView';
export { callerRun, requireRun } from '@agent/runtime/RunCall';
export {
  ChildRuns,
  type PluginToolServices,
} from '@agent/runtime/ToolServices';
export type { RunInbox } from '@agent/followUp/ToolUseFollowUp';
export type { ToolRun } from '@agent/core/tools/ToolTypes';
export { HostCapabilities } from '@agent/runtime/agentToolResolution';
// The harness's retry policy: which HTTP statuses are worth retrying, the
// randomized exponential backoff `Schedule` its fetches retry on, and the
// capped, jittered delay a caller that sleeps for itself waits.
export { jitteredExponentialBackoffMs } from '@utils/core';
export { randomizedExponentialBackoff } from '@utils/core/backoffSchedule';
export { isTransientHttpStatus } from '@utils/core/httpStatus';
// The capability a root launch requires (`ToolRun`'s session names it): a
// composition root's alone, so no plugin's tool is given it. Hosts open
// sessions through `Sessions` (root).
export type { SessionOwner } from '@platform/processRuntime';
