/**
 * The `program` tool: start a program (one a plugin registers or carries,
 * or one the agent wrote for itself) by name as a child of the calling run.
 * The child is a run opened on the program (`AgentConfig.script` of kind
 * `program`), launched through the same core as `agent`
 * (`launchChildAgent`): one proposal, one reuse key, one awaited or
 * background child. A model that wants a conversation calls `agent`
 * instead.
 */
import { Schema } from 'effect';

import { OWN_PROGRAMS_DIRECTORY } from '@agent/memory/ownPrograms';
import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { OWN_PROGRAM_PREFIX, PROGRAM_TOOL_NAME } from '@shared/schemas';
import { defineTool, type DefinedTool } from '@tools/core/definition';
import { optionalInput } from '@tools/core/inputSchema';

import { launchChildAgent } from './AgentTool';
import { CALL_FIELDS, fileList } from './inputFields';

const ProgramInputSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'The program to start, by its name.',
  }),
  prompt: optionalInput(
    Schema.String,
    'The instruction the program follows, in plain prose: what to change, from which point of view, and what to keep. Omit for the program as written.',
  ),
  inputFiles: fileList('The files it works on.'),
  contextFiles: fileList(
    'Read-only context (guidance, references, style files). Say in the prompt what each is for.',
  ),
  mediaFiles: fileList('Images, figures, PDFs or audio.'),
  outputFiles: fileList(
    'Output paths, used when one is not among `inputFiles`. Otherwise the program writes its own outputs, or revises the inputs when it names none.',
  ),
  args: optionalInput(
    Schema.Record(Schema.String, Schema.Json),
    "The program's own arguments, as its description names them.",
  ),
  ...CALL_FIELDS,
});
type ProgramInput = typeof ProgramInputSchema.Type;

export const programTool = (): DefinedTool<ProgramInput, PluginToolServices> =>
  defineTool({
    name: PROGRAM_TOOL_NAME,
    requiresApproval: 'inBody',
    // A resumed call finds the child its earlier attempt launched.
    replay: 'safe',
    lane: 'own',
    scriptGlobal: { positional: 'name' },
    scriptReturns:
      "{ response: string; files: string[]; changes?: { path: string; absolutePath: string; base: string | null; added: number | null; removed: number | null }[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number; spent: number } | { runId: string }",
    description: `Start a program by name, as a child of this run: a fixed procedure a plugin ships or you wrote, run over the files you pass.

A file you write at \`${OWN_PROGRAMS_DIRECTORY}/<name>.js\` in the project memory folder your instructions name is the program \`${OWN_PROGRAM_PREFIX}:<name>\` from your next step, and in later conversations in this project. It begins with \`export const description = '...';\` and \`export const uses = ['...'];\` (the tools it is offered), each a quoted literal, and its \`export default async (args, { instruction, inputFiles, contextFiles, mediaFiles }) => { ... }\` calls those tools as a script does and returns the program's result.

From a script, \`program(name, opts)\` waits for the program and resolves to its result: \`{ response, files, changes?, structured?, runId, outcome, cost, spent }\`, where \`changes\` lists the files a program reports writing, in order (\`path\` the workspace file, \`absolutePath\` the copy it wrote), \`cost\` is what the program spent and \`spent\` what this run has spent in all so far. It rejects with an Error named \`AgentFailed\`, \`TimedOut\` (past \`timeoutMs\`), \`BudgetExceeded\` (the program and the runs it started spent \`maxCostUsd\` before it finished), \`Skipped\`, \`DuplicateCall\` (a second identical call in one script) or \`ModelUnavailable\`. With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. Called directly, the program runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.`,
    schema: ProgramInputSchema,
    execute: (input: ProgramInput) =>
      launchChildAgent({
        prompt: input.prompt ?? '',
        model: input.model,
        workingDirectory: input.working_directory,
        id: input.id,
        timeoutMs: input.timeoutMs,
        maxCostUsd: input.maxCostUsd,
        background: input.background,
        files: {
          inputFiles: input.inputFiles,
          contextFiles: input.contextFiles,
          mediaFiles: input.mediaFiles,
          outputFiles: input.outputFiles,
        },
        program: { name: input.name, args: input.args ?? {} },
      }),
  });
