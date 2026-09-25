// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  clearStoredSession: vi.fn(() => Effect.succeed(true)),
  getSession: vi.fn(),
  removeStoredSession: vi.fn(() => Effect.succeed(true)),
  showInformationMessage: vi.fn(),
  showLoggedMessage: vi.fn(() => Effect.succeed('')),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  authentication: {
    getSession: authMocks.getSession,
  },
  env: {
    openExternal: vi.fn(),
  },
  Uri: {
    parse: (value: string) => value,
  },
  window: {
    showInformationMessage: authMocks.showInformationMessage,
    showInputBox: vi.fn(),
    showQuickPick: authMocks.showQuickPick,
    showWarningMessage: authMocks.showWarningMessage,
  },
}));

vi.mock('@frontend/auth/SupabaseAuthProvider', () => ({
  SupabaseAuthProvider: {
    getInstance: () => ({
      clearStoredSession: authMocks.clearStoredSession,
      removeStoredSession: authMocks.removeStoredSession,
    }),
  },
}));

vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedErrorMessage: vi.fn(() => Effect.succeed('')),
  showLoggedMessage: authMocks.showLoggedMessage,
}));

// Local imports
import { SupabaseAuth, type SupabaseAuthShape } from '@auth/SupabaseAuth';
import { signIn, signOut } from '@commands/auth/authCommands';
import { AgentDirectories } from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import { fakeSupabaseAuth } from '@test/support/fakeSupabaseAuth';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { fakeHostAgentDirectories } from '@test/support/setupPlatform';

/** Run the command against the fake account plane. */
const withAuth = <A>(
  auth: SupabaseAuthShape,
  program: Effect.Effect<A, never, AgentCatalogServices | SupabaseAuth>,
): Effect.Effect<A> =>
  Effect.provideService(program, SupabaseAuth, auth).pipe(
    Effect.provideService(AgentDirectories, fakeHostAgentDirectories),
    // The sign-out path rebuilds the local agent catalog, which names the
    // process's global storage view and the filesystem its scan reads
    // through; this suite's catalog read is mocked.
    Effect.provide(
      Layer.mergeAll(
        unusedGlobalStorageFs(),
        nodePlatformLayer,
        testHttpClientLayer,
      ),
    ),
  );

describe('auth commands for unavailable stored sessions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.effect(
    'clears an invalid session before opening the sign-in chooser',
    () =>
      Effect.gen(function* () {
        const auth = fakeSupabaseAuth({
          storedSessionState: Effect.succeed('invalid' as const),
        });
        authMocks.showQuickPick.mockResolvedValue(undefined);

        expect(yield* withAuth(auth, signIn)).toBe(false);

        expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
        expect(authMocks.getSession).not.toHaveBeenCalled();
        expect(authMocks.showQuickPick).toHaveBeenCalledOnce();
      }),
  );

  it.effect(
    'preserves the session and defers sign-in during a transient outage',
    () =>
      Effect.gen(function* () {
        const auth = fakeSupabaseAuth({
          storedSessionState: Effect.succeed('transient' as const),
        });

        expect(yield* withAuth(auth, signIn)).toBe(false);

        expect(authMocks.clearStoredSession).not.toHaveBeenCalled();
        expect(authMocks.getSession).not.toHaveBeenCalled();
        expect(authMocks.showQuickPick).not.toHaveBeenCalled();
        expect(authMocks.showLoggedMessage).toHaveBeenCalledWith(
          'authCommands',
          expect.stringContaining('temporarily unavailable'),
        );
      }),
  );

  it.effect('uses a replacement session installed during invalid cleanup', () =>
    Effect.gen(function* () {
      // The first classification answers invalid, the one after the failed
      // clear answers authenticated — the replacement session's.
      let classifications = 0;
      const auth = fakeSupabaseAuth({
        storedSessionState: Effect.suspend(() =>
          Effect.succeed(
            classifications++ === 0
              ? ('invalid' as const)
              : ('authenticated' as const),
          ),
        ),
        user: Effect.succeed({ email: 'user@example.com' } as never),
      });
      authMocks.clearStoredSession.mockReturnValueOnce(Effect.succeed(false));
      authMocks.getSession.mockResolvedValue({
        id: 'replacement',
        account: { id: 'user-id', label: 'user@example.com' },
      });

      expect(yield* withAuth(auth, signIn)).toBe(true);

      expect(authMocks.clearStoredSession).toHaveBeenCalledOnce();
      expect(authMocks.getSession).toHaveBeenCalledOnce();
      expect(authMocks.showQuickPick).not.toHaveBeenCalled();
      expect(authMocks.showInformationMessage).toHaveBeenCalledWith(
        'Already signed in as user@example.com',
      );
    }),
  );

  it.effect(
    'defers sign-in when secondary validation cannot resolve a healthy session',
    () =>
      Effect.gen(function* () {
        const auth = fakeSupabaseAuth({
          storedSessionState: Effect.succeed('authenticated' as const),
        });
        authMocks.getSession.mockResolvedValue(undefined);

        expect(yield* withAuth(auth, signIn)).toBe(false);

        expect(authMocks.clearStoredSession).not.toHaveBeenCalled();
        expect(authMocks.showQuickPick).not.toHaveBeenCalled();
        expect(authMocks.showLoggedMessage).toHaveBeenCalledWith(
          'authCommands',
          expect.stringContaining('temporarily unavailable'),
        );
      }),
  );

  it.effect(
    'removes an unavailable stored session without resolving it first',
    () =>
      Effect.gen(function* () {
        const auth = fakeSupabaseAuth({
          storedSessionState: Effect.succeed('invalid' as const),
        });
        authMocks.showWarningMessage.mockResolvedValue({ title: 'Sign out' });

        yield* withAuth(auth, signOut);

        expect(authMocks.getSession).not.toHaveBeenCalled();
        expect(authMocks.removeStoredSession).toHaveBeenCalledOnce();
        expect(authMocks.showInformationMessage).toHaveBeenCalledWith(
          'Signed out',
        );
      }),
  );
});
