import type { SessionStoreMovedAside } from '@texra-ai/worldline/schemas';

/**
 * What a host tells the user when opening a session store moved it aside
 * whole (`LocalSession.storeMovedAside`). The CLI prints it once (the chat
 * TUI in its transcript) and the extension shows it as a warning; both say
 * the same thing.
 */
export function sessionStoreMovedAsideMessage(
  moved: SessionStoreMovedAside,
): string {
  return `Saved task history for this project was damaged and moved to ${moved.aside}. Starting fresh.`;
}
