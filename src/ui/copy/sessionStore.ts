import type { SessionStoreMovedAside } from '@shared/session/database';

/**
 * What a host tells the user when opening a session store moved it aside
 * whole (`SessionHandle.storeMovedAside`). The CLI prints it once (the chat
 * TUI in its transcript) and the extension shows it as a warning; both say
 * the same thing.
 */
export function sessionStoreMovedAsideMessage(
  moved: SessionStoreMovedAside,
): string {
  return moved.reason === 'pre-1.0'
    ? `This store was written by a TeXRA build before 1.0, which this build does not read, so all of it was moved to ${moved.aside}: session history, saved settings, remembered projects, inquiry threads and input history start fresh here. Nothing was deleted.`
    : `The session store in this workspace was damaged and could not be opened, so it was moved to ${moved.aside}. History starts fresh here.`;
}
