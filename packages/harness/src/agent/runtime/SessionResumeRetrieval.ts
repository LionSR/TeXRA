/**
 * Session resume data retrieval: the identity a host needs to launch a
 * resumed run, read from the durable run facts: whether the run can resume,
 * and its configuration, whose model is the one the run is on (a switch
 * writes a new `run.config`). The run's state is `RunHistory.load`, folded
 * by the loop that continues it.
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
  /** The run's configuration, as its newest `run.config` holds it. */
  readonly agentConfig: AgentConfig;
  readonly runId: RunId;
}

/**
 * Retrieve resume data for a run.
 *
 * @returns The resume identity, or `null` when there is nothing to resume
 *   (never opened by its loop, and not a run waiting to be). Fails when the durable facts
 *   cannot be read, so the caller can distinguish "nothing to resume" from
 *   "resume failed" instead of silently abandoning the session.
 */
export const retrieveSessionResumeData = Effect.fn('retrieveSessionResumeData')(
  function* (
    runId: RunId,
    agentConfig: AgentConfig,
    session: SessionHandle,
  ): Effect.fn.Return<ResumeData | null, Error> {
    const resumability = yield* deriveResumability(runId, session);
    if (resumability.kind === 'unreadable') {
      return yield* Effect.fail(
        new Error(
          `Failed to retrieve resume data for run: ${runId}: ${resumability.cause}`,
        ),
      );
    }
    if (resumability.kind === 'none') {
      yield* Effect.logWarning('Run is not resumable').pipe(
        Effect.annotateLogs({ data: { agent: agentConfig.agent, runId } }),
        withLogChannel(CHANNEL),
      );
      return null;
    }
    yield* Effect.logDebug(`Retrieved resume data for run: ${runId}`).pipe(
      withLogChannel(CHANNEL),
    );
    return { runId, agentConfig };
  },
);
