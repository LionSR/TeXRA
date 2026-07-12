// Suites for @utils/core (comparators, type guards, async helpers).

// Standard library imports
import * as assert from 'node:assert';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFlushableDebounce,
  delay,
  ensureArray,
  filterNotNull,
  filterNotNullish,
  getBasename,
  getFileStem,
  toNewestFirstByTimestamp,
} from '@utils/core';

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

describe('toNewestFirstByTimestamp', () => {
  it('orders values by newest timestamp first', () => {
    const rows = [
      { id: 'middle', timestamp: '2026-06-20T12:00:00.000Z' },
      { id: 'newest', timestamp: '2026-06-21T12:00:00.000Z' },
      { id: 'oldest', timestamp: '2026-06-19T12:00:00.000Z' },
    ];

    expect(
      toNewestFirstByTimestamp(rows, (row) => row.timestamp).map(
        (row) => row.id,
      ),
    ).toEqual(['newest', 'middle', 'oldest']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      { id: 'first', timestamp: '2026-06-20T12:00:00.000Z' },
      { id: 'second', timestamp: '2026-06-21T12:00:00.000Z' },
    ];

    const sorted = toNewestFirstByTimestamp(rows, (row) => row.timestamp);

    expect(sorted.map((row) => row.id)).toEqual(['second', 'first']);
    expect(rows.map((row) => row.id)).toEqual(['first', 'second']);
  });
});

// ---------------------------------------------------------------------------
// TypeGuards
// ---------------------------------------------------------------------------

describe('core type guard predicates', () => {
  it('filters null values as an Array.filter predicate', () => {
    const values: Array<string | null> = ['alpha', null, 'beta'];

    expect(values.filter(filterNotNull)).toEqual(['alpha', 'beta']);
  });

  it('filters nullish values as an Array.filter predicate', () => {
    const values: Array<string | null | undefined> = [
      'alpha',
      null,
      undefined,
      'beta',
    ];

    expect(values.filter(filterNotNullish)).toEqual(['alpha', 'beta']);
  });

  it('returns array values unchanged', () => {
    const values = ['alpha', 'beta'];

    expect(ensureArray(values)).toBe(values);
  });

  it('wraps scalar values in an array', () => {
    expect(ensureArray('alpha')).toEqual(['alpha']);
  });
});

// ---------------------------------------------------------------------------
// pathBasics
// ---------------------------------------------------------------------------

describe('getBasename', () => {
  it.each([
    ['/home/user/file.txt', 'file.txt'],
    ['/usr/local/bin/node', 'node'],
    ['/path/to/document.pdf', 'document.pdf'],
    ['C:\\Users\\file.txt', 'file.txt'],
    ['C:\\Program Files\\app.exe', 'app.exe'],
    ['D:\\Documents\\report.docx', 'report.docx'],
    ['C:/Users\\Documents/file.txt', 'file.txt'],
    ['/home\\user/document.pdf', 'document.pdf'],
    ['/path/to/', 'to'],
    ['/path/to/dir/', 'dir'],
    ['C:\\Users\\', 'Users'],
    ['', ''],
    ['/', ''],
    ['//', ''],
    ['file.txt', 'file.txt'],
    ['./file.txt', 'file.txt'],
    ['../file.txt', 'file.txt'],
    ['/path/to/file.tar.gz', 'file.tar.gz'],
    ['archive.backup.zip', 'archive.backup.zip'],
    ['/home/user/.bashrc', '.bashrc'],
    ['/path/to/file with spaces.txt', 'file with spaces.txt'],
    ['/path/to/file-with-dashes.txt', 'file-with-dashes.txt'],
    ['/path/to/file_with_underscores.txt', 'file_with_underscores.txt'],
    ['relative/path/to/file.txt', 'file.txt'],
    ['./relative/file.txt', 'file.txt'],
    ['../parent/file.txt', 'file.txt'],
    ['/home/user/Documents', 'Documents'],
    ['C:\\Program Files', 'Program Files'],
    ['/usr/local/bin', 'bin'],
    // Regression: paths ending with a separator used to return empty.
    ['folder/', 'folder'],
    ['/home/user/folder/', 'folder'],
  ])('getBasename(%j) === %j', (input, expected) => {
    assert.strictEqual(getBasename(input), expected);
  });
});

describe('getFileStem', () => {
  it.each([
    ['dir/paper.tex', 'paper'],
    ['/home/user/document.pdf', 'document'],
    ['file.txt', 'file'],
    // Dotfiles keep their full name — a leading dot isn't an extension.
    ['/home/user/.bashrc', '.bashrc'],
    ['.gitignore', '.gitignore'],
    // Only the final extension is stripped.
    ['/path/to/file.tar.gz', 'file.tar'],
    ['archive.backup.zip', 'archive.backup'],
    ['C:\\Users\\report.docx', 'report'],
    ['/path/to/', 'to'],
    ['/path/to/dir/', 'dir'],
    ['', ''],
    ['/', ''],
  ])('getFileStem(%j) === %j', (input, expected) => {
    assert.strictEqual(getFileStem(input), expected);
  });

  it.each([[undefined], [null]])('getFileStem(%j) === ""', (input) => {
    assert.strictEqual(getFileStem(input), '');
  });
});

// ---------------------------------------------------------------------------
// Async
// ---------------------------------------------------------------------------

describe('async utilities', () => {
  it('resolves after the requested delay', async () => {
    await expect(delay(0)).resolves.toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);

    await expect(delay(100, { signal: controller.signal })).rejects.toBe(
      reason,
    );
  });

  it('rejects an in-flight delay when the signal aborts', async () => {
    const controller = new AbortController();
    const promise = delay(100, { signal: controller.signal });

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createFlushableDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes the callback once after the wait elapses', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(batcher.pending).toBe(false);
  });

  it('restarts the timer on every schedule() call, like a classic trailing debounce', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    vi.advanceTimersByTime(60);
    batcher.schedule(); // resets the 100ms window
    vi.advanceTimersByTime(60);
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('flush() runs the callback synchronously and clears the pending timer', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    batcher.flush();

    expect(callback).toHaveBeenCalledOnce();
    expect(batcher.pending).toBe(false);

    // The timer was cleared by flush(), so letting it "expire" must not
    // invoke the callback a second time.
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('flush() is a no-op when nothing is pending', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.flush();

    expect(callback).not.toHaveBeenCalled();
  });

  it('cancel() drops the pending call without invoking the callback', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    batcher.cancel();
    expect(batcher.pending).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  it('cancel() is a no-op when nothing is pending', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    expect(() => batcher.cancel()).not.toThrow();
    expect(batcher.pending).toBe(false);
  });

  it('pending reflects schedule/fire/flush/cancel transitions', () => {
    const batcher = createFlushableDebounce(vi.fn(), 50);

    expect(batcher.pending).toBe(false);
    batcher.schedule();
    expect(batcher.pending).toBe(true);
    vi.advanceTimersByTime(50);
    expect(batcher.pending).toBe(false);

    batcher.schedule();
    batcher.cancel();
    expect(batcher.pending).toBe(false);
  });

  it('schedule() after flush() starts a fresh window (flush fully resets state)', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    batcher.flush();
    expect(callback).toHaveBeenCalledOnce();

    batcher.schedule();
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
