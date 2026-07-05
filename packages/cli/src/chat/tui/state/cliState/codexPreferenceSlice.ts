// Bumped whenever the in-process ChatGPT-subscription preference changes (via
// `/subscription`) so the status bar re-reads it immediately instead of waiting
// for its periodic poll. External changes (extension/desktop/config edits) are
// still picked up by that poll.

import { signal } from '@lit-labs/signals';

const CODEX_PREFERENCE_VERSION = signal<number>(0);

export const codexPreferenceVersion = CODEX_PREFERENCE_VERSION;

/** Signal the status bar to re-read the ChatGPT-subscription preference now. */
export function bumpCodexPreferenceVersion(): void {
  CODEX_PREFERENCE_VERSION.set(CODEX_PREFERENCE_VERSION.get() + 1);
}
