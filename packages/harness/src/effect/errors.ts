/**
 * The failures the Effect surface names (`@texra-ai/harness`). Five are
 * defined here — the plugin list the package refuses, the tools a launch
 * refuses, the resume refusal, a trace no reader can take, and the run's own
 * failure. The other launch refusal, an unknown agent, is the agent
 * catalog's (`AgentNotFound`), and three more reach the surface from the
 * session store (`DatabaseOpenFailed`, `DatabaseReadFailed`,
 * `SessionOptionsConflict`: the `SessionOpenError` union in
 * `@shared/session/database`), for nine in the session lifecycle. The entry
 * exports other tagged errors (request, platform-port, agent-catalog and
 * model-route failures); `config/api-reports/harness.api.md` lists the whole
 * surface.
 *
 * Request failures are not defined here. A `session.request` answers with the
 * runtime's own `RequestError` union (`@shared/session/requestErrors`), the
 * same values every TeXRA host reads, so the package adds no second
 * vocabulary for them.
 */
import { Data } from 'effect';

import type { AgentNotFound } from '@agent/index/agentCatalog';
import type { FollowUpFailureReason } from '@agent/followUp/ToolUseFollowUp';

/**
 * The plugin list cannot be composed, for a defect `toolTable` refuses: an
 * id that is not lowercase letters, digits and dashes, an id or tool name
 * listed twice, a second plugin continuing parked runs or recording one
 * request kind's decisions, or a switch on a plugin with no availability
 * probe.
 */
export class PluginsRefused extends Data.TaggedError('PluginsRefused')<{
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
 * with nobody reading, so its buffered trace went with it), `truncated`
 * (it passed the handover buffer before a reader attached, so the trace
 * was detached) or `remote` (the run runs in another process, which keeps
 * its trace). The run itself is unaffected: its `result` still answers.
 */
export class TraceUnavailable extends Data.TaggedError('TraceUnavailable')<{
  readonly runId: string;
  readonly reason: 'ended' | 'truncated' | 'remote';
  readonly message: string;
}> {}

/** What a launch refuses before any model work: the two an embedder
 *  branches on. A run that fails after admission fails with
 *  {@link RunFailure} instead. */
export type LaunchError = AgentNotFound | ToolsRefused;
