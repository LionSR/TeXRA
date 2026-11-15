/**
 * The `revise` program: the one script a document task runs, shipped by the
 * theory plugin as the script module `builtIn:revise` and registered as a
 * program (`REVISE_PROGRAM`). A document task is a run of its persona
 * opened on the program (`AgentConfig.script`) instead of a model turn; the
 * program calls the persona once per revision through `agent()` and does
 * everything else with the document tools (`./documentTools`). A task
 * launched with the `reflect` option also has the bundled `critic` review
 * each revision but the last, and the next revision reads its critique; the
 * revision count stays the task's. The persona's catalog key is the one
 * argument the module reads (`args.agent`); the launch's options ride
 * beside it and the document tools read them from the run's config. A step
 * records the module source it ran, so a resume replays the same program.
 */
import { Effect, Record as Rec, Schema } from 'effect';

import {
  AgentCatalog,
  type AgentEntry,
  type WorkspaceAgentsStores,
} from '@texra-ai/harness/host';
import type { Program } from '@texra-ai/harness/plugins';
import { agentKey, agentName } from '@texra-ai/harness/schemas';
import {
  DOCUMENT_PROGRAM,
  DOCUMENT_TASK_OPTIONS,
  DocumentTaskOptionsSchema,
  type DocumentsOutput,
} from '@texra/shared/plugins/documents';
import { DOCUMENT_TASK_RESULT } from '@texra/tools/documents/documentResult';
import { documentTaskOf } from '@texra/tools/documents/documentTask';
import type { AgentConfig } from '@texra-ai/harness/schemas';

/** The module `builtIn:revise`: its default export runs the document task
 *  of the persona `agent` names. `String.raw` keeps the module's own
 *  escapes as written. */
export const REVISE_MODULE = String.raw`export default async ({ agent: agentName }) => {
  let revisions = 1;
  let critique = null;
  for (let revision = 0; revision < revisions; revision += 1) {
    section('Revision ' + (revision + 1));
    const context = await tools.document_context({ revision, critique });
    revisions = context.revisions;
    const reply = await agent(context.prompt, {
      agentName,
      mediaFiles: context.mediaFiles,
      memories: context.memories,
      label: 'Revision ' + (revision + 1),
    });
    await tools.document_extract({ revision, run: reply.runId });
    await tools.document_compile({ revision });
    await tools.document_diff({ revision });
    if (context.reflect && revision + 1 < revisions) {
      const review = await tools.document_review({ revision });
      const critic = await agent(review.prompt, {
        agentName: 'builtIn:critic',
        label: 'Critique ' + (revision + 1),
      });
      critique = critic.response;
    }
  }
  await tools.document_propose({});
};`;

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

/**
 * What launching `config` as the document task of `entry` settles, or null
 * when `entry` has no task block: the arguments the `revise` program is
 * called with (the exact entry and the launch's `options`, decoded here
 * with their defaults) and the outputs, the launch's explicit list unless
 * it names only inputs, else the task's own (`task.outputs`).
 */
function documentLaunch(
  config: Pick<
    AgentConfig,
    'agent' | 'agentSource' | 'inputFiles' | 'outputFiles'
  >,
  entry: AgentEntry,
  options: unknown,
) {
  const task = documentTaskOf(entry);
  if (task === null) return null;
  const explicit = config.outputFiles.filter(Boolean);
  return {
    outputFiles: explicit.some((file) => !config.inputFiles.includes(file))
      ? explicit
      : task.outputs.filter(Boolean),
    args: {
      // The exact entry: a bare name would re-resolve to whatever shadows
      // it.
      agent: documentTaskKey(config),
      ...Schema.decodeUnknownSync(DocumentTaskOptionsSchema)(options),
    },
  };
}

/**
 * The patch that launches `config` as the document task of `entry`
 * ({@link documentLaunch}), or null when `entry` has no task block: its
 * run opens on the `revise` program, and its revisions' agent calls were
 * approved with the launch.
 */
export function documentTaskPatch(
  config: Pick<
    AgentConfig,
    'agent' | 'agentSource' | 'inputFiles' | 'outputFiles'
  >,
  entry: AgentEntry,
  options: unknown = {},
): Required<
  Pick<AgentConfig, 'script' | 'outputFiles' | 'agentSource'>
> | null {
  const launch = documentLaunch(config, entry, options);
  return (
    launch && {
      agentSource: entry.source,
      outputFiles: launch.outputFiles,
      script: { kind: 'program', name: DOCUMENT_PROGRAM, args: launch.args },
    }
  );
}

/** The `revise` program as the theory plugin registers it. */
export const REVISE_PROGRAM: Program<DocumentsOutput> = {
  description: `Run the document task of the agent \`agentName\` over \`inputFiles\`: it revises every file in the fixed revisions the task defines, with compile checks and diffs, and proposes one revised document each. Pass an agent marked (task). Boolean \`args\`: ${Rec.keys(DOCUMENT_TASK_OPTIONS).join(', ')}. Its result's \`changes\` list every revision's files in order.`,
  // What the module calls.
  tools: [
    'agent',
    'document_context',
    'document_extract',
    'document_compile',
    'document_diff',
    'document_review',
    'document_propose',
  ],
  result: DOCUMENT_TASK_RESULT,
  configure: Effect.fn('revise.configure')(function* (approved) {
    // The exact entry: a bare name would re-resolve to what shadows it.
    const key = documentTaskKey(approved);
    const entry = (yield* AgentCatalog).get(key);
    const launch =
      entry &&
      documentLaunch(
        { ...approved, agent: key, agentSource: null },
        entry,
        approved.options ?? {},
      );
    if (!launch)
      return yield* Effect.fail(
        new Error(
          `'${approved.agent}' has no document task: call \`agent\` to run it with a prompt.`,
        ),
      );
    if (approved.inputFiles.length === 0 && approved.mediaFiles.length === 0)
      return yield* Effect.fail(
        new Error(
          `'${approved.agent}' needs files: pass \`inputFiles\` or \`mediaFiles\`.`,
        ),
      );
    return launch;
  }),
};

/** A launch as a document task that cannot be built: its agent is not in
 *  the catalog, or has no task block. */
class DocumentTaskRefused extends Schema.TaggedError<DocumentTaskRefused>()(
  'DocumentTaskRefused',
  {
    message: Schema.String,
  },
) {}

/**
 * `config` launched as its agent's document task. The agent resolves over a
 * resolved catalog by the rule a launch's preparation uses
 * (`AgentCatalog.forLaunch`; a miss rescans once), and its source is stamped
 * so the preparation pins the same entry. A catalog that never loaded, an
 * unknown agent and a chat agent each fail loudly; no outputs are guessed.
 */
export const documentTaskConfig = Effect.fn('documentTaskConfig')(function* <
  C extends Pick<AgentConfig, 'agent'> & Partial<AgentConfig>,
>(config: C, stores: WorkspaceAgentsStores) {
  const entry = yield* (yield* AgentCatalog)
    .workspaceAgents(stores)
    .forLaunch(config.agent, config.agentSource)
    .pipe(
      Effect.catchTag('AgentNotFound', (missed) =>
        Effect.fail(new DocumentTaskRefused({ message: missed.message })),
      ),
    );
  const patch = documentTaskPatch(
    {
      agent: config.agent,
      agentSource: config.agentSource,
      inputFiles: config.inputFiles ?? [],
      outputFiles: config.outputFiles ?? [],
    },
    entry,
  );
  if (patch === null)
    return yield* new DocumentTaskRefused({
      message: `'${config.agent}' has no document task: run it as a chat instead.`,
    });
  return { ...config, ...patch };
});
