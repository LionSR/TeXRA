/**
 * Drop bot-authored events at the emit boundary of both polling sources.
 *
 * Always-on policy: any event whose author has `type === 'Bot'` is dropped.
 * Some bots (notably classic GitHub Actions emitting issue comments) post
 * with `type === 'User'` but a `[bot]`-suffixed login; those are caught by
 * suffix as a defense-in-depth fallback.
 *
 * If a user-configurable allowlist is ever needed (to opt specific bots
 * back in), it should live in the TeXRA settings UI (Git tab, backed by
 * workspace state), not as a VS Code configuration contribution. This module
 * intentionally has no knobs — repo-level subscription policy is not a
 * user-tunable preference.
 */

import type { GhUser } from './prTypes';

/** Returns true if the event should be dropped (author is a bot). */
export function shouldDropBotEvent(user: GhUser | null | undefined): boolean {
  if (!user) return false;
  if (user.type === 'Bot') return true;
  // Catch CI-style logins that post as User but use the [bot] suffix. The
  // typeof guard holds because some callers hand us unvalidated payloads.
  return typeof user.login === 'string' && user.login.endsWith('[bot]');
}
