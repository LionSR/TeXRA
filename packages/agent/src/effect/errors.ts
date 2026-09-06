/**
 * The failures the Effect surface names (`@texra-ai/agent/effect`). Four
 * tagged errors, no more: the process the package refuses to compose, the
 * two launch refusals an embedder branches on, and the run's own failure.
 *
 * Request failures are not here. A `session.request` answers with the
 * runtime's own `RequestError` union (`@shared/session/requestErrors`), the
 * same values every TeXRA host reads, so the package adds no second
 * vocabulary for them.
 */
import { Data } from 'effect';

/**
 * A second, different platform was handed to a process the package already
 * composed. The platform is process-wide by contract, so this is a
 * programming error rather than a condition to retry.
 */
export class PlatformConflict extends Data.TaggedError('PlatformConflict')<{
  readonly message: string;
}> {}

/** No agent of that name in the configured agent directory. */
export class AgentNotFound extends Data.TaggedError('AgentNotFound')<{
  readonly agent: string;
  readonly message: string;
}> {}

/**
 * The tools the caller passed cannot run here: a tool that requires
 * approval (the package has no approval channel), or custom tools handed to
 * a workflow agent.
 */
export class ToolsRefused extends Data.TaggedError('ToolsRefused')<{
  readonly tools: readonly string[];
  readonly message: string;
}> {}

/** A run that failed on its own. `cause` is exactly what the launch path
 *  threw, which is what the Promise entry rejects with. */
export class RunFailure extends Data.TaggedError('RunFailure')<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** What a launch refuses before any model work: the two an embedder
 *  branches on. A run that fails after admission fails with
 *  {@link RunFailure} instead. */
export type LaunchError = AgentNotFound | ToolsRefused;
