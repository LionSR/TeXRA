/**
 * The one invocation of the host's TeXRA account sign-in command, as the
 * `Effect` the sign-in ports vend (`SetupPlatform.signIn`, the team-launch
 * chain's `signIn`). VS Code's `executeCommand` rejects once the command is
 * dispatched, so a refused command reaches the caller as `SignInFailed`
 * rather than as `unknown`; a user who abandons the flow answers `false`.
 */

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { AUTH_COMMANDS } from '@auth/constants';
import { SignInFailed } from '@common/errors/signInFailed';
import { toErrorMessage } from '@utils/errors/errorMessage';

export const runSignInCommand = (): Effect.Effect<boolean, SignInFailed> =>
  Effect.tryPromise({
    try: async () =>
      (await vscode.commands.executeCommand<boolean>(AUTH_COMMANDS.SIGN_IN)) ===
      true,
    catch: (cause) =>
      new SignInFailed({
        message: `VS Code could not run the TeXRA sign-in: ${toErrorMessage(cause)}`,
        cause,
      }),
  });
