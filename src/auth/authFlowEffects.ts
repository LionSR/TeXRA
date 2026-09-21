/**
 * The post-sign-out catalog refresh the three hosts share. Deliberately
 * narrow: the
 * broader post-auth cache-invalidation sequence is a permanent host boundary,
 * not a missing shared coordinator. The extension invalidates its long-lived
 * model cache before publishing a session event. Desktop routes the same
 * transition through its settings-IPC refresh chain because that chain also
 * republishes model and profile state. Agent-catalog publication normally
 * follows there, except that team sign-in deliberately defers it to the team
 * resolver; onboarding is refreshed separately by the desktop session-change
 * handler. Ordinary CLI login and logout commands exit without consuming
 * model options. Persistent CLI callers own their subsequent transition before
 * reading credential-dependent state: onboarding invalidates its model-options
 * cache, the orchestration launcher invalidates its model list, and the chat
 * TUI refreshes its subscription-preference views. Within that persistent CLI
 * session, setup-agent team sign-in immediately refreshes and rereads the
 * remote agent catalog before applying the selected team. Collapsing these
 * effects would either omit host refresh work or repeat it.
 */

import { Cause, Effect } from 'effect';

import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Best-effort remote-agent-catalog refresh after sign-out. Failures are
 * logged through the caller's `warn` — an Effect, so the caller's own channel
 * reaches the entry — never thrown: a stale local catalog must not block
 * sign-out from completing. Takes the invalidation program as
 * a parameter (rather than importing `invalidateRemoteAgentsAfterSignOut`
 * directly from `@agent/index`) so `src/auth/` doesn't take on a dependency
 * on the `agent` subsystem — the reverse edge is the only one baselined.
 */
export function refreshRemoteAgentCatalogAfterSignOut<R = never>(
  invalidateCatalog: Effect.Effect<void, never, R>,
  warn: (message: string) => Effect.Effect<void>,
): Effect.Effect<void, never, R> {
  return invalidateCatalog.pipe(
    Effect.catchCause((cause) =>
      warn(
        `Local agent catalog refresh failed after sign-out: ${toErrorMessage(Cause.squash(cause))}`,
      ),
    ),
  );
}
