import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { placement } from '../progressState';

// The composed registry is exhaustive (every ProgressView outbound command
// needs a real handler or `unsupported(...)` — see `@shared/utils/dispatcher`).
// This slice only owns the two view-wide commands below, so it's typed as a
// `satisfies Partial<...>` subset rather than the full registry;
// `messageDispatcher.ts` spreads all slices together and is the actual
// exhaustiveness checkpoint TypeScript enforces.
export const uiHandlers = {
  [PROGRESS_VIEW_COMMANDS.SET_PLACEMENT]: (data) => {
    placement.set(data.placement);
  },
  // THEME_SET shares its command string with COMMON_COMMANDS.THEME_SET
  // ('setTheme'): BaseWebviewApp's `messageListener` routes it through
  // `handleCommonMessage` (which calls `onThemeChange`) *before* falling
  // through to `handleMessage`/`dispatchMessage`, so this entry only exists
  // to keep the outbound command union exhaustive here — it never actually
  // runs in production. See `BaseWebviewApp.ts`'s `messageListener`.
  [PROGRESS_VIEW_COMMANDS.THEME_SET]: () => {},
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
