import type { AgentTrace } from '@agent/trace';
import { createChannelTrace } from '@agent/trace';
import { runInSession, type SessionHandle } from '@agent/runtime';
import {
  agentErrorPresentation,
  classifyAgentError,
  primaryAgentError,
} from '@common/errors/agentErrorClassification';
import { resumeStreamWithRefusalNotice } from '@controllers/session/resumeStreamPresentation';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { StreamTabId } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { launchDesktopAgent } from './desktopAgentLaunch.js';
import { toLogData } from './desktopLogUtils.js';

/**
 * Process-lifetime owner of desktop stream resumption. One process holds a
 * session per open paper; a stream resumes in the session whose transcripts
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

  tryResumeStream(
    streamId: StreamTabId,
    recovery?: RecoveryContinuation,
  ): Promise<boolean> {
    for (const session of this.options.sessions()) {
      if (!session.transcripts.has(streamId)) continue;
      return Promise.resolve(
        runInSession(session, () =>
          this.resumeDesktopStream(streamId, session, recovery),
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

  private async resumeDesktopStream(
    streamId: StreamTabId,
    session: SessionHandle,
    recovery: RecoveryContinuation | undefined,
  ): Promise<boolean> {
    let transcriptMissing = false;
    const isCancellationRequested = (): boolean => {
      if (!transcriptMissing && !session.transcripts.has(streamId)) {
        transcriptMissing = true;
      }
      return this.shuttingDown || transcriptMissing || !this.isOpen(session);
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
            { modelHandlerCompatibilityKey },
          ),
      });
    } catch (error) {
      if (isCancellationRequested()) return false;
      this.logger.error(`Failed to resume desktop stream ${streamId}`, {
        data: toLogData(error),
      });
      const primaryError = primaryAgentError(error);
      const presentation = agentErrorPresentation({
        kind: classifyAgentError(primaryError),
        message: `Resume failed: ${toErrorMessage(primaryError)}`,
      });
      if (presentation?.type === 'instruction') {
        session.interactions.emit(
          'requestShowInstruction',
          presentation.payload,
          { replayWhenAttached: true },
        );
      } else if (presentation?.type === 'error') {
        session.interactions.emit('requestShowError', presentation.payload, {
          replayWhenAttached: true,
        });
      }
      return false;
    }
  }
}
