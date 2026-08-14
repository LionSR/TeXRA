// Suites for @utils/core (comparators, type guards, async helpers).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateError,
  coalesceAsync,
  createFlushableDebounce,
  delay,
  ensureArray,
  filterNotNull,
  filterNotNullish,
  getBasename,
  getFileStem,
  KeyedMutex,
  throwAggregated,
  toNewestFirstByTimestamp,
  utcMonthStart,
  type FlushableDebounce,
} from '@utils/core';
import { deriveExecutionId, truncatedHexId } from '@utils/core/idHash';

describe('utcMonthStart', () => {
  it('builds midnight UTC on the 1st of the given month', () => {
    expect(utcMonthStart(2026, 4).toISOString()).toBe(
      '2026-05-01T00:00:00.000Z',
    );
  });

  it('rolls a 12-index month into the next year, for exclusive-end ranges', () => {
    expect(utcMonthStart(2026, 12).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });
});

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

describe('aggregateError', () => {
  it('unwraps the lone failure when exactly one is collected', () => {
    const only = new Error('boom');
    expect(aggregateError([only], 'ignored')).toBe(only);
  });

  it('wraps several failures in an AggregateError carrying the message', () => {
    const a = new Error('a');
    const b = new Error('b');
    const aggregate = aggregateError([a, b], 'both failed');
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate).toMatchObject({ message: 'both failed', errors: [a, b] });
  });

  it('preserves a lone falsy failure rather than aggregating it', () => {
    // A single collected `undefined` must round-trip unwrapped, matching a
    // bare `throw failures[0]`.
    expect(aggregateError([undefined], 'ignored')).toBeUndefined();
  });
});

describe('throwAggregated', () => {
  it('is a no-op when no failures were collected', () => {
    expect(() => throwAggregated([], 'nothing failed')).not.toThrow();
  });

  it('throws the lone failure unwrapped', () => {
    const only = new Error('boom');
    expect(() => throwAggregated([only], 'ignored')).toThrow(only);
  });

  it('throws an AggregateError when several failed', () => {
    const a = new Error('a');
    const b = new Error('b');
    const throwing = () => throwAggregated([a, b], 'both failed');
    expect(throwing).toThrow(AggregateError);
    expect(throwing).toThrowError(expect.objectContaining({ errors: [a, b] }));
  });
});

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

interface Deferred {
  readonly promise: Promise<void>;
  readonly release: () => void;
}

function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

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

describe('KeyedMutex', () => {
  it('serializes operations that use the same key', async () => {
    const mutex = new KeyedMutex<string>();
    const order: string[] = [];
    const firstBlocked = deferred();

    const first = mutex.runExclusive('shared', async () => {
      order.push('first:start');
      await firstBlocked.promise;
      order.push('first:end');
    });
    const second = mutex.runExclusive('shared', async () => {
      order.push('second');
    });

    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    firstBlocked.release();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('allows independent keys to run concurrently', async () => {
    const mutex = new KeyedMutex<string>();
    const started: string[] = [];
    const blocked = deferred();

    const first = mutex.runExclusive('first', async () => {
      started.push('first');
      await blocked.promise;
    });
    const second = mutex.runExclusive('second', async () => {
      started.push('second');
    });

    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    blocked.release();
    await Promise.all([first, second]);
  });

  it('releases a key when an operation rejects', async () => {
    const mutex = new KeyedMutex<string>();

    await expect(
      mutex.runExclusive('shared', async () => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');
    await expect(
      mutex.runExclusive('shared', async () => 'recovered'),
    ).resolves.toBe('recovered');
  });
});

describe('coalesceAsync', () => {
  it('shares one in-flight computation across concurrent callers', async () => {
    const resolved = new Map<string, string>();
    const pending = new Map<string, Promise<string>>();
    let computeCount = 0;
    const blocked = deferred();
    const compute = async () => {
      computeCount++;
      await blocked.promise;
      return 'value';
    };

    const first = coalesceAsync(resolved, pending, 'key', compute);
    const second = coalesceAsync(resolved, pending, 'key', compute);
    blocked.release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'value',
      'value',
    ]);
    expect(computeCount).toBe(1);
  });

  it('serves subsequent calls from the resolved cache without recomputing', async () => {
    const resolved = new Map<string, string>();
    const pending = new Map<string, Promise<string>>();
    let computeCount = 0;
    const compute = async () => {
      computeCount++;
      return 'value';
    };

    await coalesceAsync(resolved, pending, 'key', compute);
    await coalesceAsync(resolved, pending, 'key', compute);

    expect(computeCount).toBe(1);
  });

  it('does not cache a result if the pending entry was invalidated mid-flight', async () => {
    const resolved = new Map<string, string>();
    const pending = new Map<string, Promise<string>>();
    const blocked = deferred();
    const compute = async () => {
      await blocked.promise;
      return 'stale-value';
    };

    const request = coalesceAsync(resolved, pending, 'key', compute);
    pending.clear(); // simulate an external invalidation racing the in-flight compute
    blocked.release();
    await request;

    expect(resolved.get('key')).toBeUndefined();
  });

  it('propagates a rejection and clears the pending entry without caching', async () => {
    const resolved = new Map<string, string>();
    const pending = new Map<string, Promise<string>>();
    const failure = new Error('compute failed');
    const compute = async () => {
      throw failure;
    };

    await expect(coalesceAsync(resolved, pending, 'key', compute)).rejects.toBe(
      failure,
    );

    expect(pending.has('key')).toBe(false);
    expect(resolved.has('key')).toBe(false);

    // A subsequent call must recompute rather than replay the failed promise.
    let recomputeCount = 0;
    await coalesceAsync(resolved, pending, 'key', async () => {
      recomputeCount++;
      return 'recovered';
    });
    expect(recomputeCount).toBe(1);
  });
});

describe('truncatedHexId', () => {
  it('defaults to a sha256 prefix of the requested length', () => {
    expect(truncatedHexId('source', 8)).toBe('41cf6794');
    expect(truncatedHexId('source', 16)).toBe('41cf6794ba4200b8');
  });

  it('keeps the compile-log sha1 spelling', () => {
    expect(truncatedHexId('path.tex', 8, 'sha1')).toBe('eefc4296');
  });
});

describe('deriveExecutionId', () => {
  it('is stable across identity field order', () => {
    expect(deriveExecutionId({ parent: 'abc', attempt: 2 })).toBe(
      deriveExecutionId({ attempt: 2, parent: 'abc' }),
    );
  });

  it('returns distinct 24-hex ids for distinct identities', () => {
    const first = deriveExecutionId({ parent: 'abc', attempt: 1 });
    const second = deriveExecutionId({ parent: 'abc', attempt: 2 });

    expect(first).toMatch(/^[a-f0-9]{24}$/);
    expect(second).toMatch(/^[a-f0-9]{24}$/);
    expect(first).not.toBe(second);
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
