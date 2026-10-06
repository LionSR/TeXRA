/**
 * The failures the Effect surface names (`@texra-ai/harness`). Five are defined
 * here — the plugin list the package refuses, the two launch refusals an
 * embedder branches on, the resume refusal, and the run's own failure — and
 * two more reach the surface re-exported from the session store
 * (`DatabaseOpenFailed`, `DatabaseReadFailed`, the `SessionOpenError` union in
 * `@shared/session/database`), for seven tagged errors on the surface in all.
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
 * here), `unusable_checkpoint`, `read_failed` or `not_resumable`.
 */
export class ResumeRefused extends Data.TaggedError('ResumeRefused')<{
  readonly runId: string;
  readonly reason: FollowUpFailureReason;
  readonly message: string;
}> {}

/** What a launch refuses before any model work: the two an embedder
 *  branches on. A run that fails after admission fails with
 *  {@link RunFailure} instead. */
export type LaunchError = AgentNotFound | ToolsRefused;
