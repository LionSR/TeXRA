// Agent imports
import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  isResumeInFlight,
  resolveAndResumeStream,
} from '@agent/runtime/resolveAndResumeStream';
import { resumeQueuedToolUseFromResumeData } from '@agent/runtime/resumeQueuedToolUse';
import { trackTerminalResultPresentation } from '@agent/runtime/terminalResultToast';

// Shared imports
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports
import {
  DESKTOP_UNAVAILABLE_TOOLS,
  launchDesktopAgent,
} from './desktopAgentLaunch.js';
import { toLogData } from './desktopLogUtils.js';

interface DesktopResumeState {
  readonly runState: AgentConfig;
  readonly executionId?: ExecutionId;
  readonly parentStreamId?: StreamTabId;
}

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

  tryResumeStream(streamId: StreamTabId): Promise<boolean> {
    return this.context
      ? resumeDesktopStream(streamId, this.context)
      : Promise.resolve(false);
  }

  isResumeInFlight(streamId: StreamTabId): boolean {
    return this.context ? isResumeInFlight(streamId) : false;
  }
}

async function resolveDesktopResumeState(
  streamId: StreamTabId,
  context: DesktopResumeContext,
): Promise<DesktopResumeState | undefined> {
  let runState = context.session.snapshots.getRunConfig(streamId);
  let executionId = context.session.snapshots.getExecutionId(streamId);
  if (runState && executionId) {
    const parentStreamId =
      context.session.snapshots.getParentStreamId(streamId);
    return {
      runState,
      executionId,
      ...(parentStreamId !== undefined && { parentStreamId }),
    };
  }

  try {
    await context.session.snapshots.preload([streamId]);
  } catch (error) {
    context.logger.warn(
      `Failed to read persisted resume data for ${streamId}`,
      { data: toLogData(error) },
    );
    return undefined;
  }
  runState = context.session.snapshots.getRunConfig(streamId);
  executionId =
    executionId ?? context.session.snapshots.getExecutionId(streamId);
  if (!runState || !context.session.transcripts.has(streamId)) return undefined;

  const parentStreamId = context.session.snapshots.getParentStreamId(streamId);
  return {
    runState,
    ...(executionId && { executionId }),
    ...(parentStreamId !== undefined && { parentStreamId }),
  };
}

function resumeDesktopStream(
  streamId: StreamTabId,
  context: DesktopResumeContext,
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
  const runtimeHost = context.session.interactions;
  return resolveAndResumeStream(streamId, {
    runtimeHost,
    streamStatus: context.session.status,
    resolveResumeState: async (id) => {
      const resumeState = await resolveDesktopResumeState(id, context);
      if (isResumeInvalidated()) return undefined;
      if (!resumeState) {
        await context.session.interactions.showInfoMessage(
          'No persisted run state was found for this stream. Start a new run instead.',
          { replayWhenAttached: true },
        );
        return undefined;
      }
      if (!resumeState.executionId) {
        await context.session.interactions.showInfoMessage(
          'This stream has no persisted execution id. Start a new run instead.',
          { replayWhenAttached: true },
        );
        return undefined;
      }
      return {
        runState: resumeState.runState,
        executionId: resumeState.executionId,
        ...(resumeState.parentStreamId !== undefined && {
          parentStreamId: resumeState.parentStreamId,
        }),
      };
    },
    resumeToolUse: (snapshot) =>
      resumeQueuedToolUseFromResumeData(
        snapshot.streamId,
        snapshot,
        runtimeHost,
        {
          session: context.session,
          runtimeUnavailableTools: DESKTOP_UNAVAILABLE_TOOLS,
          canAcquireResumeLease,
          isCancellationRequested: isResumeInvalidated,
          onError: (error) => reportUnhandledFailure(streamId, error),
        },
      ),
    executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
      launchDesktopAgent(
        { config, executionId },
        {
          ready: Promise.resolve(),
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
  }).finally(terminalResult.dispose);
}
