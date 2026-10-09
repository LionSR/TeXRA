/**
 * The `document_task` tool: run a named agent's document task as a child of
 * the calling run. The child is a run of the agent opened on the document
 * recipe (`@agent/output/documentRecipe`), launched through the same core as
 * `agent` (`launchChildAgent`): one proposal, one reuse key, one in-band or
 * detached child. A model that wants a conversation calls `agent` instead.
 */
import { Effect } from 'effect';
import { z } from 'zod';

import { defineTool } from '@texra-ai/harness';
import {
  findAgentByIdentifier,
  getCatalogAgent,
  resolveDelegationScopeAgents,
} from '@agent/index/agentRegistry';
import { requireToolRun } from '@agent/runtime/RunCall';
import { agentKey, DEFAULT_TOOL_CONFIG } from '@shared/schemas';
import { documentTaskConfig } from '@texra/agent/output/documentRecipe';
import { errorResult } from '@tools/core/result';
import {
  CALL_FIELDS,
  fileList,
  launchChildAgent,
} from '@tools/delegation/AgentTool';

const DocumentTaskInputSchema = z.strictObject({
  prompt: z
    .string()
    .describe(
      'The instruction the task follows, in plain prose: what to change and what to keep. Empty for the task as its agent defines it.',
    ),
  agentName: z
    .string()
    .min(1, 'agentName is required')
    .describe('The agent whose document task to run.'),
  model: z
    .string()
    .nullish()
    .describe(
      'Model reference, `@effort` suffix allowed. Defaults to your current model when available.',
    ),
  inputFiles: fileList('The files it revises, one revised document each.'),
  contextFiles: fileList(
    'Read-only context (guidance, .bib, .sty). Say in the prompt what each is for.',
  ),
  mediaFiles: fileList('Images, figures, PDFs or audio.'),
  outputFiles: fileList(
    'Output paths, a subset of `inputFiles`. Empty for the default outputs.',
  ),
  extractFigures: z
    .boolean()
    .nullish()
    .describe('Attach the figures the input LaTeX includes as media.'),
  extractTikz: z
    .boolean()
    .nullish()
    .describe('Compile the input LaTeX TikZ figures and attach them.'),
  reflect: z
    .boolean()
    .nullish()
    .describe(
      'Have the `critic` agent review each revision but the last; the next revision reads its critique.',
    ),
  ...CALL_FIELDS,
});
type DocumentTaskInput = z.infer<typeof DocumentTaskInputSchema>;

const runDocumentTask = Effect.fn('DocumentTaskTool.call')(function* (
  input: DocumentTaskInput,
) {
  const call = yield* requireToolRun('document_task');
  const agents = yield* resolveDelegationScopeAgents(
    call.env.roots,
    call.run.delegationAgentScope ?? undefined,
  );
  const agent = findAgentByIdentifier(agents, input.agentName);
  if (agent !== undefined && agent.task === null)
    return errorResult(
      `'${input.agentName}' has no document task: call \`agent\` to run it with a prompt.`,
    );
  if (input.inputFiles.length === 0)
    return errorResult(
      `'${input.agentName}' revises files: pass the files it revises as \`inputFiles\`.`,
    );
  return yield* launchChildAgent({
    tool: 'document_task',
    agentName: input.agentName,
    prompt: input.prompt,
    model: input.model,
    schema: null,
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
      recipeFor: ({ agent: name, agentSource: source }) => {
        const key = source ? agentKey(source, name) : name;
        // The exact entry: a bare name would re-resolve to what shadows it.
        return getCatalogAgent(key)?.task
          ? documentTaskConfig({ agent: key }).script
          : null;
      },
      toolConfig: {
        ...DEFAULT_TOOL_CONFIG,
        ...(input.extractFigures != null && {
          autoExtractFigure: input.extractFigures,
        }),
        ...(input.extractTikz != null && {
          autoExtractTikzFigure: input.extractTikz,
        }),
        ...(input.reflect != null && { reflect: input.reflect }),
      },
    },
  });
});

/** The `document_task` tool. */
export const DocumentTaskTool = defineTool({
  name: 'document_task',
  requiresApproval: 'inBody',
  replay: 'safe',
  lane: 'own',
  scriptGlobal: { positional: 'prompt' },
  scriptReturns:
    "{ response: string; documents: { outputs: { relativePath: string; absolutePath: string; added: number | null; removed: number | null }[] }; runId: string; outcome: 'completed'; cost: number } | { runId: string }",
  slow: true,
  description: `Run a named agent's document task over files, as a child of this run: it revises every file in \`inputFiles\` in the fixed revisions its task defines, with compile checks and diffs, and proposes one revised document each.

From a script, \`document_task(prompt, opts)\` waits for the task and resolves to its result: \`{ documents: { outputs }, runId, outcome, cost }\`. It rejects with an Error named \`AgentFailed\`, \`TimedOut\`, or \`Skipped\`. With \`background: true\` it resolves to \`{ runId }\` at once and the result arrives as a follow-up. Called directly, the task runs in the background and its result arrives as a follow-up message; in a one-shot run the call waits for it.`,
  schema: DocumentTaskInputSchema,
  execute: runDocumentTask,
});
