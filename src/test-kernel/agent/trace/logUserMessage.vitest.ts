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

  it('logs a plain userMessage row with no data when there are no attachments', () => {
    logUserMessage(logger, 'Fix the lemma.');

    const rows = runTrace.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'user' });
    expect(rows[0].kind === 'user' && rows[0].text.full).toBe('Fix the lemma.');
    expect(rows[0]).not.toHaveProperty('attachments');
  });

  it('records attachment kinds (not bytes) on the row data', () => {
    logUserMessage(logger, 'See the attached figure.', ['image', 'document']);

    const rows = runTrace.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'user',
      attachments: ['image', 'document'],
    });
  });
});
