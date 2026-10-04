/**
 * The document task recipe: the one script a document task runs, shipped by
 * the documents plugin as inline source. A document task is a run of its
 * persona opened on this script (`AgentConfig.script`) instead of a model
 * turn; the script calls the persona once per revision through `agent()`
 * and does everything else with the document tools (`./documentTools`).
 * The agent's name is the one literal the source takes; a run records the
 * source it ran, so a resume replays the same program.
 */
import { Effect } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { withChildSpend } from '@agent/storage/runRecords';
import { agentKey } from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';

/** The tools the recipe calls: what a document task's run offers it. */
const DOCUMENT_TASK_TOOLS = [
  'agent',
  'document_context',
  'document_extract',
  'document_compile',
  'document_diff',
  'document_propose',
] as const;

/** The recipe for the persona `agentName`. */
function recipeSource(agentName: string): string {
  return `const agentName = ${JSON.stringify(agentName)};
let revisions = 1;
for (let revision = 0; revision < revisions; revision += 1) {
  phase(\`Revision \${revision + 1}\`);
  const context = await tools.document_context({ revision });
  revisions = context.revisions;
  const reply = await agent(context.prompt, {
    agentName,
    mediaFiles: context.mediaFiles,
    memories: context.memories,
    label: \`Revision \${revision + 1}\`,
  });
  await tools.document_extract({ revision, run: reply.runId });
  await tools.document_compile({ revision });
  await tools.document_diff({ revision });
}
return (await tools.document_propose({})).documents;`;
}

/**
 * The launch of `config`'s agent as a document task: its run opens on the
 * recipe, offers the recipe's tools, and its revisions' agent calls were
 * approved with the launch.
 */
export function documentTaskConfig<
  C extends Pick<AgentConfig, 'agent'> & Partial<AgentConfig>,
>(config: C): C & { readonly script: NonNullable<AgentConfig['script']> } {
  return {
    ...config,
    script: {
      // The exact entry: a bare name would re-resolve to whatever shadows it.
      code: recipeSource(
        config.agentSource
          ? agentKey(config.agentSource, config.agent)
          : config.agent,
      ),
      title: config.agent,
      tools: [...DOCUMENT_TASK_TOOLS],
      kind: 'recipe',
    },
  };
}

/** A document task's result with its revisions' spend (`withChildSpend`). */
export const withRevisionSpend = (
  session: SessionHandle,
  ended: RunEndResult,
): Effect.Effect<RunEndResult, DatabaseReadFailed> =>
  withChildSpend(session, ended.runId, ended.usage).pipe(
    Effect.map((usage) => ({ ...ended, usage })),
  );
