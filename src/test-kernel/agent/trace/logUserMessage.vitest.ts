import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { logUserMessage, type AgentTrace } from '@agent/trace';
import type { RunId } from '@shared/schemas';
import { createTestRunTrace } from '@test/support/sessionTestUtils';

// #7508: the userMessage row's attachment-kind/count payload — logUserMessage
// stamps data.attachments when attachments are present and stays byte-for-byte
// the same (no `data` at all) for the common no-media case.
describe('logUserMessage', () => {
  let logger: AgentTrace;
  let disposeTrace: () => void;
  let runTrace: ReturnType<typeof createTestRunTrace>;

  beforeEach(() => {
    runTrace = createTestRunTrace('TestUserMessageLogger' as RunId);
    logger = runTrace.trace;
    disposeTrace = runTrace.dispose;
  });

  afterEach(() => {
    disposeTrace();
  });

  // #13662, #13874: "Fork from here" refills the fork's composer from the
  // row, so the row keeps what the follow-up attached, by blob address: a
  // pasted file swept from storage leaves the fork its media.
  it('records the attached media a fork puts back in its composer', () => {
    const pasted = {
      name: 'pasted-image-1.png',
      mimeType: 'image/png',
      digest: 'a'.repeat(64),
    };
    logUserMessage(logger, 'See [pasted-image-1.png]', {
      attachments: ['image'],
      media: [pasted],
    });

    expect(runTrace.rows()[0]).toMatchObject({
      kind: 'user',
      attachments: ['image'],
      media: [pasted],
    });
  });
});
