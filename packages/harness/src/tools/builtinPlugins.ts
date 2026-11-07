/**
 * The harness's built-in plugins: files and the shell, the web, memory and
 * tasks, goal mode, child agents and code mode. An app lists them beside its
 * own; `harnessBuiltins` is every one with
 * no app options.
 */

// Local imports
import { agentTool } from '@agent/runtime/delegation/AgentTool';
import { GOAL_PLAN_KIND } from '@shared/schemas';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import { BashTool } from '@tools/bash';
import { codeSandboxLayer, ScriptTool } from '@tools/codemode/ScriptTool';
import { SelfTool } from '@tools/codemode/SelfTool';
import { EditFileTool } from '@tools/EditTool';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { GlobTool } from '@tools/glob';
import { GrepTool } from '@tools/grep';
import { MemoryTool } from '@tools/memory/MemoryTool';
import { memoryPromptSection } from '@tools/memory/memoryPromptSection';
import { GOAL_MODULE } from '@tools/plan/goalScript';
import { PlanTool } from '@tools/plan/PlanTool';
import { definePlugin, type Plugin } from '@tools/plugins';
import { ReadFileTool } from '@tools/ReadTool';
import { ALWAYS_AVAILABLE } from '@tools/toolProbes';
import { WebFetchTool } from '@tools/web/WebFetchTool';
import { WebSearchTool } from '@tools/web/WebSearchTool';
import { writeFileTool, type WriteFilter } from '@tools/WriteTool';
import {
  MEMORY_ENABLED_SETTING,
  SCRIPT_ONLY_SETTING,
} from '@shared/state/stateSettings';

const fileTools = (writeFilter?: WriteFilter) =>
  [
    BashTool,
    ReadFileTool,
    writeFileTool(writeFilter),
    EditFileTool,
    GlobTool,
    GrepTool,
  ] as const;

const SCRIPT_TOOLS = [ScriptTool, SelfTool] as const;

/**
 * Compile-time guard: every canonical tool with specialized display
 * treatment is a built-in, so every list that includes the built-ins
 * registers it.
 */
type AssertNever<T extends never> = T;
type _CanonicalDisplayNamesAreBuiltIns = AssertNever<
  Exclude<
    CanonicalToolDisplayName,
    | ReturnType<typeof fileTools>[number]['definition']['name']
    | (typeof SCRIPT_TOOLS)[number]['definition']['name']
  >
>;

/** Files and the shell: every agent needs them. An app passes the filter
 *  `write_file` applies to what it writes (its own content replacements). */
export const fileOps = (
  options: { readonly writeFilter?: WriteFilter } = {},
): Plugin =>
  definePlugin({
    id: 'file-ops',
    tools: fileTools(options.writeFilter),
  });

/** The web: `web_search` and `web_fetch`. */
export const web: Plugin = definePlugin({
  id: 'web',
  tools: [WebSearchTool, WebFetchTool],
});

/** Memory and past runs: the `memory` tool, offered while memory is on,
 *  and `executions`. */
export const memoryWorkflow: Plugin = definePlugin({
  id: 'memory-workflow',
  tools: [MemoryTool, ExecutionsTool],
  injectedWhen: { memory: MEMORY_ENABLED_SETTING },
  prompt: memoryPromptSection,
});

/**
 * Plans and goals: the `plan` tool proposes a plan, which the user may run
 * as a goal: a background script of the conversation that runs its agent
 * in rounds through `self()` (`goalScript`), on the default strategy, its
 * module `builtIn:goal`, unless `goal.strategy` names another.
 */
export const goal: Plugin = definePlugin({
  id: 'goal',
  tools: [PlanTool],
  factKinds: [GOAL_PLAN_KIND],
  scriptModules: { goal: GOAL_MODULE },
  // A goal is a script whose rounds are `self()`.
  requires: ['codemode'],
  injectedWhen: { plan: true },
  toggle: 'on',
  availability: ALWAYS_AVAILABLE,
});

/** Child agents: the `agent` tool. */
export const multiAgent: Plugin = definePlugin({
  id: 'multi-agent',
  tools: [agentTool()],
  // The one delegation tool: the built-in orchestrators need it.
  toggle: 'on',
  availability: ALWAYS_AVAILABLE,
});

/**
 * Code mode: the `script` tool, a program that calls the run's other tools,
 * and `self()`, the function a script runs this agent again with. An agent
 * gets them if its configuration names `script`, or, while script-only
 * tools are on, as every chat run does; its session layer is the code
 * sandbox the scripts run in.
 */
export const codemode = definePlugin({
  id: 'codemode',
  tools: SCRIPT_TOOLS,
  injectedWhen: { script: SCRIPT_ONLY_SETTING },
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
