// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - platform
import { WorktreeStateStore } from '@platform/defaults/worktreeStateStore';

class FakeStore {
  constructor(readonly values = new Map<string, unknown>()) {}

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }
}

describe('WorktreeStateStore', () => {
  const sharedKey = 'texra.enabledAgents';
  const localKey = 'texra.taskStates';
  const repoRoot = '/repo/main';
  const namespacedKey = `worktree:${repoRoot}:${sharedKey}`;

  function setup(
    initial: {
      workspace?: Map<string, unknown>;
      global?: Map<string, unknown>;
    } = {},
  ) {
    const workspaceState = new FakeStore(initial.workspace);
    const globalState = new FakeStore(initial.global);
    const store = new WorktreeStateStore(
      workspaceState,
      globalState,
      repoRoot,
      new Set([sharedKey]),
    );
    return { workspaceState, globalState, store };
  }

  it('reads and writes shared keys through repo-namespaced global state', async () => {
    const { workspaceState, globalState, store } = setup({
      global: new Map([[namespacedKey, ['review']]]),
    });

    expect(store.get(sharedKey, [])).toEqual(['review']);
    await store.update(sharedKey, ['latexFixer']);
    expect(globalState.get(namespacedKey)).toEqual(['latexFixer']);
    expect(workspaceState.get(sharedKey)).toBeUndefined();
  });

  it('ignores un-namespaced shared values', () => {
    const { store } = setup({
      workspace: new Map([[sharedKey, ['correct']]]),
    });

    expect(store.get(sharedKey, [])).toEqual([]);
  });

  it('updates only the namespaced shared value', async () => {
    const { workspaceState, globalState, store } = setup({
      workspace: new Map([[sharedKey, ['stale']]]),
      global: new Map([[namespacedKey, ['current']]]),
    });

    await store.update(sharedKey, undefined);

    expect(globalState.get(namespacedKey)).toBeUndefined();
    expect(workspaceState.get(sharedKey)).toEqual(['stale']);
    expect(store.get(sharedKey, [])).toEqual([]);
  });

  it('leaves non-shared keys in workspace state', async () => {
    const { workspaceState, globalState, store } = setup({
      workspace: new Map([[localKey, { one: true }]]),
    });

    expect(store.get(localKey)).toEqual({ one: true });
    await store.update(localKey, { two: true });
    expect(workspaceState.get(localKey)).toEqual({ two: true });
    expect([...globalState.values.keys()]).toEqual([]);
  });
});
