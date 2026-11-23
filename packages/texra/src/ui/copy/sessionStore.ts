import type { SessionStoreMovedAside } from '@texra-ai/worldline/schemas';

/**
 * What a host tells the user when opening a session store moved it aside
 * whole (`LocalSession.storeMovedAside`). The CLI prints it once (the chat
 * TUI in its transcript) and the extension shows it as a warning; both say
 * the same thing.
 */
/**
 * What a host says when the service that shares a project's tasks between
 * processes is out of reach, so they run in this one: `here` names the
 * surface the person is looking at, `reason` is why the service was not
 * reached.
 */
export function runsHereOnlyMessage(
  here: 'window' | 'terminal',
  reason: string,
): string {
  return `TeXRA runs this project's tasks in this ${here} only, so other windows and terminals will not see them: ${reason}`;
}

export function sessionStoreMovedAsideMessage(
  moved: SessionStoreMovedAside,
): string {
  return `Saved task history for this project was damaged and moved to ${moved.aside}. Starting fresh.`;
}
