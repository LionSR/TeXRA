import { describe, expect, it } from 'vitest';

import { DisposableStore } from '@platform/disposable';

describe('DisposableStore', () => {
  it('disposes once in LIFO order without letting one failure stop the rest', () => {
    const store = new DisposableStore();
    const calls: string[] = [];

    store.add(() => calls.push('first'));
    store.add(() => {
      calls.push('second');
      throw new Error('dispose failed');
    });
    store.add(() => calls.push('third'));

    expect(() => store.dispose()).toThrow('dispose failed');
    expect(calls).toEqual(['third', 'second', 'first']);

    expect(() => store.dispose()).not.toThrow();
    expect(calls).toEqual(['third', 'second', 'first']);
  });

  it('immediately disposes resources added after teardown', () => {
    const store = new DisposableStore();
    store.dispose();

    let disposed = false;
    store.add(() => {
      disposed = true;
    });

    expect(disposed).toBe(true);
  });
});
