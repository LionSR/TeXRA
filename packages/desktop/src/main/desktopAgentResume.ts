import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import {
  runInSession,
  trackTerminalResultPresentation,
  type SessionHandle,
} from '@agent/runtime';
import { resumeStreamWithRefusalNotice } from '@controllers/session/resumeStreamPresentation';
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

/**
 * Process-lifetime owner of desktop stream resumption. One process holds a
 * session per open paper; a stream resumes in the session whose transcripts
 * hold it, inside that session's scope.
 */
export class DesktopProcessResumeOwner {
  private readonly contexts = new Set<DesktopResumeContext>();

  /** Attach one paper's session once it is ready. */
  attach(options: { session: SessionHandle }): () => void {
    let cancelled = false;
    const context: DesktopResumeContext = {
      ...options,
      logger: createChannelTrace('DesktopAgentResume'),
      isCancellationRequested: () => cancelled,
    };
    this.contexts.add(context);
    return () => {
      cancelled = true;
      this.contexts.delete(context);
    };
  }

  tryResumeStream(
    streamId: StreamTabId,
    recovery?: RecoveryContinuation,
  ): Promise<boolean> {
    for (const context of this.contexts) {
      if (!context.session.transcripts.has(streamId)) continue;
      return Promise.resolve(
        runInSession(context.session, () =>
          resumeDesktopStream(streamId, context, recovery),
        ),
      );
    }
    return Promise.resolve(false);
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
    return await resumeStreamWithRefusalNotice(streamId, {
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
