import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { placement } from '../progressState';

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns the view-wide command below.
export const uiHandlers = {
  [PROGRESS_VIEW_COMMANDS.SET_PLACEMENT]: (data) => {
    placement.set(data.placement);
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
