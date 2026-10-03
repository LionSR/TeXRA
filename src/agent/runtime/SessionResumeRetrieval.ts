/**
 * Session resume data retrieval: the identity a host needs to launch a
 * resumed run, read from the durable run facts. Every run resumes from the
 * same fact: the run aggregate's latest `run.snapshot`, one indexed read,
 * or, for a run registered and never opened, its registration. The run's
 * state is `RunHistory.load`, folded by the loop that continues it; nothing
 * here parses a checkpoint.
 */

import { Effect } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { deriveResumability } from '@agent/storage/resumability';
import { withLogChannel } from '@logger/effectLog';
import type { RunId } from '@shared/schemas';

const CHANNEL = 'SessionResumeRetrieval';

/** What resuming a run needs, whichever category it is. */
export interface ResumeData {
  /** The run's configuration: its model the one its latest snapshot names,
   *  or, for a run never opened, the one it was registered with. */
  readonly agentConfig: AgentConfig;
  readonly runId: RunId;
}

/**
 * Retrieve resume data for a run.
 *
 * @returns The resume identity, or `null` when there is nothing to resume
 *   (no `run.snapshot`, and not a run that was never opened). Fails when the durable facts
 *   cannot be read, so the caller can distinguish "nothing to resume" from
 *   "resume failed" instead of silently abandoning the session.
 */
export const retrieveSessionResumeData = Effect.fn('retrieveSessionResumeData')(
  function* (
    runId: RunId,
    agentConfig: AgentConfig,
    session: SessionHandle,
  ): Effect.fn.Return<ResumeData | null, Error> {
    const type = agentConfig.agentCategory;
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
    yield* Effect.logDebug(
      `Retrieved ${type} resume data for run: ${runId}`,
    ).pipe(withLogChannel(CHANNEL));
    // A run never opened is on the model it was registered with.
    return resumability.kind === 'unopened'
      ? { runId, agentConfig }
      : {
          runId,
          agentConfig: {
            ...agentConfig,
            model: resumability.snapshot.runtime.modelId,
          },
        };
  },
);
