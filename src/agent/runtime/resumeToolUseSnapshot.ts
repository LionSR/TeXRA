/**
 * Host-neutral tool-use snapshot resume.
 *
 * Drives the shared queue dance (`resumeQueuedToolUseSnapshot`): acquire the
 * follow-up queue, flip the stream to RESUMING, hand drained follow-ups to the
 * resumed wait cursor, and on failure re-enqueue the follow-ups and settle the
 * stream back to WAITING.
 *
 * Hosts stay thin adapters: they inject only what differs (`runtimeHost`, an
 * optional explicit follow-up typed alongside a manual resume,
 * `runtimeUnavailableTools`, their owning `session`, and a failure surface).
 * The tool-use persistence setting stays host-injected (gated by the extension
 * adapter, ungated on desktop) rather than being applied here, so this leaf does
 * not change either host's pre-unification resume behavior.
 */
import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import { resumeQueuedToolUseSnapshot } from './resumeQueuedToolUse';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

export interface ResumeToolUseHostOptions {
  /** Runtime host that receives the RESUMING/WAITING status + queue updates. */
  readonly runtimeHost: AgentRuntimeHost;
  /** Explicit follow-up typed alongside a manual resume, replayed first. */
  readonly explicitFollowUp?: string;
  /** Tools hidden because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /**
   * Session owning this run's coordination state. Host-path callers (e.g. the
   * desktop progress-view IPC handler) thread their window session; defaults to
   * the process session.
   */
  readonly session?: SessionHandle;
  /**
   * Host-specific failure surface (toast/dialog). Invoked after the stream has
   * been returned to WAITING, so a blocking host dialog cannot strand the stream
   * in RESUMING while it awaits dismissal.
   */
  readonly reportFailure?: (error: unknown) => void | Promise<void>;
}

/**
 * Resume a tool-use session from its persisted snapshot. Returns `true` when the
 * resume reached the run lifecycle, and `false` when the resume failed (the
 * follow-up queue is preserved in that case).
 */
export async function resumeToolUseSnapshot(
  snapshot: ToolUseSessionSnapshot,
  options: ResumeToolUseHostOptions,
): Promise<boolean> {
  return resumeQueuedToolUseSnapshot(
    snapshot.streamId,
    snapshot,
    options.runtimeHost,
    {
      session: options.session,
      runtimeUnavailableTools: options.runtimeUnavailableTools,
      extraFollowUps:
        options.explicitFollowUp !== undefined
          ? [{ text: options.explicitFollowUp, origin: 'user' as const }]
          : [],
      onError: (error) => options.reportFailure?.(error),
      parentStreamId: snapshot.parentStreamId ?? undefined,
    },
  );
}
