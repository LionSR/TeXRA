import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  describeResumeFailure,
  describeResumeStateResolution,
  resolveAndResumeStream,
  resolveResumeStateFromSnapshots,
  resumeQueuedToolUseFromResumeData,
  resumeStreamWithRecovery,
  trackTerminalResultPresentation,
  type SessionHandle,
} from '@agent/runtime';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import { launchDesktopAgent } from './desktopAgentLaunch.js';
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
    return resumeStreamWithRecovery(
      context.session,
      streamId,
      (claimedRecovery) =>
        resumeDesktopStream(streamId, context, claimedRecovery),
      recovery,
    );
  }
}

async function resumeDesktopStream(
  streamId: StreamTabId,
  context: DesktopResumeContext,
  recovery: RecoveryContinuation,
): Promise<boolean> {
  if (!context.session.transcripts.has(streamId)) return false;
  const terminalResult = trackTerminalResultPresentation(
    context.session,
    (event) => event.streamId === streamId,
  );
  let transcriptMissing = false;
  const isResumeInvalidated = (): boolean => {
    if (!transcriptMissing && !context.session.transcripts.has(streamId)) {
      transcriptMissing = true;
    }
    return context.isCancellationRequested() || transcriptMissing;
  };
  const reportUnhandledFailure = (id: StreamTabId, error: unknown): void => {
    context.logger.error(`Failed to resume desktop stream ${id}`, {
      data: toLogData(error),
    });
    terminalResult.reportUnhandled(() =>
      context.session.interactions.emit(
        'requestShowError',
        { message: describeResumeFailure(error).message },
        { replayWhenAttached: true },
      ),
    );
  };
  // The resident transcript index is a cache of this process; the stream may
  // have been deleted from the durable transcript store by another process
  // since it was loaded. Read the store before resuming: neither the lease
  // (a deleted stream holds none) nor the execution lane (in-process only)
  // sees that fact.
  if (!(await context.session.transcripts.hasAuthoritativeStream(streamId))) {
    return false;
  }
  if (isResumeInvalidated()) return false;
  return resolveAndResumeStream(
    streamId,
    {
      executions: context.session.executions,
      resolveResumeState: (id) =>
        resolveResumeStateFromSnapshots(context.session.snapshots, id),
      reportResumeStateResolution: async (id, resolution) => {
        if (resolution.status === 'read-failed') {
          context.logger.warn(
            `Failed to read persisted resume data for ${id}`,
            {
              data: toLogData(resolution.error),
            },
          );
        }
        await context.session.interactions.showInfoMessage(
          describeResumeStateResolution(resolution),
          { replayWhenAttached: true },
        );
      },
      resumeToolUse: async (snapshot, claimedRecovery) => {
        const { getDefaultUnavailableToolNames } =
          await import('@tools/registry');
        return resumeQueuedToolUseFromResumeData(snapshot.streamId, snapshot, {
          session: context.session,
          recovery: claimedRecovery,
          runtimeUnavailableTools: getDefaultUnavailableToolNames('desktop'),
          isCancellationRequested: isResumeInvalidated,
          onError: (error) => reportUnhandledFailure(streamId, error),
        });
      },
      executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
        launchDesktopAgent(
          { kind: 'resume', config, executionId },
          { session: context.session },
          { modelHandlerCompatibilityKey, suppressErrorNotification: true },
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
