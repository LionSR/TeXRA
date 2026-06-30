// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';

// Standard library imports

// Local imports
import {
  createRunTrace,
  getDefaultStreamLogStore,
  setDefaultStreamLogStore,
  StreamLogStore,
} from '@transcript';
import { logFileCategory, type AgentTrace } from '@agent/trace';
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

  // Only files with `ok === true` count as loaded; missing/false/undefined
  // `ok` are excluded from the numerator of the "Loading X (n/m)" label.
  it.each<{
    label: string;
    files: { path: string; ok?: boolean }[];
    expected: string;
  }>([
    {
      label: 'Input Files',
      files: [{ path: '/path/to/file.tex', ok: true }],
      expected: 'Loading Input Files (1/1)',
    },
    {
      label: 'Reference Files',
      files: [
        { path: '/path/exists.tex', ok: true },
        { path: '/path/missing.tex', ok: false },
        { path: '/path/also-exists.tex', ok: true },
      ],
      expected: 'Loading Reference Files (2/3)',
    },
    {
      label: 'Auxiliary Files',
      files: [
        { path: '/path/exists.tex', ok: true },
        { path: '/path/unknown.tex' }, // ok is undefined → not loaded
      ],
      expected: 'Loading Auxiliary Files (1/2)',
    },
    {
      label: 'Media Files',
      files: [
        { path: '/path/missing1.png', ok: false },
        { path: '/path/missing2.png', ok: false },
      ],
      expected: 'Loading Media Files (0/2)',
    },
  ])('logs "$expected"', ({ label, files, expected }) => {
    logFileCategory(logger, label, files);

    refreshCaptured();
    assert.equal(capturedMessages.length, 1);
    assert.equal(capturedMessages[0].messageType, MESSAGE_TYPES.FILE_LIST);
    assert.equal(capturedMessages[0].text, expected);
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
