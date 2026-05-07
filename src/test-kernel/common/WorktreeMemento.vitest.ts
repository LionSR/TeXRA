// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - common state
import { WorktreeMemento } from '@common/state/worktreeMemento';

class FakeMemento {
  readonly writes: Array<[string, unknown]> = [];

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
    this.writes.push([key, value]);
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

  it('reads and writes shared keys through repo-namespaced global state', async () => {
    const workspaceState = new FakeMemento();
    const globalState = new FakeMemento(new Map([[namespacedKey, ['review']]]));
    const memento = new WorktreeMemento(
      workspaceState,
      globalState,
      repoRoot,
      new Set([sharedKey]),
    );

    expect(memento.get(sharedKey, [])).toEqual(['review']);
    await memento.update(sharedKey, ['latexFixer']);
    expect(globalState.get(namespacedKey)).toEqual(['latexFixer']);
    expect(workspaceState.get(sharedKey)).toBeUndefined();
  });

  it('migrates legacy workspace values before returning defaults', async () => {
    const workspaceState = new FakeMemento(new Map([[sharedKey, ['correct']]]));
    const globalState = new FakeMemento();
    const memento = new WorktreeMemento(
      workspaceState,
      globalState,
      repoRoot,
      new Set([sharedKey]),
    );

    expect(memento.get(sharedKey, [])).toEqual(['correct']);
    expect(globalState.get(namespacedKey)).toEqual(['correct']);
    await Promise.resolve();
    expect(workspaceState.get(sharedKey)).toBeUndefined();
  });

  it('clears legacy workspace values when shared keys are updated', async () => {
    const workspaceState = new FakeMemento(new Map([[sharedKey, ['stale']]]));
    const globalState = new FakeMemento(
      new Map([[namespacedKey, ['current']]]),
    );
    const memento = new WorktreeMemento(
      workspaceState,
      globalState,
      repoRoot,
      new Set([sharedKey]),
    );

    await memento.update(sharedKey, undefined);

    expect(globalState.get(namespacedKey)).toBeUndefined();
    expect(workspaceState.get(sharedKey)).toBeUndefined();
    expect(memento.get(sharedKey, [])).toEqual([]);
  });

  it('leaves non-shared keys in workspace state', async () => {
    const workspaceState = new FakeMemento(
      new Map([[localKey, { one: true }]]),
    );
    const globalState = new FakeMemento();
    const memento = new WorktreeMemento(
      workspaceState,
      globalState,
      repoRoot,
      new Set([sharedKey]),
    );

    expect(memento.get(localKey)).toEqual({ one: true });
    await memento.update(localKey, { two: true });
    expect(workspaceState.get(localKey)).toEqual({ two: true });
    expect(globalState.keys()).toEqual([]);
  });

  it('reports only keys with stored values', () => {
    const workspaceState = new FakeMemento(new Map([[localKey, true]]));
    const globalState = new FakeMemento();
    const memento = new WorktreeMemento(
      workspaceState,
      globalState,
      repoRoot,
      new Set([sharedKey]),
    );

    expect(memento.keys()).toEqual([localKey]);
  });
});
