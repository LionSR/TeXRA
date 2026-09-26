import { SESSION_EVENT_FORMAT } from '@shared/schemas';
import type { SessionStoreMovedAside } from '@shared/session/database';

/**
 * What a host tells the user when opening a session store moved an older
 * build's rows aside (`SessionHandle.storeMovedAside`). The CLI prints it
 * once (the chat TUI in its transcript) and the extension shows it as a
 * warning; both say the same thing.
 */
export function sessionStoreMovedAsideMessage(
  moved: SessionStoreMovedAside,
): string {
  return `Session history in this workspace was written by an older TeXRA build (format ${moved.storedFormat}; this build reads format ${SESSION_EVENT_FORMAT}) and cannot be read by this one, so its ${moved.rows === 1 ? '1 row was' : `${moved.rows} rows were`} moved to ${moved.aside}. Nothing was deleted; history starts fresh here.`;
}
