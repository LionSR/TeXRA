// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - progressView frontend
import { GROUP_DOM_IDS } from '@progressView/frontend/constants';
import type {
  GroupTree,
  MessageIndex,
  TimelineEntry,
} from '@progressView/frontend/components/messageIndex';

// Local imports - shared schemas
import {
  LOG_LEVELS,
  STREAM_PHASE,
  type LogMessageData,
  type TaskGroup,
} from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

const audio = vi.hoisted(() => ({
  playCompletionSound: vi.fn(),
}));

vi.mock('@progressView/frontend/utils/audioNotification', () => audio);

type TaskGroupListInternals = HTMLElement & {
  groups: TaskGroup[];
  messages: LogMessageData[];
  hasStreams: boolean;
  isToolUse: boolean;
  terminal: boolean;
  updateComplete: Promise<boolean>;
  readonly index: MessageIndex;
  willUpdate: (changedProperties: Map<string, unknown>) => void;
};

useLitComponentTestDom(
  () => import('@progressView/frontend/components/TaskGroupList'),
);

function createMessage(
  id: string,
  text: string,
  timestamp: number,
  groupId?: string,
): LogMessageData {
  return {
    id,
    text,
    timestamp,
    level: LOG_LEVELS.INFO,
    ...(groupId ? { groupId } : {}),
  };
}

function createGroup(
  id: string,
  status: TaskGroup['status'],
  options: Partial<Pick<TaskGroup, 'kind' | 'name'>> = {},
): TaskGroup {
  return {
    id,
    name: options.name ?? id,
    startTime: 1,
    status,
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
  };
}

function createList(messages: LogMessageData[]): TaskGroupListInternals {
  const element = document.createElement(
    'task-group-list',
  ) as unknown as TaskGroupListInternals;
  element.groups = [];
  element.messages = messages;
  element.index.rebuildTree([], messages);
  element.index.rebuildTimeline();
  return element;
}

async function renderList(
  groups: TaskGroup[],
  messages: LogMessageData[],
): Promise<TaskGroupListInternals> {
  const element = document.createElement(
    'task-group-list',
  ) as unknown as TaskGroupListInternals;
  element.hasStreams = true;
  element.groups = groups;
  element.messages = messages;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe('task-group-list ungrouped message indexes', () => {
  it('plays round-completion sound for workflow rounds only', () => {
    const list = createList([]);
    const running = createGroup('round-1', STREAM_PHASE.RUNNING, {
      kind: 'round',
    });
    const stopped = createGroup('round-1', STREAM_PHASE.COMPLETED, {
      kind: 'round',
    });

    audio.playCompletionSound.mockClear();

    list.groups = [running];
    list.willUpdate(new Map([['groups', []]]));
    list.groups = [stopped];
    list.willUpdate(new Map([['groups', [running]]]));

    expect(audio.playCompletionSound).toHaveBeenCalledTimes(1);

    list.isToolUse = true;
    list.groups = [running];
    list.willUpdate(new Map([['groups', [stopped]]]));
    list.groups = [stopped];
    list.willUpdate(new Map([['groups', [running]]]));

    expect(audio.playCompletionSound).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy workflow r<N> groups eligible for completion sound', () => {
    const list = createList([]);
    const running = createGroup('legacy-round', STREAM_PHASE.RUNNING, {
      name: 'r2',
    });
    const stopped = createGroup('legacy-round', STREAM_PHASE.COMPLETED, {
      name: 'r2',
    });

    audio.playCompletionSound.mockClear();

    list.groups = [running];
    list.willUpdate(new Map([['groups', []]]));
    list.groups = [stopped];
    list.willUpdate(new Map([['groups', [running]]]));

    expect(audio.playCompletionSound).toHaveBeenCalledTimes(1);
  });

  it('refreshes fallback timeline message refs through the ungrouped-message index', () => {
    const original = [
      createMessage('m1', 'one', 1),
      createMessage('m2', 'two', 2),
      createMessage('m3', 'three', 3),
    ];
    const list = createList(original);
    const updated = { ...original[1], text: 'two updated' };
    const next = [original[0], updated, original[2]];

    list.index.updateCachedMessageRefs(next, original, [1]);

    expect(list.index.ungrouped[1]).toBe(updated);

    const timelineEntry = list.index.timeline.find(
      (entry): entry is Extract<TimelineEntry, { msg: LogMessageData }> =>
        entry.key === 'm2' && 'msg' in entry,
    );
    expect(timelineEntry?.msg).toBe(original[1]);

    list.index.updateTimelineMessageRefs(next, [1]);

    expect(timelineEntry?.msg).toBe(updated);
  });

  it('patches stable group metadata without rebuilding the message tree', () => {
    const group = createGroup('g1', STREAM_PHASE.RUNNING);
    const message = createMessage('m1', 'grouped', 2, group.id);
    const list = createList([message]);
    list.groups = [group];
    list.index.rebuildTree([group], [message]);
    list.index.rebuildTimeline();

    const originalTree: GroupTree | undefined = list.index.tree[0];
    const stoppedGroup = {
      ...group,
      status: STREAM_PHASE.COMPLETED,
      endTime: 3,
    };
    list.groups = [stoppedGroup];
    list.index.rebuildTree = () => {
      throw new Error('unexpected full group tree rebuild');
    };
    list.index.updateTimelineMessageRefs = () => {
      throw new Error('unexpected timeline message scan');
    };

    list.willUpdate(new Map([['groups', [group]]]));

    expect(list.index.tree[0]).toBe(originalTree);
    expect(list.index.tree[0]?.group).toBe(stoppedGroup);
    expect(list.index.tree[0]?.messages).toEqual([message]);
    expect(list.index.timeline).toHaveLength(1);
  });

  it('bounds top-level timeline DOM for large ungrouped streams', async () => {
    const messages = Array.from({ length: 130 }, (_, index) =>
      createMessage(`m${index}`, `entry ${index}`, index),
    );

    const list = await renderList([], messages);

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      120,
    );
    expect(list.shadowRoot?.textContent).not.toContain('entry 0');
    expect(list.shadowRoot?.textContent).toContain('entry 129');

    const revealButton = list.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-reveal-kind="timeline"]',
    );
    expect(revealButton?.dataset.hiddenCount).toBe('10');
    // Regression coverage: the reveal control renders as a themed
    // <wa-button>, not a hand-rolled native <button> (see logEntryStyles.ts).
    expect(revealButton?.tagName).toBe('WA-BUTTON');

    revealButton?.click();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      130,
    );
    expect(list.shadowRoot?.textContent).toContain('entry 0');
  });

  it('bounds rendered message DOM inside large groups', async () => {
    const group = createGroup('g1', STREAM_PHASE.RUNNING);
    const messages = Array.from({ length: 450 }, (_, index) =>
      createMessage(`m${index}`, `group entry ${index}`, index, group.id),
    );

    const list = await renderList([group], messages);

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      400,
    );
    expect(list.shadowRoot?.textContent).not.toContain('group entry 0');
    expect(list.shadowRoot?.textContent).toContain('group entry 449');

    const revealButton = list.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-reveal-kind="messages"]',
    );
    expect(revealButton?.dataset.hiddenCount).toBe('50');

    revealButton?.click();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      450,
    );
    expect(list.shadowRoot?.textContent).toContain('group entry 0');
  });

  it('resets expanded render windows when leaving terminal mode', async () => {
    const group = createGroup('g1', STREAM_PHASE.RUNNING);
    const messages = Array.from({ length: 450 }, (_, index) =>
      createMessage(`m${index}`, `group entry ${index}`, index, group.id),
    );
    const list = await renderList([group], messages);

    const revealButton = list.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-reveal-kind="messages"]',
    );
    revealButton?.click();
    await list.updateComplete;
    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      450,
    );

    list.terminal = true;
    await list.updateComplete;
    list.terminal = false;
    await list.updateComplete;

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      400,
    );
  });
});

describe('task-group-list orphan re-rooting', () => {
  it('renders a group whose parent is absent as a root, with its subtree and messages', () => {
    const list = createList([]);
    // "run" points at a parent that is NOT in the set — e.g. a cross-trace
    // stage id this stream never recorded. It must still render.
    const run: TaskGroup = {
      id: 'run',
      name: 'Run: subagent',
      startTime: 1,
      status: STREAM_PHASE.RUNNING,
      parentGroupId: 'phantom-orchestrator-stage',
    };
    const init: TaskGroup = {
      id: 'init',
      name: 'Init',
      startTime: 2,
      status: STREAM_PHASE.COMPLETED,
      parentGroupId: 'run',
    };
    const scratchpad = createMessage('m1', 'scratchpad', 3, 'init');

    list.index.rebuildTree([run, init], [scratchpad]);

    // The dangling-parent group is re-rooted instead of silently dropped.
    expect(list.index.tree).toHaveLength(1);
    const root = list.index.tree[0];
    expect(root.group.id).toBe('run');
    // Its subtree survives...
    expect(root.children.map((c) => c.group.id)).toEqual(['init']);
    // ...and so do the messages nested under it.
    expect(root.children[0].messages.map((m) => m.id)).toEqual(['m1']);
    // The nested message is not mis-filed as ungrouped.
    expect(list.index.ungrouped).toHaveLength(0);
  });

  it('renders a re-rooted orphan with the root-container layout, not nested', async () => {
    // A group with a dangling parent is promoted to a tree root; the renderer
    // must give it the root container (keyed on tree position), not the
    // collapsible <details> layout it would get from its raw parentGroupId.
    const run: TaskGroup = {
      id: 'run',
      name: 'Run: subagent',
      startTime: 1,
      status: STREAM_PHASE.RUNNING,
      parentGroupId: 'phantom-orchestrator-stage',
    };
    const list = await renderList([run], []);

    // Root layout emits a div.log-run with data-run-id; child groups never do
    // (they render as <details> with summary/content ids only).
    const rootEl = list.shadowRoot?.querySelector('[data-run-id="run"]');
    expect(rootEl).not.toBeNull();
    expect(rootEl?.classList.contains('log-run')).toBe(true);
  });
});

// #7993 step 3: TaskGroup.status carries the native StreamPhase/RunOutcome
// vocabulary end to end. Renders a canonical GROUP_END-derived group of each
// terminal status and checks the icon distinguishes them — proving the
// legacy-bucket-fold deletion in logSlice.ts (LogDeltaTextDeltas.vitest.ts
// pins the mapping into TaskGroup.status) is safe all the way to the DOM:
// a failed group keeps its own error icon instead of losing it to the old
// STOPPED default, and a cancelled group no longer renders identically to a
// completed one.
describe('task-group-list status icon (#7993 step 3)', () => {
  it('renders a distinct icon for completed, cancelled, and failed groups', async () => {
    const parent: TaskGroup = {
      id: 'run',
      name: 'Run: workflow',
      startTime: 1,
      status: STREAM_PHASE.RUNNING,
    };
    const groups: TaskGroup[] = [
      parent,
      {
        id: 'completed-phase',
        name: 'Completed phase',
        startTime: 2,
        status: STREAM_PHASE.COMPLETED,
        parentGroupId: 'run',
      },
      {
        id: 'cancelled-phase',
        name: 'Cancelled phase',
        startTime: 3,
        status: STREAM_PHASE.CANCELLED,
        parentGroupId: 'run',
      },
      {
        id: 'failed-phase',
        name: 'Failed phase',
        startTime: 4,
        status: STREAM_PHASE.FAILED,
        parentGroupId: 'run',
      },
    ];

    const list = await renderList(groups, []);

    const iconFor = (groupId: string): string | null =>
      list.shadowRoot
        ?.querySelector(`#${GROUP_DOM_IDS.HEADER_PREFIX}${groupId} wa-icon`)
        ?.getAttribute('name') ?? null;

    expect(iconFor('completed-phase')).toBe('check');
    expect(iconFor('cancelled-phase')).toBe('circle-stop');
    expect(iconFor('failed-phase')).toBe('error');
  });
});
