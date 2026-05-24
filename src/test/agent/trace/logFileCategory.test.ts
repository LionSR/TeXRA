// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import {
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { logFileCategory, type AgentTrace } from '@agent/trace';
import { createRunTrace } from '@logger';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('logFileCategory', () => {
  let logger: AgentTrace;
  let disposeTrace: () => void;
  let capturedMessages: any[];

  beforeEach(async () => {
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);
    await store.clear();
    const runTrace = createRunTrace('TestFileListLogger');
    logger = runTrace.trace;
    disposeTrace = runTrace.dispose;
    capturedMessages = [];
  });

  afterEach(() => {
    // Release the run-trace subscribers so `activeFlushers` in runTrace.ts
    // doesn't accumulate dead closures across the suite.
    disposeTrace();
  });

  const refreshCaptured = (): void => {
    const log = getDefaultStreamLogStore().get('TestFileListLogger');
    capturedMessages = (log?.getRange(0, log.head) ?? []).map((entry) => ({
      id: entry.id,
      text: entry.text ?? '',
      level: entry.level,
      timestamp: entry.timestamp,
      messageType: entry.messageType,
      data: entry.data,
    }));
  };

  it('handles empty file array gracefully (no-op)', () => {
    logFileCategory(logger, 'Input Files', []);
    refreshCaptured();
    assert.equal(capturedMessages.length, 0);
  });

  it('logs files with correct category label', () => {
    logFileCategory(logger, 'Input Files', [
      { path: '/path/to/file.tex', ok: true },
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].messageType, MESSAGE_TYPES.FILE_LIST);
    assert.equal(capturedMessages[0].text, 'Loading Input Files (1/1)');
  });

  it('counts only files with ok === true as loaded', () => {
    logFileCategory(logger, 'Reference Files', [
      { path: '/path/exists.tex', ok: true },
      { path: '/path/missing.tex', ok: false },
      { path: '/path/also-exists.tex', ok: true },
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].text, 'Loading Reference Files (2/3)');
  });

  it('treats undefined ok as false (not loaded)', () => {
    logFileCategory(logger, 'Auxiliary Files', [
      { path: '/path/exists.tex', ok: true },
      { path: '/path/unknown.tex' }, // ok is undefined
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].text, 'Loading Auxiliary Files (1/2)');
  });

  it('handles all files missing (none exist)', () => {
    logFileCategory(logger, 'Media Files', [
      { path: '/path/missing1.png', ok: false },
      { path: '/path/missing2.png', ok: false },
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].text, 'Loading Media Files (0/2)');
  });

  it('includes source and sourceDisplay in entry data', () => {
    logFileCategory(logger, 'Input Files', [
      { path: '/path/file.tex', ok: true },
    ]);

    refreshCaptured();
    const entries = capturedMessages[0].data;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].source, 'Input Files');
    assert.equal(entries[0].sourceDisplay, 'Input Files');
    assert.equal(entries[0].path, '/path/file.tex');
    assert.equal(entries[0].ok, true);
  });

  it('maps ok properly in entries (undefined becomes false)', () => {
    logFileCategory(logger, 'Test', [
      { path: '/a', ok: true },
      { path: '/b', ok: false },
      { path: '/c' }, // undefined
    ]);

    refreshCaptured();
    const entries = capturedMessages[0].data;
    assert.equal(entries[0].ok, true);
    assert.equal(entries[1].ok, false);
    assert.equal(entries[2].ok, false);
  });
});
