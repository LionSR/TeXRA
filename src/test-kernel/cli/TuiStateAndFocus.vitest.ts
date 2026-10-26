import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  rootRunId,
  resetCliState,
  sessionListRows,
  sessionListRunIds,
  actOnSurface,
} from '@cli/chat/tui/state/cliState';
import { allocateMiddleRows } from '@cli/chat/tui/appLayout';
import {
  chatTuiCanStartRootRun,
  runStopFacts,
  TuiSession,
} from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/exitCodes';
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
    expect(acceptsFollowUp(stream(grandchild))).toBe(true);
    expect(acceptsFollowUp(stream(child1))).toBe(false);
    expect(acceptsFollowUp(stream(child2))).toBe(false);
  });
});

describe('CLI TUI row allocation', () => {
  it.each([
    {
      name: 'keeps foreground approval and form surfaces inside the middle row budget',
      options: { footerRows: 5, foregroundOpen: true, rows: 24 },
      transcriptRows: 1,
      foregroundRows: 18,
    },
    {
      name: 'returns disabled input rows to tiny foreground surfaces',
      options: { footerRows: 2, foregroundOpen: true, rows: 10 },
      transcriptRows: 1,
      foregroundRows: 7,
    },
    {
      name: 'can cap compact foreground surfaces on tall terminals',
      options: {
        footerRows: 5,
        foregroundMaxRows: 12,
        foregroundOpen: true,
        rows: 40,
      },
      transcriptRows: 1,
      foregroundRows: 12,
    },
    {
      name: 'reserves queued follow-up, palette and static rows before the transcript',
      options: {
        footerRows: 5,
        foregroundOpen: false,
        queuedFollowUpPanelRows: 3,
        rows: 24,
        slashPaletteOpen: true,
        staticTranscriptRows: 2,
      },
      transcriptRows: 1,
      foregroundRows: 0,
    },
  ])('$name', ({ options, transcriptRows, foregroundRows }) => {
    const layout = allocateMiddleRows({
      reverseSearchOpen: false,
      slashPaletteOpen: false,
      ...options,
    });

    expect(layout.transcriptRows).toBe(transcriptRows);
    expect(layout.foregroundRows).toBe(foregroundRows);
  });
});

describe('CLI TUI session run state', () => {
  it('marks a chat root run pending before async startup work resolves', () => {
    const startupSettled = Effect.never;
    const session = new TuiSession();
    session.runId = root;
    session.runExitCode = CliExitCode.AgentError;
    const earlier = Effect.void;
    session.markRunPending(earlier);
    session.markRunCompleted(earlier);
    session.runId = root;
    session.askStop('user');

    session.markRunPending(startupSettled);

    expect(session.runId).toBeUndefined();
    expect(session.runSettled).toBe(startupSettled);
    expect(session.runExitCode).toBe(CliExitCode.Success);
    expect(session.runCompleted).toBe(false);
    expect(session.stopRequested).toBe(false);
    expect(chatTuiCanStartRootRun(session)).toBe(false);
    expect(runStopFacts.get().runPending).toBe(true);
    expect(runStopFacts.get().runId).toBeUndefined();
  });
});
