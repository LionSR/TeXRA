/**
 * The harness's built-in plugins: files and the shell, the web, memory and
 * tasks, goal mode, child agents, and code mode with the agent's own context. An app lists them beside its
 * own; `harnessBuiltins` is every one with
 * no app options.
 */

// Local imports
import { agentTool } from '@agent/runtime/delegation/AgentTool';
import { programTool } from '@agent/runtime/delegation/ProgramTool';
import { GOAL_PLAN_KIND } from '@shared/schemas';
import type { CanonicalToolDisplayName } from '@shared/tools/toolKind';
import { BashTool } from '@tools/bash';
import { ContextTool } from '@tools/codemode/ContextTool';
import { codeSandboxLayer, ScriptTool } from '@tools/codemode/ScriptTool';
import { SelfTool } from '@tools/codemode/SelfTool';
import { EditFileTool } from '@tools/EditTool';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { GlobTool } from '@tools/glob';
import { GrepTool } from '@tools/grep';
import { PlanTool } from '@tools/plan/PlanTool';
import { PluginManagerTool } from '@tools/PluginManagerTool';
import { definePlugin, type Plugin } from '@tools/plugins';
import { ReadFileTool } from '@tools/ReadTool';
import { ResourcesTool } from '@tools/ResourcesTool';
import { WakeTool } from '@tools/WakeTool';
import { WebFetchTool } from '@tools/web/WebFetchTool';
import { WebSearchTool } from '@tools/web/WebSearchTool';
import { writeFileTool, type WriteFilter } from '@tools/WriteTool';

import GOAL_MODULE from './plan/goal.js?raw';

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

/** Past runs and later ones, and the run's own equipment: `executions`;
 *  `wake`, with which a run arranges to be continued at a later time;
 *  `plugin_manager`, with which it installs and enables the plugins it
 *  loads, each change approved by the person; and `resources`, which reads
 *  the time, the models, the plans' quotas and the run's spend. The last
 *  three are offered to every agent with tools. An agent's memory is no
 *  tool: its notes are files its file tools read and write
 *  (`agent/memory/memoryLayout.ts`). */
export const memoryWorkflow: Plugin = definePlugin({
  id: 'memory-workflow',
  tools: [ExecutionsTool, WakeTool, PluginManagerTool, ResourcesTool],
  injectedWhen: {
    wake: true,
    plugin_manager: true,
    resources: true,
  },
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
});

/** Child runs: the `agent` tool, and `program` for a registered program. */
export const multiAgent: Plugin = definePlugin({
  id: 'multi-agent',
  tools: [agentTool(), programTool()],
  // The delegation tools: the built-in orchestrators need them.
  toggle: 'on',
});

/**
 * Code mode: the `script` tool, a program that calls the run's other tools,
 * `self()`, the function a script runs this agent again with, and
 * `context`, which reads and edits the run's own model view. An agent gets
 * `script` and `context` if its configuration names them, or as every run
 * that takes injected tools does (not a script's run or a text-only
 * run). A step that offers `script`
 * sends it and the run's own tools alone, so `context` is called from a
 * script there and directly elsewhere; its session layer is the code
 * sandbox the scripts run in.
 */
export const codemode = definePlugin({
  id: 'codemode',
  tools: [...SCRIPT_TOOLS, ContextTool],
  injectedWhen: { script: true, context: true },
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
