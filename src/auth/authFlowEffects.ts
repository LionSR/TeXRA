/**
 * Small effects shared by the three hosts' OAuth sign-in/sign-out flows
 * (`packages/extension/src/frontend/auth/SupabaseAuthProvider.ts`,
 * `packages/desktop/src/main/desktopSupabaseAuth.ts`,
 * `packages/cli/src/runtime/supabaseAuth.ts`). Deliberately narrow: the
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

import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Validate a Supabase `signInWithOAuth` result, returning the redirect URL
 * or throwing the "OAuth initialization failed" message the desktop and CLI
 * hosts already surface verbatim on failure. The extension host keeps its
 * own variant (a user-facing notification with a "Try again." suffix), so
 * it isn't routed through this helper.
 */
export function requireOAuthRedirectUrl(
  data: { url?: string | null },
  error: { message: string } | null,
): string {
  if (error || !data.url) {
    throw new Error(
      `OAuth initialization failed: ${error?.message || 'missing auth URL'}`,
    );
  }
  return data.url;
}

/**
 * Best-effort remote-agent-catalog refresh after sign-out. Failures are
 * logged through the caller's `warn`, never thrown — a stale local catalog
 * must not block sign-out from completing. Takes the invalidation call as a
 * parameter (rather than importing `invalidateRemoteAgentsAfterSignOut`
 * directly from `@agent/index`) so `src/auth/` doesn't take on a dependency
 * on the `agent` subsystem — the reverse edge is the only one baselined.
 */
export async function refreshRemoteAgentCatalogAfterSignOut(
  invalidateCatalog: () => Promise<void>,
  warn: (message: string) => void,
): Promise<void> {
  await invalidateCatalog().catch((error: unknown) => {
    warn(
      `Local agent catalog refresh failed after sign-out: ${toErrorMessage(error)}`,
    );
  });
}
