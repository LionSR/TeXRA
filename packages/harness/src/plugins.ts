/**
 * `@texra-ai/harness/plugins`: the harness's built-in plugins, as the values
 * an embedder lists for `Sessions.layer({ platform, plugins })`.
 * `harnessBuiltins.all` is every built-in; `harnessBuiltins.minimal` only
 * files and the shell. An embedder adds its own plugins beside them.
 *
 * A plugin's tool reads the run its call works for through `ToolContext`:
 * `requireRun` (the run, or the shared refusal) and `callerRun` (the run,
 * if any), typed `ToolRun`. A plugin's tool may require `PluginToolServices`
 * (never the harness's own call services) and launches a child agent
 * through `ChildRuns`.
 */
export { harnessBuiltins } from '@tools/builtinPlugins';
export { callerRun, requireRun } from '@agent/runtime/RunCall';
export type { ToolRun } from '@agent/core/tools/ToolTypes';
export {
  ChildRuns,
  type PluginToolServices,
} from '@agent/runtime/ToolServices';
