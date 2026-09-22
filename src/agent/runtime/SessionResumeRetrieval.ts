/**
 * Session resume data retrieval: the identity a host needs to launch a
 * resumed run, read from the durable run facts. Both families resume from
 * the same fact: the run aggregate's latest `flow.snapshot`, one indexed
 * read. The run's state is `RunLedger.load`, folded by the loop that
 * continues it; nothing here parses a checkpoint.
 */

import { Effect } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { deriveResumability } from '@agent/storage/resumability';
import { withLogChannel } from '@logger/effectLog';
import type {
  FlowSnapshotPayload,
  ModelCompatibilityKey,
  RunId,
} from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';

const CHANNEL = 'SessionResumeRetrieval';

interface ResumeIdentity {
  /** The run's configuration, its model being the one the snapshot names. */
  readonly agentConfig: AgentConfig;
  readonly runId: RunId;
  /** The conversation format the run's rows are in. */
  readonly modelCompatibilityKey: ModelCompatibilityKey | null;
}

export type ToolUseResumeData = ResumeIdentity & { readonly type: 'toolUse' };

type WorkflowResumeData = ResumeIdentity & { readonly type: 'workflow' };

type SessionResumeData = ToolUseResumeData | WorkflowResumeData;

/**
 * Each category's resume family, in one exhaustive table: the resume type a
 * host launches and the snapshot family the run's rows must be in. A new
 * category fails to compile here rather than resolving to nothing at runtime.
 */
const RESUME_BY_CATEGORY: Record<
  AgentConfig['agentCategory'],
  {
    readonly type: SessionResumeData['type'];
    readonly family: FlowSnapshotPayload['family'];
  }
> = {
  [AgentCategory.ToolUse]: { type: 'toolUse', family: 'toolUse' },
  [AgentCategory.Workflow]: { type: 'workflow', family: 'reflection' },
};

/**
 * Retrieve resume data for a run.
 *
 * @returns The resume identity, or `null` when there is nothing to resume
 *   (no `flow.snapshot` on the run aggregate). Fails when the durable facts
 *   cannot be read, or when the snapshot's family contradicts the config's
 *   category, so the caller can distinguish "nothing to resume" from
 *   "resume failed" instead of silently abandoning the session.
 */
export const retrieveSessionResumeData = Effect.fn('retrieveSessionResumeData')(
  function* (
    runId: RunId,
    agentConfig: AgentConfig,
    session: SessionHandle,
  ): Effect.fn.Return<SessionResumeData | null, Error> {
    const { type, family: expectedFamily } =
      RESUME_BY_CATEGORY[agentConfig.agentCategory];
    const resumability = yield* deriveResumability(runId, session);
    if (resumability.kind === 'unreadable') {
      return yield* Effect.fail(
        new Error(
          `Failed to retrieve ${type} resume data for run: ${runId}: ${resumability.cause}`,
        ),
      );
    }
    if (resumability.kind === 'none') {
      yield* Effect.logWarning('Run is not resumable').pipe(
        Effect.annotateLogs({ data: { agentType: type, runId } }),
        withLogChannel(CHANNEL),
      );
      return null;
    }
    const { snapshot } = resumability;
    if (snapshot.family !== expectedFamily) {
      return yield* Effect.fail(
        new Error(
          `Run ${runId} is configured as ${type} but its snapshot is a ${snapshot.family} run.`,
        ),
      );
    }
    yield* Effect.logDebug(
      `Retrieved ${type} resume data for run: ${runId}`,
    ).pipe(
      Effect.annotateLogs({ data: {
        round: snapshot.runtime.round,
        phase: snapshot.runtime.phase,
      } }),
      withLogChannel(CHANNEL),
    );
    return {
      type,
      runId,
      agentConfig: { ...agentConfig, model: snapshot.runtime.modelId },
      modelCompatibilityKey: snapshot.runtime.modelCompatibilityKey,
    };
  },
);
