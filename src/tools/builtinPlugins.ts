/**
 * The harness's built-in plugins: files and the shell, the web, memory and
 * tasks, goal mode, child agents and code mode. An app lists them beside its
 * own (`@tools/registry` for TeXRA); `harnessBuiltins.all` is every one with
 * no app options, and `harnessBuiltins.minimal` only files and the shell: a
 * complete harness whose other tools are absent.
 *
 * A built-in an app changes takes options rather than a hook: `multiAgent`
 * takes the workflow options the app adds to `agent` (TeXRA's figure pair).
 */

// Local imports
import type { CodeSandbox } from '@agent/codeSandbox/codeSandbox';
import { AGENT_TOOL_NAME } from '@shared/constants/delegationTools';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import { BashTool } from '@tools/bash';
import { codeSandboxLayer, ScriptTool } from '@tools/codemode/ScriptTool';
import {
  agentTool,
  type WorkflowAgentOptions,
} from '@tools/delegation/AgentTool';
import { EditFileTool } from '@tools/EditTool';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { AcceptRunFilesTool } from '@tools/AcceptRunFilesTool';
import { GlobTool } from '@tools/glob';
import { goalContinuation } from '@tools/goal/goalContinuation';
import { GrepTool } from '@tools/grep';
import { MemoryTool } from '@tools/memory/MemoryTool';
import { memoryPromptSection } from '@tools/memory/memoryPromptSection';
import { PlanTool } from '@tools/plan/PlanTool';
import { definePlugin, type Plugin } from '@tools/plugins';
import { ReadFileTool } from '@tools/ReadTool';
import { TodoWriteTool } from '@tools/todo/TodoTool';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { WebFetchTool } from '@tools/web/WebFetchTool';
import { WebSearchTool } from '@tools/web/WebSearchTool';
import { WriteFileTool } from '@tools/WriteTool';

const FILE_TOOLS = {
  bash: BashTool,
  read_file: ReadFileTool,
  write_file: WriteFileTool,
  edit_file: EditFileTool,
  glob: GlobTool,
  grep: GrepTool,
};

const SCRIPT_TOOLS = { script: ScriptTool };

/**
 * Compile-time guard: every canonical tool with specialized display
 * treatment is a built-in, so every list that includes the built-ins
 * registers it.
 */
type AssertNever<T extends never> = T;
type _CanonicalDisplayNamesAreBuiltIns = AssertNever<
  Exclude<
    CanonicalToolDisplayName,
    keyof typeof FILE_TOOLS | keyof typeof SCRIPT_TOOLS
  >
>;

/** Files and the shell: every agent needs them. */
export const fileOps: Plugin = {
  id: 'file-ops',
  name: 'File & Shell Operations',
  category: 'file',
  description:
    'Read, write, edit files and run shell commands. Includes glob/grep search.',
  tools: FILE_TOOLS,
};

export const web: Plugin = {
  id: 'web',
  name: 'Web Search & Fetch',
  category: 'web',
  description:
    'Search the web with DuckDuckGo Instant Answers and fetch or extract content from URLs.',
  tools: { web_search: WebSearchTool, web_fetch: WebFetchTool },
};

export const memoryWorkflow: Plugin = {
  id: 'memory-workflow',
  name: 'Memory & Tasks',
  category: 'workflow',
  description:
    'Persistent memory across sessions, task tracking with to-do lists, and the executions view of the runs an agent launched.',
  tools: {
    memory: MemoryTool,
    todo_write: TodoWriteTool,
    executions: ExecutionsTool,
    accept_run_files: AcceptRunFilesTool,
  },
  injectedWhen: { memory: GlobalStateKey.MEMORY_ENABLED },
  prompt: memoryPromptSection,
};

/**
 * The `plan` tool owns planning and the goal lifecycle (update, pause,
 * complete), so any tool-use agent can drive the goal loop while the plugin
 * is on; the synthetic turns are its continuation
 * (`@tools/goal/goalContinuation`). Its rows are the `goal/state` arm
 * (`@tools/pluginArms`).
 */
export const goal: Plugin = {
  id: 'goal',
  name: 'Goal Mode',
  category: 'workflow',
  description:
    'Propose a plan for approval and, when you run it as a goal, let the agent keep working turn after turn until the objective is done or it needs you.',
  tools: { plan: PlanTool },
  injectedWhen: { plan: true },
  setup: Object.freeze({
    configNotes:
      "No local install required. Turning this off removes the plan tool from every agent and stops goal turns, from each run's next step.",
  }),
  toggleable: true,
  onByDefault: true,
  availability: ALWAYS_AVAILABLE,
  continuation: goalContinuation,
};

/** No workflow options on `agent`: the harness names none of its own. */
const NO_WORKFLOW_OPTIONS: WorkflowAgentOptions = {
  fields: {},
  toolConfig: () => ({}),
};

/** Child agents: the `agent` tool, with the workflow options an app adds. */
export const multiAgent = (
  options: WorkflowAgentOptions = NO_WORKFLOW_OPTIONS,
): Plugin => ({
  id: 'multi-agent',
  name: 'Multi-Agent Workflow',
  category: 'workflow',
  description:
    'Run named agents as children of a run: one at a time, or fanned out and joined from a script, resuming safely after interruption. An agent only gets the agent tool if its own configuration names it: this switch is an additional kill switch on top of that per-agent opt-in.',
  tools: { [AGENT_TOOL_NAME]: agentTool(options) },
  setup: Object.freeze({
    configNotes:
      'No local install required. Turning this off removes the agent tool from every agent tool list, even agents whose configuration names it explicitly, so no agent can delegate.',
  }),
  toggleable: true,
  // The one delegation tool: the built-in orchestrators need it.
  onByDefault: true,
  availability: ALWAYS_AVAILABLE,
  skills: true,
});

/**
 * The `script` tool: a program that calls the run's other tools. An agent
 * gets it only if its configuration names it; its session layer is the code
 * sandbox the scripts run in.
 */
export const codemode = definePlugin<CodeSandbox>({
  id: 'codemode',
  name: 'Code Mode',
  category: 'workflow',
  description:
    "Run a JavaScript program that calls the agent's other tools, resuming after an interruption without running finished calls again.",
  tools: SCRIPT_TOOLS,
  hidden: true,
  sessionLayer: codeSandboxLayer,
});

/** The built-in lists: every built-in with no app options, and files and
 *  the shell alone. */
export const harnessBuiltins: {
  readonly all: readonly Plugin[];
  readonly minimal: readonly Plugin[];
} = {
  all: [fileOps, web, memoryWorkflow, goal, multiAgent(), codemode],
  minimal: [fileOps],
};
