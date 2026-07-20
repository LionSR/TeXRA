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

// Shared imports
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript';
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
  readonly snapshots: StreamSnapshotStore;
  readonly logger: AgentTrace;
  readonly isCancellationRequested: () => boolean;
}

let activeContext: DesktopResumeContext | undefined;

/** Install the one resume owner for the Electron process session. */
export function installDesktopProcessResumeHandler(options: {
  session: SessionHandle;
  snapshots: StreamSnapshotStore;
}): () => void {
  let cancelled = false;
  const context: DesktopResumeContext = {
    ...options,
    logger: createChannelTrace('DesktopAgentResume'),
    isCancellationRequested: () => cancelled,
  };
  activeContext = context;
  return () => {
    cancelled = true;
    if (activeContext === context) activeContext = undefined;
  };
}

export async function tryResumeDesktopStream(
  streamId: StreamTabId,
): Promise<boolean> {
  return activeContext
    ? resumeDesktopStream(streamId, activeContext)
    : Promise.resolve(false);
}

export function isDesktopResumeInFlight(streamId: StreamTabId): boolean {
  return activeContext ? isResumeInFlight(streamId) : false;
}

async function resolveDesktopResumeState(
  streamId: StreamTabId,
  context: DesktopResumeContext,
): Promise<DesktopResumeState | undefined> {
  let runState = context.snapshots.getRunConfig(streamId);
  let executionId = context.snapshots.getExecutionId(streamId);
  if (runState && executionId) {
    const parentStreamId = context.snapshots.getParentStreamId(streamId);
    return {
      runState,
      executionId,
      ...(parentStreamId !== undefined && { parentStreamId }),
    };
  }

  try {
    await context.snapshots.preload([streamId]);
  } catch (error) {
    context.logger.warn(
      `Failed to read persisted resume data for ${streamId}`,
      { data: toLogData(error) },
    );
    return undefined;
  }
  runState = context.snapshots.getRunConfig(streamId);
  executionId = executionId ?? context.snapshots.getExecutionId(streamId);
  if (!runState) return undefined;

  context.session.transcripts.ensureStream(streamId);
  const parentStreamId = context.snapshots.getParentStreamId(streamId);
  return {
    runState,
    ...(executionId && { executionId }),
    ...(parentStreamId !== undefined && { parentStreamId }),
  };
}

function reportResumeFailure(
  streamId: StreamTabId,
  error: unknown,
  context: DesktopResumeContext,
): void {
  context.logger.error(`Failed to resume desktop stream ${streamId}`, {
    data: toLogData(error),
  });
  context.session.interactions.emit('requestShowError', {
    message: `Resume failed: ${toErrorMessage(error)}`,
  });
}

function resumeDesktopStream(
  streamId: StreamTabId,
  context: DesktopResumeContext,
): Promise<boolean> {
  if (!context.session.transcripts.has(streamId)) return Promise.resolve(false);
  const runtimeHost = context.session.interactions;
  return resolveAndResumeStream(streamId, {
    runtimeHost,
    streamStatus: context.session.status,
    resolveResumeState: async (id) => {
      const resumeState = await resolveDesktopResumeState(id, context);
      if (context.isCancellationRequested()) return undefined;
      if (!resumeState) {
        await context.session.interactions.showInfoMessage(
          'No persisted run state was found for this stream. Start a new run instead.',
        );
        return undefined;
      }
      if (!resumeState.executionId) {
        await context.session.interactions.showInfoMessage(
          'This stream has no persisted execution id. Start a new run instead.',
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
          isCancellationRequested: context.isCancellationRequested,
          onError: (error) => reportResumeFailure(streamId, error, context),
        },
      ),
    executeWorkflow: (config, executionId, modelHandlerCompatibilityKey) =>
      launchDesktopAgent(
        { config, executionId },
        { ready: Promise.resolve(), session: context.session },
        { modelHandlerCompatibilityKey },
      ),
    reportNoResumableSession: () =>
      context.session.interactions.showInfoMessage(
        'This run has no resumable session state. Start a new run instead.',
      ),
    reportFailure: (id, error) => reportResumeFailure(id, error, context),
    isCancellationRequested: context.isCancellationRequested,
  });
}
