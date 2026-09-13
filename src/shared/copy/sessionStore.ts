import { SESSION_EVENT_FORMAT } from '@shared/schemas';
import type { SessionStoreCleared } from '@shared/session/database';

/**
 * What a host tells the user when opening a session store cleared another
 * build's rows (`SessionHandle.storeCleared`). The CLI prints it once at
 * startup and the extension shows it as a warning; both say the same thing.
 */
export function sessionStoreClearedMessage(
  cleared: SessionStoreCleared,
): string {
  return `Session history in this workspace was written by a different TeXRA build (format ${cleared.storedFormat}; this build reads format ${SESSION_EVENT_FORMAT}) and cannot be read, so it was cleared: ${cleared.path}. History starts fresh.`;
}
