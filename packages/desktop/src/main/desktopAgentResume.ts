import { Cause, Effect } from 'effect';

import { presentAgentFailure, type SessionHandle } from '@agent/runtime';
import {
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import {
  resumeCancellationLatch,
  resumeRunWithRefusalNotice,
} from '@controllers/session/resumeRunPresentation';
import { withLogChannel } from '@logger/effectLog';
import type { ProcessRuntime } from '@platform/processRuntime';
import {
  AgentResumeFailed,
  type RecoveryContinuation,
} from '@platform/interfaces';
import type { RunId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { launchDesktopAgent } from './desktopAgentLaunch.js';

/**
 * Process-lifetime owner of desktop run resumption. One process holds a
 * session per open paper; a run resumes in the session whose transcripts
 * hold it, inside that session's scope. The open-session set is read from
 * the paper registry, so a closing paper stops being a resume target the
 * moment the registry drops it.
 */
export class DesktopProcessResumeOwner {
  private shuttingDown = false;

  constructor(
    private readonly options: {
      /** The sessions open right now: every paper's and the no-workspace one. */
      readonly sessions: () => Iterable<SessionHandle>;
      /**
       * The process runtime the composition root builds. Read through a thunk
       * for one reason: this owner is constructed before
       * `initializeElectronPlatform`, which is what builds that runtime, and
       * is handed to it as the resume port. The thunk closes over the entry's
       * own local, not over a process-wide lookup.
       */
      readonly runtime: () => ProcessRuntime;
      /**
       * After an awaited resume launch settles. The composition root
       * recomputes the onboarding funnel here so a first run that completes
       * via resume still clears the setup card.
       */
      readonly onLaunchSettled?: () => void;
    },
  ) {}

  /** Shutdown: no resume launches from here on, and in-flight ones cancel. */
  disable(): void {
    this.shuttingDown = true;
  }

  tryResumeRun(
    runId: RunId,
    recovery?: RecoveryContinuation,
  ): Effect.Effect<boolean, AgentResumeFailed> {
    for (const session of this.options.sessions()) {
      if (session.runView(runId) === undefined) continue;
      return this.resumeDesktopRun(runId, session, recovery);
    }
    return Effect.succeed(false);
  }

  private isOpen(session: SessionHandle): boolean {
    return [...this.options.sessions()].includes(session);
  }

  private resumeDesktopRun(
    runId: RunId,
    session: SessionHandle,
    recovery: RecoveryContinuation | undefined,
  ): Effect.Effect<boolean, AgentResumeFailed> {
    const isCancellationRequested = resumeCancellationLatch(
      session,
      runId,
      () => this.shuttingDown || !this.isOpen(session),
    );
    // The session's view is this process's fold; the run may have been
    // deleted by another process since the row it folded. Read the rows
    // before resuming: neither the lease (a deleted run holds none) nor the
    // run roster (in-process only) sees that fact.
    if (isCancellationRequested()) return Effect.succeed(false);
    const runtime = this.options.runtime();
    const attempt = Effect.gen(function* () {
      const exists = (yield* session.transcripts.readEvents(runId)).length > 0;
      if (!exists) return false;
      return yield* resumeRunWithRefusalNotice(runId, {
        session,
        recovery,
        isCancellationRequested,
        executeWorkflow: (config, id, modelCompatibilityKey) =>
          launchDesktopAgent(
            { kind: 'resume', config, runId: id },
            { session, runtime },
            { modelCompatibilityKey },
          ),
      });
    });
    // The resume is composed, not awaited: it takes the services the port's
    // Effect may not require, so they come from this runtime's context on the
    // fiber that runs it. Every fault is still this owner's to report and
    // answer `false` for, as the caught rejection was.
    return Effect.flatMap(runtime.contextEffect, (context) =>
      Effect.provideContext(attempt, context),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.suspend(() => {
          const error = Cause.squash(cause);
          if (isCancellationRequested()) return Effect.succeed(false);
          const primaryError = primaryAgentError(error);
          return Effect.logError(`Failed to resume desktop run ${runId}`).pipe(
            Effect.annotateLogs({ data: error }),
            withLogChannel('DesktopAgentResume'),
            Effect.andThen(
              presentAgentFailure(
                session.interactions,
                {
                  kind: classifyAgentError(primaryError),
                  message: `Resume failed: ${toErrorMessage(primaryError)}`,
                },
                { replayWhenAttached: true },
              ).pipe(Effect.as(false)),
            ),
          );
        }),
      ),
      Effect.ensuring(Effect.sync(() => this.options.onLaunchSettled?.())),
    );
  }
}
