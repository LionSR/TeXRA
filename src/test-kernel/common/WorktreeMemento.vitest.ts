// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - common state
import { WorktreeMemento } from '@common/state/worktreeMemento';

class FakeMemento {
  constructor(private readonly values = new Map<string, unknown>()) {}

  keys(): readonly string[] {
    return [...this.values.keys()];
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
    return Promise.resolve();
  }
}

describe('WorktreeMemento', () => {
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
    const workspaceState = new FakeMemento(initial.workspace);
    const globalState = new FakeMemento(initial.global);
    const memento = new WorktreeMemento(
      workspaceState,
      globalState,
      repoRoot,
      new Set([sharedKey]),
    );
    return { workspaceState, globalState, memento };
  }

  it('reads and writes shared keys through repo-namespaced global state', async () => {
    const { workspaceState, globalState, memento } = setup({
      global: new Map([[namespacedKey, ['review']]]),
    });

    expect(memento.get(sharedKey, [])).toEqual(['review']);
    await memento.update(sharedKey, ['latexFixer']);
    expect(globalState.get(namespacedKey)).toEqual(['latexFixer']);
    expect(workspaceState.get(sharedKey)).toBeUndefined();
  });

  it('ignores un-namespaced shared values', () => {
    const { memento } = setup({
      workspace: new Map([[sharedKey, ['correct']]]),
    });

    expect(memento.get(sharedKey, [])).toEqual([]);
    expect(memento.keys()).not.toContain(sharedKey);
  });

  it('updates only the namespaced shared value', async () => {
    const { workspaceState, globalState, memento } = setup({
      workspace: new Map([[sharedKey, ['stale']]]),
      global: new Map([[namespacedKey, ['current']]]),
    });

    await memento.update(sharedKey, undefined);

    expect(globalState.get(namespacedKey)).toBeUndefined();
    expect(workspaceState.get(sharedKey)).toEqual(['stale']);
    expect(memento.get(sharedKey, [])).toEqual([]);
  });

  it('leaves non-shared keys in workspace state', async () => {
    const { workspaceState, globalState, memento } = setup({
      workspace: new Map([[localKey, { one: true }]]),
    });

    expect(memento.get(localKey)).toEqual({ one: true });
    await memento.update(localKey, { two: true });
    expect(workspaceState.get(localKey)).toEqual({ two: true });
    expect(globalState.keys()).toEqual([]);
  });

  it('reports only keys with stored values', () => {
    const { memento } = setup({ workspace: new Map([[localKey, true]]) });

    expect(memento.keys()).toEqual([localKey]);
  });
});
