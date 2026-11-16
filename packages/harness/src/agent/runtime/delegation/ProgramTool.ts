/**
 * The `program` tool: start a registered program (`Plugin.programs`) by
 * name as a child of the calling run. The child is a run opened on the
 * program (`AgentConfig.script` of kind `program`), launched through the
 * same core as `agent` (`launchChildAgent`): one proposal, one reuse key,
 * one awaited or background child. A model that wants a conversation calls
 * `agent` instead.
 */
import { Schema } from 'effect';

import type { PluginToolServices } from '@agent/runtime/ToolServices';
import { JsonValueSchema, PROGRAM_TOOL_NAME } from '@shared/schemas';
import { defineTool, type DefinedTool } from '@tools/core/definition';

import { launchChildAgent } from './AgentTool';
import { CALL_FIELDS, fileList } from './inputFields';

const ProgramInputSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'The program to start, by its name.',
  }),
  prompt: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'The instruction the program follows, in plain prose: what to change, from which point of view, and what to keep. Omit for the program as written.',
  }),
  model: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'Model reference, `@effort` suffix allowed. Defaults to your current model when available.',
  }),
  inputFiles: fileList('The files it works on.'),
  contextFiles: fileList(
    'Read-only context (guidance, .bib, .sty). Say in the prompt what each is for.',
  ),
  mediaFiles: fileList('Images, figures, PDFs or audio.'),
  outputFiles: fileList(
    'Output paths, used when one is not among `inputFiles`. Otherwise the program writes its own outputs, or revises the inputs when it names none.',
  ),
  args: Schema.optional(
    Schema.NullOr(Schema.Record(Schema.String, JsonValueSchema)),
  ).annotate({
    description: "The program's own arguments, as its description names them.",
  }),
  ...CALL_FIELDS,
});
type ProgramInput = typeof ProgramInputSchema.Type;

export const programTool: DefinedTool<ProgramInput, PluginToolServices> =
  defineTool({
    name: PROGRAM_TOOL_NAME,
    requiresApproval: 'inBody',
    // A resumed call finds the child its earlier attempt launched.
    replay: 'safe',
    lane: 'own',
    scriptGlobal: { positional: 'name' },
    scriptReturns:
      "{ response: string; files: string[]; changes?: { path: string; absolutePath: string; base: string | null; added: number | null; removed: number | null }[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number; spent: number } | { runId: string }",
    description: `Start a program by name, as a child of this run: a fixed procedure a plugin ships, run over the files you pass.

From a script, \`program(name, opts)\` waits for the program and resolves to its result: \`{ response, files, changes?, structured?, runId, outcome, cost, spent }\`, where \`changes\` lists the files a program reports writing, in order (\`path\` the workspace file, \`absolutePath\` the copy it wrote), \`cost\` is what the program spent and \`spent\` what this run has spent in all so far. It rejects with an Error named \`AgentFailed\`, \`TimedOut\`, \`Skipped\`, \`DuplicateCall\` (a second identical call in one script) or \`ModelUnavailable\`. With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. Called directly, the program runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.`,
    schema: ProgramInputSchema,
    execute: (input: ProgramInput) =>
      launchChildAgent({
        prompt: input.prompt ?? '',
        model: input.model,
        memories: input.memories,
        workingDirectory: input.working_directory,
        id: input.id,
        timeoutMs: input.timeoutMs,
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
