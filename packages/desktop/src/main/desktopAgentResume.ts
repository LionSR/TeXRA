import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  resolveAndResumeStream,
  resolveResumeStateFromSnapshots,
  resumeQueuedToolUseFromResumeData,
  trackTerminalResultPresentation,
  type SessionHandle,
} from '@agent/runtime';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  DESKTOP_UNAVAILABLE_TOOLS,
  launchDesktopAgent,
} from './desktopAgentLaunch.js';
import { toLogData } from './desktopLogUtils.js';

interface DesktopResumeContext {
  readonly session: SessionHandle;
  readonly logger: AgentTrace;
  readonly isCancellationRequested: () => boolean;
}

/** Process-lifetime owner of desktop stream resumption. */
export class DesktopProcessResumeOwner {
  private context: DesktopResumeContext | undefined;

  /** Attach the canonical process session after platform initialization. */
  attach(options: { session: SessionHandle }): () => void {
    let cancelled = false;
    const context: DesktopResumeContext = {
      ...options,
      logger: createChannelTrace('DesktopAgentResume'),
      isCancellationRequested: () => cancelled,
    };
    this.context = context;
    return () => {
      cancelled = true;
      if (this.context === context) this.context = undefined;
    };
  }

  tryResumeStream(
    streamId: StreamTabId,
    recovery?: RecoveryContinuation,
  ): Promise<boolean> {
    const context = this.context;
    if (!context) return Promise.resolve(false);
    const claimedRecovery = recovery
      ? context.session.followUps.useRecovery(recovery)
      : context.session.followUps.claimRecovery(streamId, true);
    if (!claimedRecovery) return Promise.resolve(false);
    return resumeDesktopStream(streamId, context, claimedRecovery).finally(
      () => {
        context.session.followUps.release(claimedRecovery, 'recoverable');
      },
    );
  }
}

function resumeDesktopStream(
  streamId: StreamTabId,
  context: DesktopResumeContext,
  recovery: RecoveryContinuation,
): Promise<boolean> {
  if (!context.session.transcripts.has(streamId)) return Promise.resolve(false);
  const terminalResult = trackTerminalResultPresentation(
    context.session,
    (event) => event.streamId === streamId,
  );
  let authoritativeStreamMissing = false;
  const isResumeInvalidated = (): boolean =>
    context.isCancellationRequested() ||
    authoritativeStreamMissing ||
    !context.session.transcripts.has(streamId);
  const canAcquireResumeLease = async (): Promise<boolean> => {
    if (isResumeInvalidated()) return false;
    if (!(await context.session.transcripts.hasAuthoritativeStream(streamId))) {
      authoritativeStreamMissing = true;
      return false;
    }
    return !isResumeInvalidated();
  };
  const reportUnhandledFailure = (id: StreamTabId, error: unknown): void => {
    context.logger.error(`Failed to resume desktop stream ${id}`, {
      data: toLogData(error),
    });
    if (terminalResult.isHandled()) return;
    context.session.interactions.emit(
      'requestShowError',
      { message: `Resume failed: ${toErrorMessage(error)}` },
      { replayWhenAttached: true },
    );
  };
  return resolveAndResumeStream(
    streamId,
    {
      streamStatus: context.session.status,
      resolveResumeState: async (id) => {
        const resolution = await resolveResumeStateFromSnapshots(
          context.session.snapshots,
          id,
        );
        if (resolution.status === 'read-failed') {
          context.logger.warn(
            `Failed to read persisted resume data for ${id}`,
            {
              data: toLogData(resolution.error),
            },
          );
          // A failed read is not proof of absence: falling through would tell
          // the user no run state exists (a false data-loss diagnosis) when
          // the state may be intact behind a transient storage error.
          if (!isResumeInvalidated()) {
            await context.session.interactions.showInfoMessage(
              `Persisted run state could not be read (${toErrorMessage(resolution.error)}). The resume was not started; retry once the storage issue is resolved.`,
              { replayWhenAttached: true },
            );
          }
          return undefined;
        }
        if (isResumeInvalidated()) return undefined;
        if (resolution.status === 'resolved') return resolution.state;
        await context.session.interactions.showInfoMessage(
          resolution.status === 'incomplete' && resolution.runState
            ? 'This stream has no persisted execution id. Start a new run instead.'
            : 'No persisted run state was found for this stream. Start a new run instead.',
          { replayWhenAttached: true },
        );
        return undefined;
      },
      resumeToolUse: (snapshot, claimedRecovery) =>
        resumeQueuedToolUseFromResumeData(snapshot.streamId, snapshot, {
          session: context.session,
          recovery: claimedRecovery,
          runtimeUnavailableTools: DESKTOP_UNAVAILABLE_TOOLS,
          canAcquireResumeLease,
          isCancellationRequested: isResumeInvalidated,
          onError: (error) => reportUnhandledFailure(streamId, error),
        }),
      executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
        launchDesktopAgent(
          { config, executionId },
          {
            session: context.session,
            canAcquireResumeLease,
          },
          {
            modelHandlerCompatibilityKey,
            suppressErrorNotification: true,
          },
        ),
      reportNoResumableSession: () =>
        context.session.interactions.showInfoMessage(
          'This run has no resumable session state. Start a new run instead.',
          { replayWhenAttached: true },
        ),
      reportFailure: reportUnhandledFailure,
      isCancellationRequested: isResumeInvalidated,
    },
    recovery,
  ).finally(terminalResult.dispose);
}
