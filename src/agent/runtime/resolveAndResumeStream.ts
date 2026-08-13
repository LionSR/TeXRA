/**
 * Host-neutral resume orchestrator shared by the VS Code extension and the
 * Electron desktop bridge.
 *
 * Owns the cross-host skeleton — the active/resuming + in-flight guard,
 * resume-data retrieval, and the tool-use vs workflow branch — so hosts collapse
 * to thin injected-port adapters. The forks differ only in how they resolve
 * persisted state, surface failures, and launch the workflow executor; that
 * variation lives entirely in {@link ResumeStreamPorts}.
 */
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { RecoveryContinuation } from '@platform/interfaces';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import {
  retrieveSessionResumeData,
  type ToolUseResumeData,
} from './SessionResumeRetrieval';
import type { StreamStatusMachine } from './StreamStatusService';
import type { SessionHostInteractions } from './HostInteractions';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

interface ResolvedResumeState {
  readonly runState: AgentConfig;
  readonly executionId: ExecutionId;
  readonly parentStreamId?: StreamTabId;
}

export interface ResumeStreamPorts {
  /** Session host interactions receiving the RESUMING/WAITING status updates. */
  readonly interactions: SessionHostInteractions;
  /**
   * The status machine of the session that owns this stream — process-owned on
   * desktop, and the default session's machine in the extension/CLI. The
   * active/resuming guards must read the machine the run actually writes
   * (`launchSession.status`); reading the process-global default here left
   * both guards permanently false in multi-session hosts.
   */
  readonly streamStatus: Pick<StreamStatusMachine, 'isActiveOrResuming'>;
  /** Host-owned cancellation requested while asynchronous resume preparation runs. */
  readonly isCancellationRequested?: () => boolean;
  /**
   * Resolve the persisted run state + execution id for a stream, or `undefined`
   * when there is nothing to resume. The host owns any "no state" messaging it
   * surfaces in the `undefined` case (the orchestrator stays silent there).
   */
  resolveResumeState(
    streamId: StreamTabId,
  ): Promise<ResolvedResumeState | undefined>;
  /** Resume canonical tool-use state (host injects its failure surface). */
  resumeToolUse(
    resume: ToolUseResumeData,
    recovery?: RecoveryContinuation,
  ): Promise<boolean>;
  /**
   * Launch a workflow resume run. The extension re-parses the config and opens
   * the final output; the desktop runs it directly and opens its own preview —
   * so this stays host-injected rather than unifying the runAgent options.
   */
  executeWorkflow(
    config: AgentConfig,
    executionId: ExecutionId | undefined,
    modelHandlerCompatibilityKey:
      ModelHandlerCompatibilityKey | null | undefined,
  ): Promise<void>;
  /**
   * Surface "this run has no resumable session state" when retrieval succeeds
   * but finds nothing to resume (an info message on desktop and in the
   * extension, a transcript line in the CLI).
   */
  reportNoResumableSession?(streamId: StreamTabId): void | Promise<void>;
  /** Surface an unexpected resume failure (desktop dialog; extension log). */
  reportFailure?(streamId: StreamTabId, error: unknown): void | Promise<void>;
}

/**
 * Attempt to resume a WAITING / children-running stream from its persisted
 * state. Returns `true` when the resume reached the run lifecycle, `false`
 * otherwise (already active/resuming, nothing to resume, or a handled failure).
 */
export async function resolveAndResumeStream(
  streamId: StreamTabId,
  ports: ResumeStreamPorts,
  recovery?: RecoveryContinuation,
): Promise<boolean> {
  const isCancellationRequested = (): boolean =>
    ports.isCancellationRequested?.() === true;

  if (
    isCancellationRequested() ||
    ports.streamStatus.isActiveOrResuming(streamId)
  ) {
    return false;
  }

  try {
    const resolved = await ports.resolveResumeState(streamId);
    if (isCancellationRequested()) return false;
    // The host's resolveResumeState owns its own "no persisted state" messaging.
    if (!resolved) return false;

    const resume = await retrieveSessionResumeData(
      streamId,
      resolved.executionId,
      resolved.runState,
      { parentStreamId: resolved.parentStreamId },
    );
    if (isCancellationRequested()) return false;
    if (!resume) {
      await ports.reportNoResumableSession?.(streamId);
      return false;
    }

    // Re-check after the async retrieval window: `resumeInFlight` (held here)
    // blocks only a second resume entry, not a concurrent non-resume run launch
    // that flips this stream active/resuming while we awaited retrieval. If that
    // happened, abandon the resume rather than clobbering the launched run's
    // status.
    if (ports.streamStatus.isActiveOrResuming(streamId)) {
      return false;
    }

    if (resume.type === 'toolUse') {
      // The tool-use helper owns the RESUMING flip + follow-up dance.
      return await ports.resumeToolUse(resume, recovery);
    }

    // Workflow launch owns stream acquisition and status transitions through
    // runAgent/buildAgentLaunchContext. Pre-marking the same stream RESUMING
    // here would make the launch reject itself as already in flight.
    await ports.executeWorkflow(
      resume.agentConfig,
      resume.executionId,
      resume.modelHandlerCompatibilityKey,
    );
    return true;
  } catch (error) {
    if (isCancellationRequested()) return false;
    await ports.reportFailure?.(streamId, error);
    return false;
  }
}
