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
 */
export { harnessBuiltins } from '@tools/builtinPlugins';
/** The name of the `multiAgent` plugin's tool, which runs a named agent as
 *  a child of the calling run: an agent whose tools name it orchestrates. */
export { AGENT_TOOL_NAME } from '@shared/constants/delegationTools';
/** The `web` plugin's fetch tool, typed with what its call requires, for a
 *  host that calls it outside a run (the editor's Copilot tools). */
export { WebFetchTool } from '@tools/web/WebFetchTool';
export { callerRun, requireRun } from '@agent/runtime/RunCall';
export {
  ChildRuns,
  type PluginToolServices,
} from '@agent/runtime/ToolServices';
export type { RunInbox } from '@agent/followUp/ToolUseFollowUp';
export type { ToolRun } from '@agent/core/tools/ToolTypes';
export { HostCapabilities } from '@agent/runtime/agentToolResolution';
export {
  agentBlockOf,
  type AgentBlock,
  type AgentBlockResult,
  type RecipeChange,
} from '@tools/toolTable';
