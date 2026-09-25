// Suites for @utils/core (comparators, type guards, async helpers).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFlushableDebounce,
  getBasename,
  getFileStem,
  linkAbortSignals,
  type FlushableDebounce,
} from '@utils/core';
import { deriveRunId } from '@utils/core/idHash';

describe('getBasename', () => {
  it.each([
    ['/home/user/file.txt', 'file.txt'],
    ['/usr/local/bin/node', 'node'],
    ['/path/to/document.pdf', 'document.pdf'],
    ['C:\\Users\\file.txt', 'file.txt'],
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
    expect(getBasename(input)).toBe(expected);
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
    expect(getFileStem(input)).toBe(expected);
  });

  it.each([[undefined], [null]])('getFileStem(%j) === ""', (input) => {
    expect(getFileStem(input)).toBe('');
  });
});

describe('deriveRunId', () => {
  it('is stable across identity field order', () => {
    expect(deriveRunId({ parent: 'abc', attempt: 2 })).toBe(
      deriveRunId({ attempt: 2, parent: 'abc' }),
    );
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

  it('cancel() drops the pending call without invoking the callback', () => {
    const callback = vi.fn();
    const batcher = createFlushableDebounce(callback, 100);

    batcher.schedule();
    batcher.cancel();
    expect(batcher.pending).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(callback).not.toHaveBeenCalled();
  });

  // The CLI transcript sync re-schedules from inside its own callback (its
  // trace flush writes to the store, which fires the change subscription
  // synchronously). An implementation that invokes and then cancels drops that
  // reschedule and leaves `pending` stuck true, freezing every later sync.
  it('keeps a reschedule made from inside the callback', () => {
    const inner = vi.fn();
    let rescheduleOnce = true;
    const batcher: FlushableDebounce = createFlushableDebounce(() => {
      inner();
      if (!rescheduleOnce) return;
      rescheduleOnce = false;
      batcher.schedule();
    }, 100);

    batcher.schedule();
    vi.advanceTimersByTime(100);
    expect(inner).toHaveBeenCalledOnce();
    expect(batcher.pending).toBe(true);

    vi.advanceTimersByTime(100);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(batcher.pending).toBe(false);
  });
});

describe('linkAbortSignals', () => {
  it('forwards a source abort with its reason and detaches cleanly', () => {
    const source = new AbortController();
    const controller = new AbortController();
    const detach = linkAbortSignals([undefined, source.signal], controller);

    // Detaching removes the only external reference to `controller`: a later
    // source abort must not reach it. `AbortSignal.any` offered no such
    // release, which is what kept every finished child scope reachable from a
    // long-lived parent signal.
    detach();
    source.abort(new Error('late'));
    expect(controller.signal.aborted).toBe(false);

    const linked = new AbortController();
    const reason = new Error('stop');
    const live = new AbortController();
    linkAbortSignals([live.signal], linked);
    live.abort(reason);
    expect(linked.signal.reason).toBe(reason);

    const preAborted = new AbortController();
    preAborted.abort(reason);
    const immediate = new AbortController();
    linkAbortSignals([preAborted.signal], immediate);
    expect(immediate.signal.reason).toBe(reason);
  });
});
