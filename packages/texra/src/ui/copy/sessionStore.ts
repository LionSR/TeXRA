import type { SessionStoreMovedAside } from '@shared/schemas';

/**
 * What a host tells the user when a session's open moved a store aside
 * whole (`SessionView.movedAside`). The CLI prints it once (the chat TUI in
 * its transcript), the extension shows it as a warning and the desktop app
 * as a dialog; all say the same thing.
 */
export function sessionStoreMovedAsideMessage(
  moved: SessionStoreMovedAside,
): string {
  return moved.reason === 'pre-1.0'
    ? `This store was written by a TeXRA build before 1.0, which this build does not read, so all of it was moved to ${moved.aside}: task history, saved settings, remembered projects, inquiry threads and input history start fresh here. Nothing was deleted.`
    : `The task store in this workspace was damaged and could not be opened, so it was moved to ${moved.aside}. History starts fresh here.`;
}
