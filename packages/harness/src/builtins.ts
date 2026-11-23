/**
 * The harness's built-in plugins for `@texra-ai/worldline`: what a process
 * lists in `Sessions.layer({ platform, plugins, client })` beside its own.
 *
 * > **Guide:** Read [Plugins, Tools & Codemode](/api/plugins-and-codemode) for
 * > what each built-in registers and how the `script` (Codemode) sandbox
 * > replays across crashes.
 *
 * ### Key exports by role
 *
 * - **Every built-in**: [`harnessBuiltins`](#harnessbuiltins), each with no
 *   app options.
 * - **One by one**: [`codemode`](#codemode), [`fileOps`](#fileops) (with the
 *   [`WriteFilter`](#writefilter) an app applies to what `write_file`
 *   writes), [`goal`](#goal), [`memoryWorkflow`](#memoryworkflow),
 *   [`multiAgent`](#multiagent) (the `agent` tool,
 *   [`AGENT_TOOL_NAME`](#agent_tool_name), and the `program` tool), and
 *   [`web`](#web).
 *
 * A plugin or tool of your own is written with
 * [`@texra-ai/worldline/plugins`](./plugins), which imports none of these.
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
/** The name of the `multiAgent` plugin's tool, which starts a child of the
 *  calling run on the system text and tools the call gives it, or on an
 *  installed plugin's agent: a run whose tools name it can delegate. */
export { AGENT_TOOL_NAME } from '@shared/schemas';
export type { WriteFilter } from '@tools/WriteTool';
