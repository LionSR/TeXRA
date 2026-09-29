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
    ? `Session history in this workspace was written by a TeXRA build before 1.0, which this build does not read, so the whole store was moved to ${moved.aside}. Nothing was deleted; history starts fresh here.`
    : `The session store in this workspace was damaged and could not be opened, so it was moved to ${moved.aside}. History starts fresh here.`;
}
