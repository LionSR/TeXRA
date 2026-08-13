import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { logUserMessage, type AgentTrace } from '@agent/trace';
import { MESSAGE_TYPES, type StreamLogEntry } from '@shared/schemas';
import { createRunTrace, StreamLogStore } from '@transcript';

// #7508: the userMessage row's attachment-kind/count payload — logUserMessage
// stamps data.attachments when attachments are present and stays byte-for-byte
// the same (no `data` at all) for the common no-media case.
describe('logUserMessage', () => {
  let logger: AgentTrace;
  let disposeTrace: () => void;
  let store: StreamLogStore;

  beforeEach(async () => {
    store = StreamLogStore.ephemeral('test');
    await store.clear();
    const runTrace = createRunTrace('TestUserMessageLogger', store);
    logger = runTrace.trace;
    disposeTrace = runTrace.dispose;
  });

  afterEach(() => {
    disposeTrace();
  });

  function capturedEntries(): StreamLogEntry[] {
    const log = store.get('TestUserMessageLogger');
    return log?.getRange(0, log.head) ?? [];
  }

  it('logs a plain userMessage row with no data when there are no attachments', () => {
    logUserMessage(logger, 'Fix the lemma.');

    const entries = capturedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].messageType).toBe(MESSAGE_TYPES.USER_MESSAGE);
    expect(entries[0].text).toBe('Fix the lemma.');
    expect(entries[0].data).toBeUndefined();
  });

  it('omits data when the attachments array is empty', () => {
    logUserMessage(logger, 'Fix the lemma.', []);

    expect(capturedEntries()[0].data).toBeUndefined();
  });

  it('records attachment kinds (not bytes) on the row data', () => {
    logUserMessage(logger, 'See the attached figure.', ['image', 'document']);

    const entries = capturedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].messageType).toBe(MESSAGE_TYPES.USER_MESSAGE);
    expect(entries[0].data).toEqual({ attachments: ['image', 'document'] });
  });
});
