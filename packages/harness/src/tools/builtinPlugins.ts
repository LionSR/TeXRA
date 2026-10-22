/**
 * The harness's built-in plugins: files and the shell, the web, memory and
 * tasks, goal mode, child agents and code mode. An app lists them beside its
 * own; `harnessBuiltins` is every one with
 * no app options.
 */

// Local imports
import type { CodeSandbox } from '@agent/codeSandbox/codeSandbox';
import { AGENT_TOOL_NAME } from '@shared/constants/delegationTools';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import { BashTool } from '@tools/bash';
import { codeSandboxLayer, ScriptTool } from '@tools/codemode/ScriptTool';
import { SelfTool } from '@tools/codemode/SelfTool';
import { agentTool } from '@tools/delegation/AgentTool';
import { EditFileTool } from '@tools/EditTool';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { GlobTool } from '@tools/glob';
import { GrepTool } from '@tools/grep';
import { MemoryTool } from '@tools/memory/MemoryTool';
import { memoryPromptSection } from '@tools/memory/memoryPromptSection';
import { PlanTool } from '@tools/plan/PlanTool';
import { defineBuiltinPlugin, type Plugin } from '@tools/plugins';
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

const SCRIPT_TOOLS = { script: ScriptTool, self: SelfTool };

/**
 * A built-in plugin: as a plugin's definition, but its tools may read the
 * call's place in its run (`RunCall`) and its script, which the run loop
 * provides to every call and no app's tool may require.
 */
const builtin = defineBuiltinPlugin;

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
 *  `write_file` applies to what it writes (its own content replacements). */
export const fileOps = (
  options: { readonly writeFilter?: WriteFilter } = {},
): Plugin =>
  builtin({
    id: 'file-ops',
    tools: fileTools(options.writeFilter),
  });

/** The web: `web_search` and `web_fetch`. */
export const web: Plugin = builtin({
  id: 'web',
  tools: { web_search: WebSearchTool, web_fetch: WebFetchTool },
});

/** Memory and past runs: the `memory` tool, offered while memory is on,
 *  and `executions`. */
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
 * Plans and goals: the `plan` tool proposes a plan, which the user may run
 * as a goal: a background script of the conversation that runs its agent
 * in rounds through `self()` (`goalScript`).
 */
export const goal: Plugin = builtin({
  id: 'goal',
  tools: { plan: PlanTool },
  // A goal is a script whose rounds are `self()`.
  requires: ['codemode'],
  injectedWhen: { plan: true },
  toggle: 'on',
  availability: ALWAYS_AVAILABLE,
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
 * Code mode: the `script` tool, a program that calls the run's other tools,
 * and `self()`, the function a script runs this agent again with. An agent
 * gets them only if its configuration names `script`; its session layer is
 * the code sandbox the scripts run in.
 */
export const codemode = builtin<CodeSandbox>({
  id: 'codemode',
  tools: SCRIPT_TOOLS,
  sessionLayer: codeSandboxLayer,
});

/** Every built-in, with no app options. */
export const harnessBuiltins: readonly Plugin[] = [
  fileOps(),
  web,
  memoryWorkflow,
  goal,
  multiAgent,
  codemode,
];
