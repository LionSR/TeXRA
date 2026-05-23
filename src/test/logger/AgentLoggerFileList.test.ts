// Standard library imports
import { strict as assert } from 'assert';

// Local imports
import type { TexraTrace } from '@logger';
import {
  createRunTrace,
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
} from '@logger';
import { StreamLogStore } from '@logger/StreamLogStore';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('AgentLogger.logFileCategory', () => {
  let logger: TexraTrace;
  let capturedMessages: any[];

  beforeEach(async () => {
    const store = new StreamLogStore();
    setDefaultStreamLogStore(store);
    await store.clear();
    logger = createRunTrace('TestFileListLogger').trace;
    capturedMessages = [];
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
    logger.logFileCategory('Input Files', []);
    refreshCaptured();
    assert.equal(capturedMessages.length, 0);
  });

  it('logs files with correct category label', () => {
    logger.logFileCategory('Input Files', [
      { path: '/path/to/file.tex', ok: true },
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].messageType, MESSAGE_TYPES.FILE_LIST);
    assert.equal(capturedMessages[0].text, 'Loading Input Files (1/1)');
  });

  it('counts only files with ok === true as loaded', () => {
    logger.logFileCategory('Reference Files', [
      { path: '/path/exists.tex', ok: true },
      { path: '/path/missing.tex', ok: false },
      { path: '/path/also-exists.tex', ok: true },
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].text, 'Loading Reference Files (2/3)');
  });

  it('treats undefined ok as false (not loaded)', () => {
    logger.logFileCategory('Auxiliary Files', [
      { path: '/path/exists.tex', ok: true },
      { path: '/path/unknown.tex' }, // ok is undefined
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].text, 'Loading Auxiliary Files (1/2)');
  });

  it('handles all files missing (none exist)', () => {
    logger.logFileCategory('Media Files', [
      { path: '/path/missing1.png', ok: false },
      { path: '/path/missing2.png', ok: false },
    ]);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].text, 'Loading Media Files (0/2)');
  });

  it('includes source and sourceDisplay in entry data', () => {
    logger.logFileCategory('Input Files', [
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
    logger.logFileCategory('Test', [
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
