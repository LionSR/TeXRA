/**
 * The failures the Effect surface names (`@texra-ai/harness`). Six are defined
 * here — the plugin list the package refuses, the two launch refusals an
 * embedder branches on, the resume refusal, a trace no reader can take, and
 * the run's own failure — and three more reach the surface from the session
 * store (`DatabaseOpenFailed`, `DatabaseReadFailed`, `SessionOptionsConflict`:
 * the `SessionOpenError` union in `@shared/session/database`), for nine
 * tagged errors on the surface in all.
 *
 * Request failures are not here. A `session.request` answers with the
 * runtime's own `RequestError` union (`@shared/session/requestErrors`), the
 * same values every TeXRA host reads, so the package adds no second
 * vocabulary for them.
 */
import { Data } from 'effect';

import type { FollowUpFailureReason } from '@agent/followUp/ToolUseFollowUp';

/**
 * The plugin list cannot be composed: an id that is not lowercase letters,
 * digits and dashes, an id or tool name listed twice, two plugins that
 * continue parked runs, or a switch on a plugin with no availability probe.
 */
export class PluginsRefused extends Data.TaggedError('PluginsRefused')<{
  readonly message: string;
}> {}

/** No agent of that name in the configured agent directory. */
export class AgentNotFound extends Data.TaggedError('AgentNotFound')<{
  readonly agent: string;
  readonly message: string;
}> {}

/**
 * The tools the caller passed cannot run here: a tool that requires
 * approval, on a session opened without an approval handler.
 */
export class ToolsRefused extends Data.TaggedError('ToolsRefused')<{
  readonly tools: readonly string[];
  readonly message: string;
}> {}

/** A run that failed on its own. `cause` is exactly what the launch path
 *  threw. */
export class RunFailure extends Data.TaggedError('RunFailure')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/**
 * A run `session.resume` will not continue, for the runtime's reason:
 * `finished` (nothing left to continue), `owned_elsewhere` (another live
 * process holds it), `blocked` (an agent or plugin it needs is missing
 * here), `unusable_checkpoint` (its saved state cannot be continued), or
 * `not_resumable` (it is running here, it was deleted, or it is a child an
 * open call of its parent owns, which resumes with that parent).
 */
export class ResumeRefused extends Data.TaggedError('ResumeRefused')<{
  readonly runId: string;
  readonly reason: Exclude<FollowUpFailureReason, 'read_failed' | 'not_parent'>;
  readonly message: string;
}> {}

/**
 * A run's trace that no reader can take any more: `ended` (the run settled
 * with nobody reading, so its buffered trace went with it) or `truncated`
 * (it passed the handover buffer before a reader attached, so the trace
 * was detached). The run itself is unaffected: its `result` still answers.
 */
export class TraceUnavailable extends Data.TaggedError('TraceUnavailable')<{
  readonly runId: string;
  readonly reason: 'ended' | 'truncated';
  readonly message: string;
}> {}

/** What a launch refuses before any model work: the two an embedder
 *  branches on. A run that fails after admission fails with
 *  {@link RunFailure} instead. */
export type LaunchError = AgentNotFound | ToolsRefused;
