/**
 * The `document_task` tool: run a named agent's document task as a child of
 * the calling run. The child is a run of the agent opened on the document
 * recipe (`@texra/agent/output/documentRecipe`), launched through the same core as
 * `agent` (the `ChildRuns` launch): one proposal, one reuse key, one in-band or
 * detached child. A model that wants a conversation calls `agent` instead.
 */
import { Effect, Record as Rec, Schema } from 'effect';

import { defineTool } from '@texra-ai/harness';
import { AgentCatalog } from '@texra-ai/harness/host';
import {
  requireRun,
  errorResult,
  ChildRuns,
  CALL_FIELDS,
  fileList,
} from '@texra-ai/harness/plugins';
import { agentMatchesIdentifier } from '@texra-ai/harness/schemas';
import { DOCUMENT_TASK_OPTIONS } from '@texra/shared/plugins/documents';
import {
  documentTaskKey,
  documentTaskPatch,
} from '@texra/agent/output/documentRecipe';
import { documentTaskOf } from '@texra/tools/documents/documentTask';

const DocumentTaskInputSchema = Schema.Struct({
  prompt: Schema.String.annotate({
    description:
      'The instruction the task follows, in plain prose: what to change and what to keep. Empty for the task as its agent defines it.',
  }),
  agentName: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: 'The agent whose document task to run.',
  }),
  model: Schema.optional(Schema.NullOr(Schema.String)).annotate({
    description:
      'Model reference, `@effort` suffix allowed. Defaults to your current model when available.',
  }),
  inputFiles: fileList('The files it revises, one revised document each.'),
  contextFiles: fileList(
    'Read-only context (guidance, .bib, .sty). Say in the prompt what each is for.',
  ),
  mediaFiles: fileList('Images, figures, PDFs or audio.'),
  outputFiles: fileList(
    'Output paths, a subset of `inputFiles`. Empty for the default outputs.',
  ),
  ...Rec.map(DOCUMENT_TASK_OPTIONS, ({ description }) =>
    Schema.optional(Schema.NullOr(Schema.Boolean)).annotate({ description }),
  ),
  ...CALL_FIELDS,
});
type DocumentTaskInput = typeof DocumentTaskInputSchema.Type;

const runDocumentTask = Effect.fn('DocumentTaskTool.call')(function* (
  input: DocumentTaskInput,
) {
  const call = yield* requireRun('document_task');
  const catalog = yield* AgentCatalog;
  const agent = (yield* catalog.visible(
    call.env.roots,
    call.run.config.delegationAgentScope ?? undefined,
  )).find((entry) => agentMatchesIdentifier(entry, input.agentName));
  if (agent !== undefined && documentTaskOf(agent) === null)
    return errorResult(
      `'${input.agentName}' has no document task: call \`agent\` to run it with a prompt.`,
    );
  if (input.inputFiles.length === 0 && input.mediaFiles.length === 0)
    return errorResult(
      `'${input.agentName}' needs files: pass \`inputFiles\` or \`mediaFiles\`.`,
    );
  const launched = yield* (yield* ChildRuns).launch({
    tool: 'document_task',
    agentName: input.agentName,
    prompt: input.prompt,
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
    task: {
      configFor: (chosen) => {
        // The exact entry: a bare name would re-resolve to what shadows it.
        const key = documentTaskKey(chosen);
        const entry = catalog.get(key);
        const patch =
          entry &&
          documentTaskPatch(
            { ...chosen, agent: key, agentSource: null },
            entry,
            chosen.options ?? undefined,
          );
        return patch
          ? { script: patch.script, outputFiles: patch.outputFiles }
          : null;
      },
      options: Rec.map(DOCUMENT_TASK_OPTIONS, (_, key) => input[key] ?? false),
    },
  });
  return launched;
});

/** The `document_task` tool. */
export const DocumentTaskTool = defineTool({
  name: 'document_task',
  launchesTasks: true,
  replay: 'safe',
  lane: 'own',
  scriptGlobal: { positional: 'prompt' },
  scriptReturns:
    "{ response: string; changes: { path: string; absolutePath: string; base: string | null; added: number | null; removed: number | null }[]; runId: string; outcome: 'completed'; cost: number } | { runId: string }",
  slow: true,
  description: `Run a named agent's document task over files, as a child of this run: it revises every file in \`inputFiles\` in the fixed revisions its task defines, with compile checks and diffs, and proposes one revised document each.

From a script, \`document_task(prompt, opts)\` waits for the task and resolves to its result: \`{ changes, runId, outcome, cost }\`, where \`changes\` lists every revision's files in order (\`path\` the workspace file, \`absolutePath\` the revised copy). It rejects with an Error named \`AgentFailed\`, \`TimedOut\`, or \`Skipped\`. With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. Called directly, the task runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.`,
  schema: DocumentTaskInputSchema,
  execute: runDocumentTask,
});
