import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import type { ProgressViewOutboundHandlerRegistry } from '@shared/schemas';

import { appState } from '../progressState';

// Registry contract: every outbound command needs a handler or
// `unsupported(...)`; exhaustiveness is enforced at the composed spread in
// messageDispatcher.ts. This slice only owns a subset.
export const inquiryHandlers = {
  [PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS]: (data) => {
    appState.set(
      create(appState.get(), (draft) => {
        draft.inquiries.clear();
        for (const thread of data.threads) {
          if (thread.parentStreamId == null) continue;
          draft.inquiries.set(thread.threadId, thread);
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD]: (data) => {
    if (data.thread.parentStreamId == null) return;

    appState.set(
      create(appState.get(), (draft) => {
        draft.inquiries.set(data.thread.threadId, data.thread);
      }),
    );
  },
} satisfies Partial<ProgressViewOutboundHandlerRegistry>;
