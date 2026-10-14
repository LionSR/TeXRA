/**
 * The document task recipe: the one script a document task runs, shipped by
 * the documents plugin as inline source. A document task is a run of its
 * persona opened on this script (`AgentConfig.script`) instead of a model
 * turn; the script calls the persona once per revision through `agent()`
 * and does everything else with the document tools (`./documentTools`).
 * A task launched with the `reflect` option also has the bundled `critic`
 * review each revision but the last, and the next revision reads its
 * critique; the revision count stays the task's. The persona's name is the
 * one value the source takes; a run records the source it ran, so a resume
 * replays the same program.
 */
import { Data, Effect } from 'effect';

import {
  getCatalogLoadFailure,
  refresh,
  resolveAgentForLaunch,
  settledCatalog,
  type WorkspaceAgentsStores,
} from '@agent/index/agentRegistry';
import type { AgentEntry } from '@agent/index';
import { agentKey, agentName } from '@shared/schemas';
import {
  DOCUMENT_TASK_BLOCK,
  DocumentTaskOptionsSchema,
  type DocumentTaskOptions,
} from '@texra/shared/plugins/documents';
import { documentTaskOf } from '@texra/tools/documents/documentTask';
import type { AgentConfig } from '@texra-ai/harness/schemas';

/** The tools the recipe calls: what a document task's run offers it. */
const DOCUMENT_TASK_TOOLS = [
  'agent',
  'document_context',
  'document_extract',
  'document_compile',
  'document_diff',
  'document_review',
  'document_propose',
] as const;

/** The recipe for the persona `agentName`. */
function recipeSource(agentName: string): string {
  return `const agentName = ${JSON.stringify(agentName)};
let revisions = 1;
let critique = null;
for (let revision = 0; revision < revisions; revision += 1) {
  phase(\`Revision \${revision + 1}\`);
  const context = await tools.document_context({ revision, critique });
  revisions = context.revisions;
  const reply = await agent(context.prompt, {
    agentName,
    mediaFiles: context.mediaFiles,
    memories: context.memories,
    label: \`Revision \${revision + 1}\`,
  });
  await tools.document_extract({ revision, run: reply.runId });
  const compiled = await tools.document_compile({ revision });
  await tools.document_diff({ revision });
  if (context.reflect && revision + 1 < revisions) {
    const review = await tools.document_review({
      revision,
      checked: compiled.checked,
    });
    const critic = await agent(review.prompt, {
      agentName: 'builtIn:critic',
      label: \`Critique \${revision + 1}\`,
    });
    critique = critic.response;
  }
}
return (await tools.document_propose({})).documents;`;
}

/**
 * The catalog key of the exact entry a document task's config names: its
 * stamped source with the agent's bare name (the agent may be spelled
 * source-qualified, as the launcher's picker spells it), or the agent as
 * spelled when no source is stamped.
 */
export const documentTaskKey = (
  config: Pick<AgentConfig, 'agent' | 'agentSource'>,
): string =>
  config.agentSource
    ? agentKey(config.agentSource, agentName(config.agent))
    : config.agent;

/** What a launch as an agent's document task adds to its config. */
type DocumentTaskPatch = Required<
  Pick<AgentConfig, 'script' | 'outputFiles' | 'agentSource'>
>;

/**
 * The patch that launches `config` as the document task of `entry`, or null
 * when `entry` has no task block: its run opens on the recipe and offers the
 * recipe's tools with the launch's `options`, and its revisions' agent
 * calls were approved with the launch. The outputs are the launch's
 * explicit list unless it names only inputs, else the task's own
 * (`task.outputs`).
 */
export function documentTaskPatch(
  config: Pick<
    AgentConfig,
    'agent' | 'agentSource' | 'inputFiles' | 'outputFiles'
  >,
  entry: AgentEntry,
  options: DocumentTaskOptions,
): DocumentTaskPatch | null {
  const task = documentTaskOf(entry);
  if (task === null) return null;
  const explicit = config.outputFiles.filter(Boolean);
  return {
    agentSource: entry.source,
    outputFiles: explicit.some((file) => !config.inputFiles.includes(file))
      ? explicit
      : task.outputs.filter(Boolean),
    script: {
      // The exact entry: a bare name would re-resolve to whatever shadows it.
      code: recipeSource(documentTaskKey(config)),
      title: config.agent,
      tools: [...DOCUMENT_TASK_TOOLS],
      kind: 'recipe',
      block: DOCUMENT_TASK_BLOCK.key,
      options: DocumentTaskOptionsSchema.parse(options),
    },
  };
}

/** A launch as a document task that cannot be built: its agent is not in
 *  the catalog, or has no task block. */
class DocumentTaskRefused extends Data.TaggedError('DocumentTaskRefused')<{
  readonly message: string;
}> {}

/**
 * `config` launched as its agent's document task. The agent resolves over a
 * settled catalog by the rule a launch's preparation uses
 * (`resolveAgentForLaunch`; a miss rescans once), and its source is stamped
 * so the preparation pins the same entry. A catalog that never loaded, an
 * unknown agent and a chat agent each fail loudly; no outputs are guessed.
 */
export const documentTaskConfig = Effect.fn('documentTaskConfig')(function* <
  C extends Pick<AgentConfig, 'agent'> & Partial<AgentConfig>,
>(
  config: C,
  stores: WorkspaceAgentsStores,
  options: Partial<DocumentTaskOptions> = {},
) {
  const resolve = resolveAgentForLaunch(
    stores,
    config.agent,
    config.agentSource,
  );
  const entry =
    (yield* Effect.andThen(settledCatalog, resolve)) ??
    (yield* Effect.andThen(refresh(), resolve));
  if (entry === undefined) {
    const failure = getCatalogLoadFailure();
    return yield* new DocumentTaskRefused({
      message: `Could not find agent: ${config.agent}${failure === undefined ? '' : `. The agent catalog did not load: ${failure}`}`,
    });
  }
  const patch = documentTaskPatch(
    {
      agent: config.agent,
      agentSource: config.agentSource,
      inputFiles: config.inputFiles ?? [],
      outputFiles: config.outputFiles ?? [],
    },
    entry,
    DocumentTaskOptionsSchema.parse(options),
  );
  if (patch === null)
    return yield* new DocumentTaskRefused({
      message: `'${config.agent}' has no document task: run it as a chat instead.`,
    });
  return { ...config, ...patch };
});
