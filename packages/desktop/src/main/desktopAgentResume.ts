import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  describeFollowUpFailure,
  resumeStream,
  trackTerminalResultPresentation,
  type SessionHandle,
} from '@agent/runtime';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
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
    return resumeDesktopStream(streamId, context, recovery);
  }
}

async function resumeDesktopStream(
  streamId: StreamTabId,
  context: DesktopResumeContext,
  recovery: RecoveryContinuation | undefined,
): Promise<boolean> {
  const { session } = context;
  if (!session.transcripts.has(streamId)) return false;
  let transcriptMissing = false;
  const isCancellationRequested = (): boolean => {
    if (!transcriptMissing && !session.transcripts.has(streamId)) {
      transcriptMissing = true;
    }
    return context.isCancellationRequested() || transcriptMissing;
  };
  // The resident transcript index is a cache of this process; the stream may
  // have been deleted from the durable transcript store by another process
  // since it was loaded. Read the store before resuming: neither the lease
  // (a deleted stream holds none) nor the execution lane (in-process only)
  // sees that fact.
  if (!(await session.transcripts.hasAuthoritativeStream(streamId))) {
    return false;
  }
  if (isCancellationRequested()) return false;
  const terminalResult = trackTerminalResultPresentation(
    session,
    (event) => event.streamId === streamId,
  );
  try {
    const result = await resumeStream(streamId, {
      session,
      recovery,
      runtimeUnavailableTools: (
        await import('@tools/registry')
      ).getDefaultUnavailableToolNames('desktop'),
      isCancellationRequested,
      executeWorkflow: (config, id, modelHandlerCompatibilityKey) =>
        launchDesktopAgent(
          { kind: 'resume', config, executionId: id },
          { session },
          { modelHandlerCompatibilityKey, suppressErrorNotification: true },
        ),
    });
    if ('started' in result) return result.delivered;
    if (!isCancellationRequested()) {
      // Same info-styled channel the sibling progress-view follow-up path
      // uses for this wording; desktop renders it as an 'info' message box.
      await session.interactions.emit(
        'requestShowInstruction',
        {
          key: 'resumeRefused',
          message: describeFollowUpFailure(result.failed),
          showSuppress: false,
        },
        { replayWhenAttached: true },
      );
    }
    return false;
  } catch (error) {
    if (isCancellationRequested()) return false;
    context.logger.error(`Failed to resume desktop stream ${streamId}`, {
      data: toLogData(error),
    });
    terminalResult.reportUnhandled(() =>
      session.interactions.emit(
        'requestShowError',
        { message: `Resume failed: ${toErrorMessage(error)}` },
        { replayWhenAttached: true },
      ),
    );
    return false;
  } finally {
    terminalResult.dispose();
  }
}
