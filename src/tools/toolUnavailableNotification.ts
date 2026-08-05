/**
 * Optional external tools with missing deps used to open a progress-view toast.
 * That scared first-time users, so we stay silent — tools simply stay inactive
 * until set up via the Tools dashboard / Git settings.
 */

import type { SessionHandle } from '@agent/runtime/SessionHandle';

/** No-op. Call sites may still invoke this after resolving unavailable tools. */
export function notifyUnavailableTools(
  _excludedToolNames: string[],
  _session?: SessionHandle,
): void {}
