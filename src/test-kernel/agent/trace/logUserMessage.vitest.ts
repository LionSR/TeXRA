// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';

// Local imports
import { logUserMessage, type AgentTrace } from '@agent/trace';
import { MESSAGE_TYPES } from '@shared/schemas';
import { createRunTrace, StreamLogStore } from '@transcript';

// #7508: the `userMessage` row's attachment-kind/count payload — verifies
// `logUserMessage` stamps `data.attachments` when attachments are present,
// and stays byte-for-byte the same (no `data` at all) for the common no-media
// case so every other consumer of this row is unaffected.
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

  const capturedEntries = () => {
    const log = store.get('TestUserMessageLogger');
    return log?.getRange(0, log.head) ?? [];
  };

  it('logs a plain userMessage row with no data when there are no attachments', () => {
    logUserMessage(logger, 'Fix the lemma.');

    const entries = capturedEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].messageType, MESSAGE_TYPES.USER_MESSAGE);
    assert.equal(entries[0].text, 'Fix the lemma.');
    assert.equal(entries[0].data, undefined);
  });

  it('omits data when the attachments array is empty', () => {
    logUserMessage(logger, 'Fix the lemma.', []);

    const entries = capturedEntries();
    assert.equal(entries[0].data, undefined);
  });

  it('records attachment kinds (not bytes) on the row data', () => {
    logUserMessage(logger, 'See the attached figure.', ['image', 'document']);

    const entries = capturedEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].messageType, MESSAGE_TYPES.USER_MESSAGE);
    assert.deepEqual(entries[0].data, {
      attachments: ['image', 'document'],
    });
  });
});
