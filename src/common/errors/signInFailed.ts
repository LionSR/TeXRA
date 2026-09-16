/**
 * The host's TeXRA account sign-in flow never ran to a result: the command,
 * dialog, or loopback flow driving it faulted. A user who abandons the flow
 * is **not** a failure — the implementations answer `false` for that — so a
 * caller can read this tag as "the host never got to ask".
 *
 * Host-neutral (lives in `@common/errors`, like `AgentError`) so the shared
 * team-launch chain and the `SetupPlatform` contract can name it: this is
 * the one tag both sign-in ports fail with — `SetupPlatform.signIn` and the
 * team-availability chain's `signIn` — so a caller matches `SignInFailed`
 * rather than catching `unknown`.
 */

// Third-party imports
import { Data } from 'effect';

export class SignInFailed extends Data.TaggedError('SignInFailed')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
