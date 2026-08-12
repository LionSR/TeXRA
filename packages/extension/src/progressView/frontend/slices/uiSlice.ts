import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { placement } from '../progressState';

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns the two view-wide commands below.
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
