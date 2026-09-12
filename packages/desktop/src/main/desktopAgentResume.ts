import { Cause, Effect, Exit } from 'effect';

import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  presentAgentFailure,
  runInSession,
  type SessionHandle,
} from '@agent/runtime';
import {
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { resumeRunWithRefusalNotice } from '@controllers/session/resumeRunPresentation';
import { effectRuntime } from '@platform/processRuntime';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { launchDesktopAgent } from './desktopAgentLaunch.js';
import { toLogData } from './desktopLogUtils.js';

/**
 * Process-lifetime owner of desktop run resumption. One process holds a
 * session per open paper; a run resumes in the session whose transcripts
 * hold it, inside that session's scope. The open-session set is read from
 * the paper registry, so a closing paper stops being a resume target the
 * moment the registry drops it.
 */
export class DesktopProcessResumeOwner {
  private readonly logger: AgentTrace =
    createChannelTrace('DesktopAgentResume');
  private shuttingDown = false;

  constructor(
    private readonly options: {
      /** The sessions open right now: every paper's and the no-workspace one. */
      readonly sessions: () => Iterable<SessionHandle>;
    },
  ) {}

  /** Shutdown: no resume launches from here on, and in-flight ones cancel. */
  disable(): void {
    this.shuttingDown = true;
  }

  tryResumeRun(
    runId: RunId,
    recovery?: RecoveryContinuation,
  ): Promise<boolean> {
    for (const session of this.options.sessions()) {
      if (!session.transcripts.has(runId)) continue;
      return Promise.resolve(
        runInSession(session, () =>
          this.resumeDesktopRun(runId, session, recovery),
        ),
      );
    }
    return Promise.resolve(false);
  }

  private isOpen(session: SessionHandle): boolean {
    for (const open of this.options.sessions())
      if (open === session) return true;
    return false;
  }

  private async resumeDesktopRun(
    runId: RunId,
    session: SessionHandle,
    recovery: RecoveryContinuation | undefined,
  ): Promise<boolean> {
    let transcriptMissing = false;
    const isCancellationRequested = (): boolean => {
      if (!transcriptMissing && !session.transcripts.has(runId)) {
        transcriptMissing = true;
      }
      return this.shuttingDown || transcriptMissing || !this.isOpen(session);
    };
    // The resident transcript index is a cache of this process; the run may
    // have been deleted from the durable transcript store by another process
    // since it was loaded. Read the store before resuming: neither the lease
    // (a deleted run holds none) nor the run lane (in-process only)
    // sees that fact.
    if (isCancellationRequested()) return false;
    const result = await effectRuntime().runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const { getDefaultUnavailableToolNames } = yield* Effect.tryPromise({
            try: () => import('@tools/registry'),
            catch: ensureError,
          });
          const exists =
            (yield* session.transcripts.readEvents(runId)).length > 0;
          if (!exists) return false;
          return yield* resumeRunWithRefusalNotice(runId, {
            session,
            recovery,
            runtimeUnavailableTools: getDefaultUnavailableToolNames('desktop'),
            isCancellationRequested,
            executeWorkflow: (config, id, modelCompatibilityKey) =>
              launchDesktopAgent(
                { kind: 'resume', config, runId: id },
                { session },
                { modelCompatibilityKey },
              ),
          });
        }),
      ),
    );
    if (Exit.isSuccess(result)) return result.value;
    const error = Cause.squash(result.cause);
    if (isCancellationRequested()) return false;
    this.logger.error(`Failed to resume desktop run ${runId}`, {
      data: toLogData(error),
    });
    const primaryError = primaryAgentError(error);
    presentAgentFailure(
      session.interactions,
      {
        kind: classifyAgentError(primaryError),
        message: `Resume failed: ${toErrorMessage(primaryError)}`,
      },
      { replayWhenAttached: true },
    );
    return false;
  }
}
