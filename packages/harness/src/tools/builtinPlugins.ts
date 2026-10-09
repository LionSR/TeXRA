/**
 * The harness's built-in plugins: files and the shell, the web, memory and
 * tasks, goal mode, child agents and code mode. An app lists them beside its
 * own (`@tools/registry` for TeXRA); `harnessBuiltins.all` is every one with
 * no app options, and `harnessBuiltins.minimal` only files and the shell: a
 * complete harness whose other tools are absent.
 */

// Local imports
import type { CodeSandbox } from '@agent/codeSandbox/codeSandbox';
import type { RuntimeTool } from '@agent/runtime/ToolServices';
import { AGENT_TOOL_NAME } from '@shared/constants/delegationTools';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import { GOAL_STATE_ARM } from '@shared/plugins/goal';
import { BashTool } from '@tools/bash';
import { codeSandboxLayer, ScriptTool } from '@tools/codemode/ScriptTool';
import { agentTool } from '@tools/delegation/AgentTool';
import { EditFileTool } from '@tools/EditTool';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { GlobTool } from '@tools/glob';
import { goalContinuation } from '@tools/goal/goalContinuation';
import { GrepTool } from '@tools/grep';
import { MemoryTool } from '@tools/memory/MemoryTool';
import { memoryPromptSection } from '@tools/memory/memoryPromptSection';
import { PlanTool } from '@tools/plan/PlanTool';
import type { PluginDefinition, Plugin } from '@tools/plugins';
import { ReadFileTool } from '@tools/ReadTool';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { WebFetchTool } from '@tools/web/WebFetchTool';
import { WebSearchTool } from '@tools/web/WebSearchTool';
import { writeFileTool, type WriteFilter } from '@tools/WriteTool';

const fileTools = (writeFilter?: WriteFilter) => ({
  bash: BashTool,
  read_file: ReadFileTool,
  write_file: writeFileTool(writeFilter),
  edit_file: EditFileTool,
  glob: GlobTool,
  grep: GrepTool,
});

const SCRIPT_TOOLS = { script: ScriptTool };

/**
 * A built-in plugin: as a plugin's definition, but its tools may read the
 * call's place in its run (`RunCall`) and its script, which the run loop
 * provides to every call and no app's tool may require.
 */
const builtin = <ROut = never>(
  plugin: Omit<PluginDefinition<ROut>, 'tools'> & {
    readonly tools?: Readonly<Record<string, RuntimeTool<Error, unknown>>>;
  },
  // cast: erased; the run loop serves every built-in its call services.
): Plugin => plugin as unknown as Plugin;

/**
 * Compile-time guard: every canonical tool with specialized display
 * treatment is a built-in, so every list that includes the built-ins
 * registers it.
 */
type AssertNever<T extends never> = T;
type _CanonicalDisplayNamesAreBuiltIns = AssertNever<
  Exclude<
    CanonicalToolDisplayName,
    keyof ReturnType<typeof fileTools> | keyof typeof SCRIPT_TOOLS
  >
>;

/** Files and the shell: every agent needs them. An app passes the filter
 *  `write_file` applies to what it writes (TeXRA's `.tex` replacements). */
export const fileOps = (
  options: { readonly writeFilter?: WriteFilter } = {},
): Plugin =>
  builtin({
    id: 'file-ops',
    tools: fileTools(options.writeFilter),
  });

export const web: Plugin = builtin({
  id: 'web',
  tools: { web_search: WebSearchTool, web_fetch: WebFetchTool },
});

export const memoryWorkflow: Plugin = builtin({
  id: 'memory-workflow',
  tools: {
    memory: MemoryTool,
    executions: ExecutionsTool,
  },
  injectedWhen: { memory: GlobalStateKey.MEMORY_ENABLED },
  prompt: memoryPromptSection,
});

/**
 * The `plan` tool owns planning and the goal lifecycle (update, pause,
 * complete), so any agent with tools can drive the goal loop while the plugin
 * is on; the synthetic turns are its continuation
 * (`@tools/goal/goalContinuation`). Its rows are the `goal/state` arm.
 */
export const goal: Plugin = builtin({
  id: 'goal',
  tools: { plan: PlanTool },
  injectedWhen: { plan: true },
  toggle: 'on',
  availability: ALWAYS_AVAILABLE,
  continuation: goalContinuation,
  arms: [GOAL_STATE_ARM],
});

/** Child agents: the `agent` tool. */
export const multiAgent: Plugin = builtin({
  id: 'multi-agent',
  tools: { [AGENT_TOOL_NAME]: agentTool() },
  // The one delegation tool: the built-in orchestrators need it.
  toggle: 'on',
  availability: ALWAYS_AVAILABLE,
});

/**
 * The `script` tool: a program that calls the run's other tools. An agent
 * gets it only if its configuration names it; its session layer is the code
 * sandbox the scripts run in.
 */
export const codemode = builtin<CodeSandbox>({
  id: 'codemode',
  tools: SCRIPT_TOOLS,
  sessionLayer: codeSandboxLayer,
});

/** The built-in lists: every built-in with no app options, and files and
 *  the shell alone. */
export const harnessBuiltins: {
  readonly all: readonly Plugin[];
  readonly minimal: readonly Plugin[];
} = {
  all: [fileOps(), web, memoryWorkflow, goal, multiAgent, codemode],
  minimal: [fileOps()],
};
