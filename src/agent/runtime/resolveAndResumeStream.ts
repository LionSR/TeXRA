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
import type { TaskState } from '@agent/core/state/TaskState';
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

import { retrieveSessionResumeData } from './SessionResumeRetrieval';
import { StreamStatusService } from './StreamStatusService';
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { ModelHandlerCompatibilityKey } from './modelHandlerCompatibilityKey';

export interface ResumeStreamPorts {
  /** Runtime host receiving the RESUMING/WAITING status updates. */
  readonly runtimeHost: AgentRuntimeHost;
  /**
   * Resolve the persisted task state + execution id for a stream, or `undefined`
   * when there is nothing to resume. The host owns any "no state" messaging it
   * surfaces in the `undefined` case (the orchestrator stays silent there).
   */
  resolveResumeState(
    streamId: StreamTabId,
  ): Promise<{ taskState: TaskState; executionId: ExecutionId } | undefined>;
  /** Resume a tool-use snapshot (host injects its failure surface). */
  resumeToolUseSnapshot(snapshot: ToolUseSessionSnapshot): Promise<boolean>;
  /**
   * Launch a workflow resume run. The extension re-parses the config and opens
   * the final output; the desktop runs it directly and opens its own preview —
   * so this stays host-injected rather than unifying the runAgent options.
   */
  executeWorkflow(
    config: AgentConfig,
    executionId: ExecutionId | undefined,
    modelHandlerCompatibilityKey:
      | ModelHandlerCompatibilityKey
      | null
      | undefined,
  ): Promise<void>;
  /**
   * Surface "this run has no resumable session state" when retrieval succeeds
   * but finds nothing to resume (desktop shows an info dialog; extension noops).
   */
  reportNoResumableSession?(streamId: StreamTabId): void | Promise<void>;
  /** Surface an unexpected resume failure (desktop dialog; extension log). */
  reportFailure?(streamId: StreamTabId, error: unknown): void | Promise<void>;
}

/**
 * Streams whose resume has been accepted and is still preparing. Module-level so
 * a single host-initiated resume is visible to the queued-delivery wake path
 * (`AgentResumePort.isResumeInFlight`) across every entry point and host, and so
 * a concurrent wake cannot launch a duplicate resume.
 */
const resumeInFlight = new Set<StreamTabId>();

export function isResumeInFlight(streamId: StreamTabId): boolean {
  return resumeInFlight.has(streamId);
}

/**
 * Attempt to resume a WAITING / children-running stream from its persisted
 * state. Returns `true` when the resume reached the run lifecycle, `false`
 * otherwise (already active/resuming, nothing to resume, or a handled failure).
 */
export async function resolveAndResumeStream(
  streamId: StreamTabId,
  ports: ResumeStreamPorts,
): Promise<boolean> {
  if (
    StreamStatusService.isActiveOrResuming(streamId) ||
    resumeInFlight.has(streamId)
  ) {
    return false;
  }

  resumeInFlight.add(streamId);
  let ownsResumingStatus = false;
  try {
    const resolved = await ports.resolveResumeState(streamId);
    // The host's resolveResumeState owns its own "no persisted state" messaging.
    if (!resolved) return false;

    const resume = await retrieveSessionResumeData(
      streamId,
      resolved.executionId,
      resolved.taskState,
    );
    if (!resume) {
      await ports.reportNoResumableSession?.(streamId);
      return false;
    }

    // Re-check after the async retrieval window: `resumeInFlight` (held here)
    // blocks only a second resume entry, not a concurrent non-resume run launch
    // that flips this stream active/resuming while we awaited retrieval. If that
    // happened, abandon the resume rather than clobbering the launched run's
    // status.
    if (StreamStatusService.isActiveOrResuming(streamId)) {
      return false;
    }

    if (resume.type === 'toolUse') {
      // The tool-use helper owns the RESUMING flip + follow-up dance.
      return await ports.resumeToolUseSnapshot(resume.snapshot);
    }

    // Flip to RESUMING synchronously before awaiting the launch so a concurrent
    // queued-delivery wake sees the stream as active/resuming (alongside
    // isResumeInFlight) instead of re-poking the resume port and releasing the
    // queue this resume is about to drain.
    ownsResumingStatus = true;
    StreamStatusService.set(streamId, STREAM_STATUS.RESUMING, {
      runtimeHost: ports.runtimeHost,
    });
    await ports.executeWorkflow(
      resume.agentConfig,
      resume.executionId,
      resume.modelHandlerCompatibilityKey,
    );
    return true;
  } catch (error) {
    // Only the early-failure path leaves the stream RESUMING (a started run owns
    // its own status); settle it back to WAITING before surfacing the error so a
    // blocking host dialog cannot hold the stream in RESUMING.
    if (
      ownsResumingStatus &&
      StreamStatusService.get(streamId) === STREAM_STATUS.RESUMING
    ) {
      StreamStatusService.set(streamId, STREAM_STATUS.WAITING, {
        runtimeHost: ports.runtimeHost,
      });
    }
    await ports.reportFailure?.(streamId, error);
    return false;
  } finally {
    resumeInFlight.delete(streamId);
  }
}
