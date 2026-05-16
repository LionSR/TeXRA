import { create } from 'mutative';

import { PROGRESS_VIEW_COMMANDS } from '@common/webview/commands';

import type { HandlerRegistry } from '../messageDispatcher';

export const inquiryHandlers: HandlerRegistry = {
  [PROGRESS_VIEW_COMMANDS.SYNC_INQUIRY_THREADS]: (data, ctx) => {
    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.inquiries.clear();
        for (const thread of data.threads) {
          if (thread.parentStreamId == null) continue;
          draft.inquiries.set(thread.threadId, thread);
        }
      }),
    );
  },

  [PROGRESS_VIEW_COMMANDS.UPDATE_INQUIRY_THREAD]: (data, ctx) => {
    if (data.thread.parentStreamId == null) return;

    ctx.setState((prev) =>
      create(prev, (draft) => {
        draft.inquiries.set(data.thread.threadId, data.thread);
      }),
    );
  },
};
