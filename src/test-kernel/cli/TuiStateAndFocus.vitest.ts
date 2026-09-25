import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  rootRunPending,
  rootRunId,
  claimedRunId,
  resetCliState,
  setTransientNotice,
  transientNotice,
  sessionListRows,
  sessionListRunIds,
  actOnSurface,
} from '@cli/chat/tui/state/cliState';
import {
  chatTuiCanStartRootRun,
  TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { CLI_FOLLOW_UP_HOST } from '@cli/chat/tui/state/sessionView';
import { resolveChildListTarget } from '@cli/chat/tui/state/childControls';
import { RUN_PHASE, type RunId } from '@shared/schemas';
import { acceptsFollowUp, type RunView } from '@shared/session/sessionView';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

const root = 'root' as RunId;
const child1 = 'child-1' as RunId;
const child2 = 'child-2' as RunId;
const grandchild = 'grandchild-1' as RunId;

/** A root with two children created in name order, the second of which has
 *  one child. */
function familyView(over: Partial<Record<RunId, Partial<RunView>>> = {}) {
  const ancestorsOf = (...ids: RunId[]) => ids.map((id) => ({ id, label: id }));
  return viewWith([
    makeRunView({ id: root, createdAt: 1, ...over[root] }),
    makeRunView({
      id: child1,
      createdAt: 2,
      parentId: root,
      ancestors: ancestorsOf(root),
      ...over[child1],
    }),
    makeRunView({
      id: child2,
      createdAt: 3,
      parentId: root,
      ancestors: ancestorsOf(root),
      ...over[child2],
    }),
    makeRunView({
      id: grandchild,
      createdAt: 4,
      parentId: child2,
      ancestors: ancestorsOf(root, child2),
      ...over[grandchild],
    }),
  ]);
}

describe('focus over the session view', () => {
  beforeAll(bindTestSessionView);

  it('keeps keyboard order identical to the grouped, expanded tree', () => {
    resetCliState();
    seedView(familyView({ [child2]: { forceExpanded: true } }));
    rootRunId.set(root);
    expect(sessionListRunIds.get()).toEqual([root]);
    actOnSurface({ kind: 'expand', runId: root, expanded: true });
    expect(sessionListRunIds.get()).toEqual([root, child2, grandchild, child1]);
    actOnSurface({ kind: 'expand', runId: child2, expanded: false });
    expect(sessionListRunIds.get()).toEqual([root, child2, grandchild, child1]);
    expect(
      sessionListRows
        .get()
        .filter((row) => row.kind === 'group')
        .map((row) => row.label),
    ).toEqual(['Running']);
    resetCliState();
    expect(sessionListRunIds.get()).toEqual([]);
  });

  it('resolves the child list to the nearest ancestor with children', () => {
    const view = familyView();
    expect(resolveChildListTarget(view, child1)).toBe(root);
    expect(resolveChildListTarget(view, child2)).toBe(child2);
    expect(resolveChildListTarget(view, grandchild)).toBe(child2);
    expect(resolveChildListTarget(view, undefined)).toBeUndefined();
  });

  it('routes composer follow-ups only to in-flight plain tool-use children', () => {
    const view = familyView({
      [child1]: { status: RUN_PHASE.COMPLETED },
      [child2]: {
        identity: { kind: 'process', tool: 'bash' },
        followUpSupport: 'unsupported',
      },
    });
    const stream = (id: RunId): RunView => {
      const found = view.runs.get(id);
      if (!found) throw new Error(`missing ${id}`);
      return found;
    };
    expect(acceptsFollowUp(stream(grandchild), CLI_FOLLOW_UP_HOST)).toBe(true);
    expect(acceptsFollowUp(stream(child1), CLI_FOLLOW_UP_HOST)).toBe(false);
    expect(acceptsFollowUp(stream(child2), CLI_FOLLOW_UP_HOST)).toBe(false);
  });
});

describe('cliState surface fields', () => {
  it('normalizes transient notices to the status bar single-line contract', () => {
    setTransientNotice('Usage: /login target\n       /login chatgpt --device');

    expect(transientNotice.get()).toMatchObject({
      kind: 'message',
      text: 'Usage: /login target · /login chatgpt --device',
    });
  });
});

describe('CLI TUI session run state', () => {
  it.each([
    {
      name: 'before the stream resolves',
      runCompleted: false,
      runSettled: Effect.void,
      runId: undefined,
      expected: false,
    },
    {
      name: 'while startup is pending',
      runCompleted: false,
      runSettled: undefined,
      runId: root,
      expected: false,
    },
    {
      name: 'after the run completed',
      runCompleted: true,
      runSettled: Effect.void,
      runId: root,
      expected: false,
    },
    {
      name: 'with the stream resolved and the run in flight',
      runCompleted: false,
      runSettled: Effect.void,
      runId: root,
      expected: true,
    },
  ])(
    'only reports a waiting tool-use run resumable-idle $name',
    ({ runCompleted, runSettled, runId, expected }) => {
      seedView(familyView({ [root]: { status: RUN_PHASE.WAITING } }));
      const session = new TuiSession(() => ({}) as never);
      if (runSettled) session.markRunPending(runSettled);
      if (runCompleted) session.markRunCompleted();
      session.runId = runId;
      expect(session.isResumableIdle()).toBe(expected);
    },
  );

  it('marks a chat root run pending before async startup work resolves', () => {
    const startupSettled = Effect.never;
    const session = new TuiSession(() => undefined);
    session.runId = root;
    session.runExitCode = CliExitCode.AgentError;
    session.markRunCompleted();
    session.stopRequested = true;

    session.markRunPending(startupSettled);

    expect(session.runId).toBeUndefined();
    expect(session.runSettled).toBe(startupSettled);
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);
    expect(rootRunPending.get()).toBe(true);
    expect(claimedRunId.get()).toBeUndefined();
  });

  it('publishes the run-control run id from the session itself', () => {
    const session = new TuiSession(() => undefined);
    session.markRunPending(Effect.never);
    expect(claimedRunId.get()).toBeUndefined();

    // No publish call accompanies this write: the session owns the mirror,
    // so a caller cannot leave the Ctrl-C hint reading a stale claim (#8273).
    session.runId = root;

    expect(claimedRunId.get()).toBe(root);
    expect(rootRunPending.get()).toBe(true);

    session.markRunCompleted();

    expect(claimedRunId.get()).toBe(root);
    expect(rootRunPending.get()).toBe(false);
  });

  it('clears stale resume ids when clearing chat session run state', () => {
    const session = new TuiSession(() => undefined);
    session.markRunPending(Effect.void);
    session.markRunCompleted();
    session.runId = root;
    session.interruptedRunId = root;
    session.runExitCode = CliExitCode.Interrupted;
    session.stopRequested = true;

    session.clearRunState();

    expect(session.runId).toBeUndefined();
    expect(session.interruptedRunId).toBeUndefined();
    expect(session.runSettled).toBeUndefined();
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
  });
});
