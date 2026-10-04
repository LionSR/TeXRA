import { setTimeout as sleep } from 'node:timers/promises';

import { Effect } from 'effect';

import stripAnsi from 'strip-ansi';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { App, type AppProps } from '@cli/chat/tui/App';
import { ESC_META_CHORD_INTERRUPT_DELAY_MS } from '@cli/chat/tui/appInteractionPolicy';
import { takeActiveForm } from '@cli/chat/tui/state/formSlot';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import {
  selectedRunId,
  focusRun,
  foregroundReader,
  infoPane,
  openInfoPane,
  resetCliState,
  rootRunId,
  actOnSurface,
} from '@cli/chat/tui/state/cliState';
import {
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type RunIdentity,
  type RunPhase,
} from '@shared/schemas';
import { runUnreadableMessage } from '@shared/runs/runStatusDisplay';
import type { SessionView, RunView } from '@shared/session/sessionView';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { textRowFixture } from '@test/support/transcriptRowFixtures';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.ts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

vi.mock('@cli/runtime/shortcutLabels', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/shortcutLabels')>();
  return { ...actual, defaultShortcutModifierLabel: () => 'Esc' };
});

const ROOT = 'escape-root' as RunId;
const CHILD = 'escape-child' as RunId;
const GRANDCHILD = 'escape-grandchild' as RunId;
const ESC = String.fromCharCode(27);

const ARROW_KEYS = {
  Up: '\u001B[A',
  Down: '\u001B[B',
  Right: '\u001B[C',
  Left: '\u001B[D',
} as const;

// Chord-window brackets derive from the production delay so a duration change
// cannot silently invalidate the within-window/expired distinction.
const WITHIN_CHORD_WINDOW_MS = Math.max(
  30,
  Math.floor(ESC_META_CHORD_INTERRUPT_DELAY_MS / 10),
);
const CHORD_WINDOW_EXPIRED_MS = ESC_META_CHORD_INTERRUPT_DELAY_MS + 100;

// The status machine stamps a run window on every RUNNING transition and the
// slice mirrors it verbatim, so a seeded RUNNING must state one too — the
// status bar's live elapsed segment (and the 1 Hz repaint that drives these
// layout assertions) exists only while it is set.
/** The runs a case names, as the fold states them; every seed rewrites
 *  the whole view the App reads. */
const seeded = new Map<RunId, RunView>();
/** The requests the fold lists: `request.opened` facts not yet decided. */
let seededRequests: SessionView['requests'] = [];
function syncSeededView(): void {
  seedView(viewWith([...seeded.values()], { requests: seededRequests }));
}
/** Every pending request decided: the runtime's `request.decided` folded. */
function clearSeededRequests(): void {
  seededRequests = [];
  syncSeededView();
}
function seedRun(id: RunId, over: Partial<RunView> = {}): void {
  const current = seeded.get(id);
  seeded.set(id, makeRunView({ ...(current ?? {}), ...over, id }) as RunView);
  syncSeededView();
}
function setRunning(...runIds: RunId[]): void {
  for (const runId of runIds) {
    seedRun(runId, {
      status: RUN_PHASE.RUNNING,
      runStartedAt: Date.now(),
    });
  }
}
/** Summary metadata as the fold states it: an absent identity or support
 *  level is the fold's null and unsupported, never the fixture's default. */
function seedRunMeta(
  runId: RunId,
  meta: {
    identity?: RunView['identity'];
    userFollowUpSupport?: RunView['followUpSupport'];
    documentTask?: boolean;
  },
): void {
  seedRun(runId, {
    identity: meta.identity,
    followUpSupport:
      meta.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    ...(meta.documentTask !== undefined
      ? { documentTask: meta.documentTask }
      : {}),
  });
}
function markToolUseAgent(...runIds: RunId[]): void {
  for (const runId of runIds) {
    seedRunMeta(runId, {
      identity: { kind: 'agent', agent: 'child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    });
  }
}
/** A child the fold holds under its parent, as these cases name one. */
type ChildRow = {
  readonly childRunId: RunId;
  readonly agentName: string;
  readonly identity: RunIdentity;
  readonly status?: RunPhase;
};

function runningChild(childRunId: RunId, agentName: string): ChildRow {
  return {
    childRunId,
    agentName,
    identity: { kind: 'agent' as const, agent: agentName },
    status: RUN_PHASE.RUNNING,
  };
}

// Seed the child lists and parent edges through the session event fold.
function seedChildRows(parentRunId: RunId, rows: readonly ChildRow[]): void {
  seedRun(parentRunId);
  for (const row of rows) {
    seedRun(row.childRunId, {
      label: row.agentName,
      identity: row.identity,
      status: row.status ?? RUN_PHASE.COMPLETED,
    });
    seedParentEdge(row.childRunId, parentRunId);
  }
}
function seedParentEdge(runId: RunId, parentRunId: RunId | null): void {
  const parent = parentRunId === null ? undefined : seeded.get(parentRunId);
  seedRun(runId, {
    parentId: parentRunId,
    ancestors:
      parentRunId === null
        ? []
        : [
            ...(parent?.ancestors ?? []),
            { id: parentRunId, label: parent?.label ?? parentRunId },
          ],
  });
}
function seedRootRun(): void {
  rootRunId.set(ROOT);
  new TuiSession(() => undefined).markRunPending(Effect.never);
  setRunning(ROOT);
  focusRun(ROOT);
}

function seedChildHierarchy(): void {
  seedRootRun();
  setRunning(CHILD, GRANDCHILD);
  seedRun(CHILD, { ownedHere: true });
  seedRun(GRANDCHILD, { ownedHere: true });
  markToolUseAgent(CHILD, GRANDCHILD);
  seedChildRows(ROOT, [runningChild(CHILD, 'child')]);
  seedChildRows(CHILD, [runningChild(GRANDCHILD, 'grandchild')]);
  seedParentEdge(CHILD, ROOT);
  seedParentEdge(GRANDCHILD, CHILD);
}

function finishNestedHierarchyAndFocusRoot(): void {
  for (const runId of [GRANDCHILD, CHILD]) {
    seedRun(runId, { status: RUN_PHASE.COMPLETED });
  }
  focusRun(ROOT);
}

function appProps(): AppProps {
  return {
    // The status bar's subscription probe never runs in these key-routing
    // suites; the App only requires the stores to be present.
    secrets: new FakeSecrets(),
    stores: makeFakeSettingsStores('cli').stores,
    runtime: testRuntime(),
    session: testDefaultSession(),
    onSubmit: vi.fn(),
    onCtrlC: vi.fn(),
  };
}

async function renderApp(props: AppProps): Promise<InkRenderHandles> {
  const { ink, React } = await loadInk();
  const handles = renderInteractive(ink, React.createElement(App, props), {
    columns: 100,
    rows: 30,
  });
  await waitFor(() => handles.stdin.listenerCount('readable') > 0);
  return handles;
}

async function renderRoutingApp(
  extraProps: Partial<AppProps> = {},
): Promise<InkRenderHandles> {
  return renderApp({ ...appProps(), ...extraProps });
}

async function renderDebugApp(
  props: AppProps,
  size: { columns: number; rows: number },
): Promise<InkRenderHandles> {
  const { ink, React } = await loadInk();
  return renderInteractive(ink, React.createElement(App, props), {
    ...size,
    debug: true,
  });
}

function currentFrame(stdout: InkRenderHandles['stdout']): string {
  return stripAnsi(stdout.writes.findLast((write) => write.length > 0) ?? '');
}

beforeAll(bindTestSessionView);
beforeEach(() => {
  resetCliState();
  seeded.clear();
  seededRequests = [];
  syncSeededView();
});
afterEach(() => {
  clearSeededRequests();
  resetCliState();
});

describe('App foreground Escape ownership', () => {
  it('renders the latest transcript after a burst of microtask updates', async () => {
    seedRootRun();
    const { instance, stdout } = await renderRoutingApp();
    try {
      // Successive snapshots must not trigger effects that schedule another
      // state update after every render. Those follow-up commits exhausted
      // React's nested-update limit during a microtask burst.
      for (let index = 0; index < 150; index += 1) {
        seedRun(ROOT, {
          transcript: {
            rows: [
              textRowFixture(
                'streaming',
                'assistant',
                `stream update ${index}`,
              ),
            ],
            settledRows: 0,
            taskGroups: [],
          },
        });
        await new Promise<void>((resolve) => queueMicrotask(resolve));
      }
      await waitFor(() => stdout.output.includes('stream update 149'));
    } finally {
      instance.unmount();
    }
  });
  it('mounts a form that takes the slot with its own state', async () => {
    seedRootRun();
    const { ink, React } = await loadInk();
    function Probe({ label }: { readonly label: string }) {
      const [shown] = React.useState(label);
      return React.createElement(ink.Text, null, `form:${shown}`);
    }
    const openProbe = (label: string): void =>
      takeActiveForm({
        commandName: 'probe',
        render: () => React.createElement(Probe, { label }),
      });
    const { instance, stdout } = await renderRoutingApp();
    try {
      openProbe('first');
      await waitFor(() => stdout.output.includes('form:first'));
      openProbe('second');
      await waitFor(() => stdout.output.includes('form:second'));
    } finally {
      instance.unmount();
    }
  });

  it('lets a foreground information pane own Escape before child back', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    openInfoPane('Reference', 'Foreground content');
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await waitFor(() => infoPane.get() === undefined);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(selectedRunId.get()).toBe(CHILD);
    } finally {
      instance.unmount();
    }
  });

  it('walks nested children back one immediate parent per bare Escape', async () => {
    seedChildHierarchy();
    focusRun(GRANDCHILD);
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await waitFor(() => selectedRunId.get() === CHILD);
      stdin.write(ESC);
      await waitFor(() => selectedRunId.get() === ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('does not apply delayed child back after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      openInfoPane('Late reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late reference');
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(selectedRunId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late reference');
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusRun(GRANDCHILD);
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => selectedRunId.get() === ROOT);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(selectedRunId.get()).toBe(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back when the child is promoted', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      seedParentEdge(CHILD, null);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(selectedRunId.get()).toBe(CHILD);
    } finally {
      instance.unmount();
    }
  });

  it.each([
    {
      // Completed child: its input is disabled, so the printable key fails the
      // chord and must be preserved into the parent input that back enables.
      name: 'preserves a printable failed chord when back enables parent input',
      childStatus: RUN_PHASE.COMPLETED,
    },
    {
      // Running child: its input is enabled, so the printable key must not be
      // duplicated into the parent input when back resolves.
      name: 'does not duplicate a printable failed chord from enabled input',
      childStatus: RUN_PHASE.RUNNING,
    },
  ])('$name', async ({ childStatus }) => {
    seedChildHierarchy();
    seedRun(CHILD, { status: childStatus });
    focusRun(CHILD);
    const onSubmit = vi.fn();
    const { instance, stdin } = await renderRoutingApp({
      onSubmit,
    });

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write('q');
      await waitFor(() => selectedRunId.get() === ROOT);
      stdin.write('\r');
      await waitFor(() => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith('q', undefined, undefined);
    } finally {
      instance.unmount();
    }
  });

  it('does not resolve Esc-digit focus after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      openInfoPane('Late chord reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late chord reference');
      stdin.write('1');
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(selectedRunId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late chord reference');
    } finally {
      instance.unmount();
    }
  });

  it('preserves two quick bare-Escape actions through the chord window', async () => {
    seedChildHierarchy();
    focusRun(GRANDCHILD);
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write(ESC);
      await waitFor(() => selectedRunId.get() === CHILD);
      await waitFor(() => selectedRunId.get() === ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('keeps an Esc-digit focus target after the bare-Escape window expires', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    actOnSurface({ kind: 'expand', runId: ROOT, expanded: true });
    actOnSurface({ kind: 'expand', runId: CHILD, expanded: true });
    const { instance, stdin } = await renderRoutingApp();

    try {
      stdin.write(ESC);
      await sleep(WITHIN_CHORD_WINDOW_MS);
      stdin.write('3');
      await waitFor(() => selectedRunId.get() === GRANDCHILD);
      await sleep(CHORD_WINDOW_EXPIRED_MS);

      expect(selectedRunId.get()).toBe(GRANDCHILD);
    } finally {
      instance.unmount();
    }
  });

  it('collapses an incapable child composer while preserving navigation and the root draft', async () => {
    seedChildHierarchy();
    focusRun(ROOT);
    const onSubmit = vi.fn();
    const { instance, stdin, stdout } = await renderDebugApp(
      { ...appProps(), onSubmit },
      { columns: 100, rows: 30 },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('preserved root draft');
      await waitFor(() =>
        currentFrame(stdout).includes('preserved root draft'),
      );

      seedRunMeta(CHILD, {
        identity: { kind: 'process', tool: 'bash' },
      });
      focusRun(CHILD);
      await waitFor(() => selectedRunId.get() === CHILD);
      await waitFor(
        () => !currentFrame(stdout).includes('preserved root draft'),
      );

      stdin.write('ignored printable submit\r');
      await sleep(30);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(currentFrame(stdout)).not.toContain('ignored printable submit');

      stdin.write('\t');
      await sleep(30);
      stdin.write('\x14');
      await sleep(30);
      expect(foregroundReader.get()).toBeUndefined();
      stdin.write('\t');
      await sleep(30);

      stdin.write('\x14');
      await waitFor(
        () =>
          foregroundReader.get()?.kind === 'transcript' &&
          foregroundReader.get()?.runId === CHILD,
      );
      stdin.write(ESC);
      await waitFor(() => foregroundReader.get() === undefined);
      stdin.write(ESC);
      await waitFor(() => selectedRunId.get() === ROOT);
      await waitFor(() =>
        currentFrame(stdout).includes('preserved root draft'),
      );
      stdin.write('\r');
      await waitFor(() => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith(
        'preserved root draft',
        undefined,
        undefined,
      );
    } finally {
      instance.unmount();
    }
  });

  it('shows an unreadable root as read-only', async () => {
    seedChildHierarchy();
    const onSubmit = vi.fn();
    const detail = runUnreadableMessage('checkpoint is malformed');
    const { instance, stdin, stdout } = await renderDebugApp(
      { ...appProps(), onSubmit },
      { columns: 240, rows: 30 },
    );

    try {
      seedRun(ROOT, { readOnly: true, statusDetail: detail });
      await waitFor(() =>
        currentFrame(stdout).replaceAll(/\s+/gu, ' ').includes(detail),
      );

      stdin.write('must not submit\r');
      await sleep(30);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it.each([RUN_PHASE.RUNNING, RUN_PHASE.WAITING])(
    'keeps the composer enabled for a %s tool-use agent child',
    async (status) => {
      seedChildHierarchy();
      seedRun(CHILD, { status });
      focusRun(CHILD);
      const onSubmit = vi.fn();
      const { instance, stdin } = await renderRoutingApp({ onSubmit });

      try {
        stdin.write('child follow-up\r');
        await waitFor(() => onSubmit.mock.calls.length === 1);
        expect(onSubmit).toHaveBeenCalledWith(
          'child follow-up',
          undefined,
          undefined,
        );
      } finally {
        instance.unmount();
      }
    },
  );

  it.each([
    {
      name: 'structured single-cycle workflow call',
      identity: { kind: 'agent' as const, agent: 'structured-child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    },
    {
      name: 'document task',
      identity: { kind: 'agent' as const, agent: 'workflow-child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      documentTask: true,
    },
    {
      name: 'background script',
      identity: { kind: 'script' as const, title: 'workflow-child' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    },
    {
      name: 'background bash process',
      identity: { kind: 'process' as const, tool: 'bash' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    },
    {
      name: 'terminal-backed agent',
      identity: {
        kind: 'agent' as const,
        agent: 'codex',
        tool: 'codex',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
    },
    {
      name: 'missing metadata',
      identity: undefined,
      userFollowUpSupport: undefined,
    },
  ])(
    'ignores printable submission for a running $name child',
    async (fixture) => {
      seedChildHierarchy();
      seedRunMeta(CHILD, {
        identity: fixture.identity,
        userFollowUpSupport: fixture.userFollowUpSupport,
        documentTask: fixture.documentTask,
      });
      focusRun(CHILD);
      const onSubmit = vi.fn();
      const { instance, stdin, stdout } = await renderRoutingApp({
        onSubmit,
      });

      try {
        stdin.write('must not submit\r');
        await sleep(30);
        expect(stdout.output).not.toContain('must not submit');
        expect(onSubmit).not.toHaveBeenCalled();
      } finally {
        instance.unmount();
      }
    },
  );

  it('treats list Escape as cancel and Tab as the explicit ownership transfer', async () => {
    seedChildHierarchy();
    focusRun(CHILD);
    const { instance, stdin, stdout } = await renderRoutingApp();

    try {
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('Agent list'));
      const beforeListCancel = stdout.output.length;
      stdin.write(ESC);
      await waitFor(() =>
        stdout.output.slice(beforeListCancel).includes('Esc parent'),
      );

      expect(selectedRunId.get()).toBe(CHILD);

      const beforeListFocus = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.slice(beforeListFocus).includes('Agent list'),
      );
      const beforeTabReturn = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.slice(beforeTabReturn).includes('Esc parent'),
      );
    } finally {
      instance.unmount();
    }
  });

  it('does not transfer idle input arrows to an available child list', async () => {
    seedChildHierarchy();
    focusRun(ROOT);
    const { instance, stdin, stdout } = await renderRoutingApp();

    try {
      for (const arrowInput of Object.values(ARROW_KEYS)) {
        stdin.write(arrowInput);
      }
      await sleep(30);

      expect(stdout.output).not.toContain('Agent list');
      expect(selectedRunId.get()).toBe(ROOT);
    } finally {
      instance.unmount();
    }
  });
});
