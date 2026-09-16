/**
 * The host's TeXRA account sign-in flow never ran to a result: the command,
 * dialog, or loopback flow driving it faulted. The extension and desktop
 * implementations answer `false` when the user cancels; the CLI loopback has
 * no boolean cancel value and surfaces abandonment or timeout through
 * `SignInFailed`.
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
