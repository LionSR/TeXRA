import { type Cause, Data, Effect } from 'effect';
import * as vscode from 'vscode';

import { settleFailure } from '@auth/authProgram';
import { SupabaseAuth } from '@auth/SupabaseAuth';
import { type OAuthProvider } from '@auth/config';
import { AUTH_PROVIDER_ID } from '@auth/constants';
import { SupabaseAuthProvider } from '@frontend/auth/SupabaseAuthProvider';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'authCommands';

type AuthMethod = OAuthProvider | 'github-browser';

interface SignInOption {
  label: string;
  description: string;
  method: AuthMethod;
}

const SIGN_IN_OPTIONS: readonly SignInOption[] = [
  {
    label: '$(globe) Google',
    description: 'Sign in with Google',
    method: 'google',
  },
  {
    label: '$(github) GitHub',
    description: 'Sign in with GitHub via web browser',
    method: 'github-browser',
  },
];

/**
 * A host call one of these commands made faulted. The command reports the
 * fault itself and returns its cancelled outcome, so the tag only carries the
 * cause; `message` is the cause's own text, because the reporting surface
 * adds the "Sign in failed"/"Sign out failed" prefix.
 */
class AuthCommandFailed extends Data.TaggedError('AuthCommandFailed')<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const authCommandFailed = (cause: unknown): AuthCommandFailed =>
  new AuthCommandFailed({ message: toErrorMessage(cause), cause });

/**
 * One auth-provider program's failure as this command's own fault, folded
 * through the auth subsystem's settle rule so the reported error is the port's
 * own — the error its Promise edge used to reject with.
 */
const authCommandFault = (
  cause: Cause.Cause<unknown>,
): Effect.Effect<never, AuthCommandFailed> =>
  Effect.fail(authCommandFailed(settleFailure(cause)));

/** An information toast, on the fault path the commands already report. */
const showInfo = (message: string): Effect.Effect<void, AuthCommandFailed> =>
  Effect.try({
    try: () => {
      void vscode.window.showInformationMessage(message);
    },
    catch: authCommandFailed,
  });

// "<prefix> <email>" info toast.
const showSignedInMessage = (
  prefix: string,
): Effect.Effect<void, AuthCommandFailed, SupabaseAuth> =>
  Effect.gen(function* () {
    const auth = yield* SupabaseAuth;
    const user = yield* auth.user;
    const email = user?.email || 'unknown user';
    yield* showInfo(`${prefix} ${email}`);
  });

/**
 * Run the interactive sign-in flow.
 *
 * Succeeds with `true` when the user is authenticated by the time this
 * settles (already signed in, or completed an OAuth flow), and with `false`
 * when the user cancelled or hit an error. A host call that faults is
 * reported here and answered as `false`, so nothing reaches the error
 * channel and the host entry only has to run the program.
 */
export const signIn: Effect.Effect<
  boolean,
  never,
  AgentCatalogServices | SupabaseAuth
> = Effect.gen(function* () {
  // Check if auth system is ready - if not, provide clear error with reason
  const auth = yield* SupabaseAuth;
  const authReady = yield* auth.isReady;
  if (!authReady) {
    const reason =
      auth.getInitError()?.message ?? 'Authentication service not initialized';
    yield* Effect.forkDetach(
      showLoggedMessage(
        CHANNEL,
        `Sign in failed: ${reason}. Try reloading VS Code (Ctrl+Shift+P → "Reload Window"). If the problem continues, open Help → Toggle Developer Tools → Console for details.`,
      ),
    );
    return false;
  }

  const showAuthServiceUnavailable = showLoggedMessage(
    CHANNEL,
    'The authentication service is temporarily unavailable. Your stored session has not been removed; try again later.',
  );

  let storedSessionState = yield* auth.storedSessionState;
  if (storedSessionState === 'invalid') {
    const cleared = yield* (
      SupabaseAuthProvider.getInstance()?.clearStoredSession() ??
      Effect.succeed(false)
    ).pipe(Effect.catchCause(authCommandFault));
    storedSessionState = cleared ? 'none' : yield* auth.storedSessionState;
  }
  if (storedSessionState === 'transient') {
    yield* Effect.forkDetach(showAuthServiceUnavailable);
    return false;
  }

  if (storedSessionState === 'authenticated') {
    // Auth readiness was established above, so the VS Code auth API is safe
    // to consult here (calling it before readiness can hang on a timeout).
    const existing = yield* Effect.tryPromise({
      try: () =>
        Promise.resolve(
          vscode.authentication.getSession(AUTH_PROVIDER_ID, [], {
            silent: true,
          }),
        ),
      catch: authCommandFailed,
    });
    if (existing) {
      yield* showSignedInMessage('Already signed in as');
      return true;
    }
    yield* Effect.forkDetach(showAuthServiceUnavailable);
    return false;
  }

  // Each option names its own provider, so a second "sign in to…" line
  // would only repeat the title.
  const selected = yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        vscode.window.showQuickPick<SignInOption>(SIGN_IN_OPTIONS, {
          title: 'Sign in to TeXRA',
          placeHolder: 'Choose a sign-in method',
        }),
      ),
    catch: authCommandFailed,
  });
  if (!selected) return false;

  const session = yield* Effect.tryPromise({
    try: () =>
      Promise.resolve(
        vscode.authentication.getSession(
          AUTH_PROVIDER_ID,
          [`provider:${selected.method}`],
          { createIfNone: true },
        ),
      ),
    catch: authCommandFailed,
  });

  if (session) {
    yield* showSignedInMessage('Signed in as');
    return true;
  }
  return false;
}).pipe(
  Effect.catchTag('AuthCommandFailed', (failure) =>
    Effect.forkDetach(
      showLoggedErrorMessage(CHANNEL, 'Sign in failed', failure.cause),
    ).pipe(Effect.as(false)),
  ),
);

/** Sign out of the stored TeXRA session, after confirming with the user. */
export const signOut: Effect.Effect<
  void,
  never,
  AgentCatalogServices | SupabaseAuth
> = Effect.gen(function* () {
  const auth = yield* SupabaseAuth;
  const storedSessionState = yield* auth.storedSessionState;
  if (storedSessionState === 'none') {
    yield* showInfo('Not signed in');
    return;
  }

  const confirmed = yield* vscodeUi
    .confirm('Are you sure you want to sign out?', { confirmLabel: 'Sign out' })
    .pipe(Effect.mapError(authCommandFailed));
  if (!confirmed) return;

  const authProvider = SupabaseAuthProvider.getInstance();
  if (!authProvider) {
    yield* Effect.forkDetach(
      showLoggedMessage(
        CHANNEL,
        'Sign-out is unavailable right now. Reload the window, then try again.',
      ),
    );
    return;
  }
  const removed = yield* authProvider
    .removeStoredSession()
    .pipe(Effect.catchCause(authCommandFault));
  yield* showInfo(removed ? 'Signed out' : 'You were already signed out');
}).pipe(
  Effect.catchTag('AuthCommandFailed', (failure) =>
    Effect.forkDetach(
      showLoggedErrorMessage(CHANNEL, 'Sign out failed', failure.cause),
    ).pipe(Effect.asVoid),
  ),
);
