/**
 * The one pending sign-in record store, and the one callback nonce check.
 *
 * A host used to carry its own: the extension kept a secret per nonce, the
 * desktop a single state-store key, and the CLI a nonce minted into the page
 * it served. The record shape was already shared
 * (`@auth/pendingOAuthState`); the reader, the writer, the freshness sweep
 * and the login-CSRF check were not. They are here, over a
 * {@link PendingOAuthSlots} port that a host backs with whatever durable
 * storage it has.
 */
import { Effect, Result } from 'effect';

import {
  isPendingOAuthStateFresh,
  OAUTH_NONCE_PATTERN,
  PendingOAuthStateSchema,
  PKCE_FLOW_ID_PATTERN,
  type PendingOAuthState,
} from '@auth/pendingOAuthState';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import { createLog } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('pendingOAuthStore');

/**
 * Key prefix a durable {@link PendingOAuthSlots} implementation puts its
 * records under, so a store it shares with other data can tell them apart and
 * enumerate only its own.
 */
export const PENDING_OAUTH_STATE_PREFIX = 'texra.auth.pendingOAuthState.';

/** The query parameter every host's callback URL carries its nonce in. */
const CALLBACK_NONCE_PARAM = 'app_nonce';

/**
 * Where one host durably keeps its pending sign-in records, keyed by nonce.
 * A record per nonce rather than one blob: on the VS Code host two windows
 * write one secret store, and a read-modify-write of a shared blob would lose
 * the other window's attempt.
 */
export interface PendingOAuthSlots {
  read(nonce: string): Effect.Effect<string | undefined, Error>;
  write(nonce: string, value: string): Effect.Effect<void, Error>;
  erase(nonce: string): Effect.Effect<void, Error>;
  /** Nonces this host currently holds a record for, for the stale sweep. */
  nonces(): Effect.Effect<readonly string[], Error>;
}

/** The pending-record store: one implementation, three backing slots. */
export class PendingOAuthStore {
  constructor(private readonly slots: PendingOAuthSlots) {}

  /** The record for `nonce`, or null when there is none worth trusting. */
  read(nonce: string): Effect.Effect<PendingOAuthState | null, Error> {
    return Effect.map(this.slots.read(nonce), (stored) => {
      if (stored === undefined) return null;
      const parsed = parseJsonWith(stored, PendingOAuthStateSchema);
      if (Result.isFailure(parsed)) {
        // The fixed diagnostic deliberately excludes stored secret content.
        log.warn(
          'Stored OAuth callback state is malformed and will be ignored',
        );
        return null;
      }
      return parsed.success;
    });
  }

  /**
   * The one PKCE bind in the tree: pin the flow the GoTrue client just minted
   * to this attempt's nonce, so the callback carrying that nonce — in this
   * window, this process, or the next one — exchanges against that flow's
   * verifier slot rather than auth-js's fixed fallback.
   */
  bind(
    attempt: Pick<PendingOAuthState, 'nonce' | 'createdAt'>,
    flowId: string | null | undefined,
  ): Effect.Effect<void, Error> {
    if (!flowId || !PKCE_FLOW_ID_PATTERN.test(flowId)) {
      return Effect.fail(
        new Error('OAuth initialization did not return a valid PKCE flow.'),
      );
    }
    if (!isPendingOAuthStateFresh(attempt)) {
      return Effect.fail(
        new Error('Authentication attempt is no longer pending. Try again.'),
      );
    }
    return this.slots.write(
      attempt.nonce,
      JSON.stringify({
        nonce: attempt.nonce,
        createdAt: attempt.createdAt,
        flowId,
      } satisfies PendingOAuthState),
    );
  }

  clear(nonce: string): Effect.Effect<void, Error> {
    return this.slots.erase(nonce);
  }

  /**
   * Drop records no callback can complete any more. Best effort and loud: a
   * store that cannot be inspected or cleaned says so and the sign-in
   * continues, because a leftover record only expires again next sweep.
   */
  sweep(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const nonces = yield* Effect.catch(this.slots.nonces(), (error) =>
        Effect.sync(() => {
          log.warn(
            `Unable to inspect stored OAuth callback state for cleanup: ${toErrorMessage(error)}`,
          );
          return [] as readonly string[];
        }),
      );
      for (const nonce of nonces) {
        yield* Effect.catch(
          Effect.gen({ self: this }, function* () {
            const state = yield* this.read(nonce);
            if (!state || !isPendingOAuthStateFresh(state)) {
              yield* this.clear(nonce);
            }
          }),
          (error) =>
            Effect.sync(() => {
              log.warn(
                `Unable to clean up stored OAuth callback state: ${toErrorMessage(error)}`,
              );
            }),
        );
      }
    });
  }
}

/**
 * The one nonce check. A callback carries exactly one `app_nonce`, shaped
 * like the nonce this process mints; anything else is not ours.
 */
export function callbackNonce(query: string): string | null {
  const values = new URLSearchParams(query).getAll(CALLBACK_NONCE_PARAM);
  if (values.length !== 1 || !OAUTH_NONCE_PATTERN.test(values[0])) return null;
  return values[0];
}

/** Append one attempt's nonce to a host's callback URL. */
export function withCallbackNonce(callbackUrl: string, nonce: string): string {
  const separator = callbackUrl.includes('?') ? '&' : '?';
  return `${callbackUrl}${separator}${CALLBACK_NONCE_PARAM}=${nonce}`;
}

/** Pending records held for the life of one process (the CLI's sign-in). */
export function memoryPendingOAuthSlots(): PendingOAuthSlots {
  const records = new Map<string, string>();
  return {
    read: (nonce) => Effect.sync(() => records.get(nonce)),
    write: (nonce, value) =>
      Effect.sync(() => {
        records.set(nonce, value);
      }),
    erase: (nonce) =>
      Effect.sync(() => {
        records.delete(nonce);
      }),
    nonces: () => Effect.sync(() => [...records.keys()]),
  };
}
