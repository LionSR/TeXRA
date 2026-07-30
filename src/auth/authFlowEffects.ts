/**
 * Small effects shared by the three hosts' OAuth sign-in/sign-out flows
 * (`packages/extension/src/frontend/auth/SupabaseAuthProvider.ts`,
 * `packages/desktop/src/main/desktopSupabaseAuth.ts`,
 * `packages/cli/src/runtime/supabaseAuth.ts`). Deliberately narrow: the
 * broader post-auth cache-invalidation sequence differs by host (desktop
 * routes it through its settings-IPC refresh chain, which does more than a
 * bare cache clear) and is not safe to collapse into one call.
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
