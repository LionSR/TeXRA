// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { GROUP_DOM_IDS } from '@progressView/frontend/constants';
import type {
  GroupTree,
  MessageIndex,
  TimelineEntry,
} from '@progressView/frontend/components/messageIndex';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_PHASE,
  type LogMessageData,
  type StreamTabId,
  type TaskGroup,
  type WorkflowCallProgress,
} from '@shared/schemas';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

const audio = vi.hoisted(() => ({
  playCompletionSound: vi.fn(),
}));

vi.mock('@progressView/frontend/audioNotification', () => audio);

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
  overrides: Partial<TaskGroup> = {},
): TaskGroup {
  return { id, name: id, startTime: 1, status, ...overrides };
}

function runGroup(name: string, overrides: Partial<TaskGroup> = {}): TaskGroup {
  return createGroup('run', STREAM_PHASE.RUNNING, { name, ...overrides });
}

function workflowTaskMessage(
  groupId: string,
  id: string,
  timestamp: number,
  data: WorkflowCallProgress,
  level: LogMessageData['level'] = LOG_LEVELS.INFO,
): LogMessageData {
  return {
    id,
    text: data.id,
    timestamp,
    level,
    groupId,
    messageType: MESSAGE_TYPES.WORKFLOW_TASK,
    data,
  };
}

function groupHeader(
  list: TaskGroupListInternals,
  groupId: string,
): Element | null | undefined {
  return list.shadowRoot?.querySelector(
    `#${GROUP_DOM_IDS.HEADER_PREFIX}${groupId}`,
  );
}

function groupContent(
  list: TaskGroupListInternals,
  groupId: string,
): Element | null | undefined {
  return list.shadowRoot?.querySelector(
    `#${GROUP_DOM_IDS.CONTENT_PREFIX}${groupId}`,
  );
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

function renderList(
  groups: TaskGroup[],
  messages: LogMessageData[],
): Promise<TaskGroupListInternals> {
  return mountComponent<TaskGroupListInternals>('task-group-list', {
    hasStreams: true,
    groups,
    messages,
  });
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

  it('keeps one location record coherent across out-of-order insertion and update', () => {
    const original = [
      createMessage('m1', 'one', 1),
      createMessage('m3', 'three', 3),
    ];
    const list = createList(original);
    const inserted = createMessage('m2', 'two', 2);
    const withInsertion = [...original, inserted];

    list.index.appendNewMessages(withInsertion, original.length);
    list.index.appendToTimeline(withInsertion, original.length);

    expect(list.index.ungrouped.map((message) => message.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    expect(list.index.timeline.map((entry) => entry.key)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);

    const updated = { ...inserted, text: 'two updated' };
    const next = [...original, updated];
    list.index.updateCachedMessageRefs(next, withInsertion, [2]);
    list.index.updateTimelineMessageRefs(next, [2]);

    expect(list.index.ungrouped[1]).toBe(updated);
    expect(
      list.index.timeline.find((entry) => entry.key === 'm2' && 'msg' in entry),
    ).toMatchObject({ msg: updated });
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

  it.each([
    {
      name: 'top-level timeline DOM for large ungrouped streams',
      revealKind: 'timeline',
      total: 130,
      shown: 120,
      hidden: '10',
      grouped: false,
    },
    {
      name: 'rendered message DOM inside large groups',
      revealKind: 'messages',
      total: 450,
      shown: 400,
      hidden: '50',
      grouped: true,
    },
  ])('bounds $name', async ({ revealKind, total, shown, hidden, grouped }) => {
    const group = createGroup('g1', STREAM_PHASE.RUNNING);
    const messages = Array.from({ length: total }, (_, index) =>
      createMessage(
        `m${index}`,
        `entry ${index}`,
        index,
        grouped ? group.id : undefined,
      ),
    );

    const list = await renderList(grouped ? [group] : [], messages);

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      shown,
    );
    expect(list.shadowRoot?.textContent).not.toContain('entry 0');
    expect(list.shadowRoot?.textContent).toContain(`entry ${total - 1}`);

    const revealButton = list.shadowRoot?.querySelector<HTMLButtonElement>(
      `[data-reveal-kind="${revealKind}"]`,
    );
    expect(revealButton?.dataset.hiddenCount).toBe(hidden);
    // Regression coverage: the reveal control renders as a themed
    // <wa-button>, not a hand-rolled native <button> (see logEntryStyles.ts).
    expect(revealButton?.tagName).toBe('WA-BUTTON');

    revealButton?.click();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      total,
    );
    expect(list.shadowRoot?.textContent).toContain('entry 0');
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

  it('leaves the derived structures alone while terminal mode is on', () => {
    const first = createMessage('m1', 'first', 1);
    const second = createMessage('m2', 'second', 2);
    const list = createList([first]);

    expect(list.index.timeline.map((entry) => entry.key)).toEqual(['m1']);

    list.terminal = true;
    list.messages = [first, second];
    list.willUpdate(
      new Map<string, unknown>([
        ['terminal', false],
        ['messages', [first]],
      ]),
    );

    // Terminal mode renders raw text, so the timeline is not maintained.
    expect(list.index.timeline.map((entry) => entry.key)).toEqual(['m1']);

    list.terminal = false;
    list.willUpdate(new Map<string, unknown>([['terminal', true]]));

    // Leaving terminal mode rebuilds everything the skipped updates missed.
    expect(list.index.timeline.map((entry) => entry.key)).toEqual(['m1', 'm2']);
  });
});

describe('task-group-list orphan re-rooting', () => {
  it('renders a group whose parent is absent as a root, with its subtree and messages', () => {
    const list = createList([]);
    // "run" points at a parent that is NOT in the set — e.g. a cross-trace
    // stage id this stream never recorded. It must still render.
    const run = runGroup('Run: subagent', {
      parentGroupId: 'phantom-orchestrator-stage',
    });
    const init = createGroup('init', STREAM_PHASE.COMPLETED, {
      name: 'Init',
      startTime: 2,
      parentGroupId: 'run',
    });
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
    const run = runGroup('Run: subagent', {
      parentGroupId: 'phantom-orchestrator-stage',
    });
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
  it('formats round group titles with the shared one-based label', async () => {
    const parent = runGroup('Run: reflection');
    const round = createGroup('round-0', STREAM_PHASE.RUNNING, {
      name: 'r0',
      kind: 'round',
      index: 0,
      total: 3,
      startTime: 2,
      parentGroupId: 'run',
    });

    const list = await renderList([parent, round], []);
    const header = groupHeader(list, 'round-0');

    expect(header?.querySelector('.group-title')?.textContent?.trim()).toBe(
      'r1/3',
    );
    expect(header?.querySelector('wa-icon')?.getAttribute('label')).toBe(
      'Running',
    );
  });

  it('renders a distinct icon for completed, cancelled, and failed groups', async () => {
    const parent = runGroup('Run: workflow');
    const groups: TaskGroup[] = [
      parent,
      createGroup('completed-phase', STREAM_PHASE.COMPLETED, {
        name: 'Completed phase',
        startTime: 2,
        parentGroupId: 'run',
      }),
      createGroup('cancelled-phase', STREAM_PHASE.CANCELLED, {
        name: 'Cancelled phase',
        startTime: 3,
        parentGroupId: 'run',
      }),
      createGroup('failed-phase', STREAM_PHASE.FAILED, {
        name: 'Failed phase',
        startTime: 4,
        parentGroupId: 'run',
      }),
    ];

    const list = await renderList(groups, []);

    const iconFor = (groupId: string): string | null =>
      groupHeader(list, groupId)
        ?.querySelector('wa-icon')
        ?.getAttribute('name') ?? null;

    expect(iconFor('completed-phase')).toBe('check');
    expect(iconFor('cancelled-phase')).toBe('circle-stop');
    expect(iconFor('failed-phase')).toBe('circle-exclamation');
  });
});

// #8722 Phase 2b: a focused delegate_multi_agents run projects its phases
// as `kind: 'phase'` groups with per-agent Running/Finished/Failed lines
// beneath. The phase header and call cards are both derived from typed state;
// the renderer does not parse status prefixes from prose.
describe('task-group-list workflow-script phase rendering (#8722)', () => {
  it('renders a phase group with its (i/n) header and call cards beneath', async () => {
    const run = runGroup('Run: workflow');
    const phase = createGroup('phase-review', STREAM_PHASE.RUNNING, {
      name: 'Review',
      startTime: 2,
      parentGroupId: 'run',
      kind: 'phase',
      index: 1,
      total: 3,
    });
    const messages: LogMessageData[] = [
      workflowTaskMessage('phase-review', 'agent-a', 3, {
        id: 'reviewer',
        label: 'Review manuscript',
        phase: 'Review',
        status: 'completed',
        childStreamId: 'reviewer@claude-opus-4#child-1',
        model: 'claude-opus-4',
        durationMs: 12_300,
        totalCostUsd: 0.04,
      }),
      workflowTaskMessage(
        'phase-review',
        'agent-b',
        4,
        {
          id: 'critic',
          label: 'Check argument',
          phase: 'Review',
          status: 'failed',
          error: 'timed out',
          totalCostUsd: 0.01,
        },
        LOG_LEVELS.ERROR,
      ),
      workflowTaskMessage('phase-review', 'agent-c', 5, {
        id: 'deferred',
        label: 'Deferred check',
        phase: 'Review',
        status: 'skipped',
        reason: 'not-reached',
      }),
      workflowTaskMessage('phase-review', 'agent-d', 6, {
        id: 'stopped',
        label: 'Stopped review',
        phase: 'Review',
        status: 'skipped',
        reason: 'user',
        model: 'kimi-k2',
        durationMs: 2_000,
        totalCostUsd: 0.02,
      }),
    ];

    const list = await renderList([run, phase], messages);

    // Header shows the phase label plus the one-based position, matching the
    // CLI's `(index+1/total)` diamond header.
    const header = groupHeader(list, 'phase-review');
    expect(header?.querySelector('.group-title')?.textContent?.trim()).toBe(
      'Review (2/3)',
    );

    // The header also folds its own cards into a completion count. All four
    // are terminal here (completed / failed / skipped x2).
    expect(header?.querySelector('.group-progress')?.textContent?.trim()).toBe(
      '4/4',
    );

    // Each task is one structured card with its status and terminal metadata.
    const content = groupContent(list, 'phase-review');
    expect(content?.textContent).toContain('Review manuscript');
    expect(content?.textContent).toContain('Finished');
    expect(content?.textContent).toContain('claude-opus-4 · 12s · $0.040');
    expect(content?.textContent).toContain('Check argument');
    expect(content?.textContent).toContain('timed out');
    expect(content?.querySelector('.workflow-task--failed')).not.toBeNull();
    const notReached = content?.querySelector('[data-log-id="agent-c"]');
    expect(notReached?.textContent).toContain(
      'The workflow ended before this call was reached.',
    );
    expect(
      notReached?.querySelector('.workflow-task-detail--note'),
    ).not.toBeNull();
    expect(
      notReached?.querySelector('.workflow-task-detail--error'),
    ).toBeNull();
    expect(notReached?.querySelector('.workflow-task-meta')).toBeNull();
    const userSkipped = content?.querySelector('[data-log-id="agent-d"]');
    expect(userSkipped?.textContent).toContain('Stopped review');
    expect(userSkipped?.textContent).toContain('kimi-k2 · 2s · $0.020');
    expect(userSkipped?.querySelector('.workflow-task-detail')).toBeNull();

    const switchedTo: StreamTabId[] = [];
    list.addEventListener('stream-switch', (event) => {
      switchedTo.push(
        (event as CustomEvent<{ streamId: StreamTabId }>).detail.streamId,
      );
    });
    const linkedTask = content?.querySelector<HTMLElement>(
      '[data-log-id="agent-a"]',
    );
    expect(linkedTask?.getAttribute('role')).toBe('button');
    expect(linkedTask?.getAttribute('tabindex')).toBe('0');
    linkedTask?.click();
    linkedTask?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(switchedTo).toEqual([
      'reviewer@claude-opus-4#child-1',
      'reviewer@claude-opus-4#child-1',
    ]);
  });

  it('omits the (i/n) suffix when a phase group carries no counts', async () => {
    const run = runGroup('Run: workflow');
    const phase = createGroup('phase-solo', STREAM_PHASE.RUNNING, {
      name: 'Solo phase',
      startTime: 2,
      parentGroupId: 'run',
      kind: 'phase',
    });

    const list = await renderList([run, phase], []);

    const header = groupHeader(list, 'phase-solo');
    expect(header?.querySelector('.group-title')?.textContent?.trim()).toBe(
      'Solo phase',
    );
    // A phase holding no call cards has nothing to fold.
    expect(header?.querySelector('.group-progress')).toBeNull();
  });

  it('tracks an in-flight phase fold and drops the redundant phase chip', async () => {
    const run = runGroup('Run: workflow');
    const phase = createGroup('phase-map', STREAM_PHASE.RUNNING, {
      name: 'Map',
      startTime: 2,
      parentGroupId: 'run',
      kind: 'phase',
      index: 0,
      total: 3,
    });
    const messages: LogMessageData[] = [
      workflowTaskMessage('phase-map', 'task-a', 3, {
        id: 'seams',
        label: 'Map the seams',
        phase: 'Map',
        status: 'completed',
        durationMs: 72_000,
      }),
      workflowTaskMessage('phase-map', 'task-b', 4, {
        id: 'contracts',
        label: 'Read the contracts',
        phase: 'Map',
        status: 'running',
      }),
      // A malformed row must drop out of the fold rather than throw.
      workflowTaskMessage('phase-map', 'task-bad', 5, {
        id: 'broken',
      } as unknown as WorkflowCallProgress),
    ];

    const list = await renderList([run, phase], messages);

    const header = groupHeader(list, 'phase-map');
    expect(header?.querySelector('.group-progress')?.textContent?.trim()).toBe(
      '1/2',
    );
    expect(header?.querySelector('wa-spinner')).toBeNull();
    expect(header?.querySelector('wa-icon')?.getAttribute('name')).toBe(
      'circle',
    );
    // The enclosing header is the card's one home for its phase.
    const content = groupContent(list, 'phase-map');
    expect(content?.querySelector('.workflow-task-phase')).toBeNull();
    expect(content?.querySelector('.workflow-task-details')).toBeNull();
    expect(content?.querySelector('wa-spinner')).toBeNull();
    expect(
      content
        ?.querySelector('[data-log-id="task-b"] wa-icon')
        ?.getAttribute('name'),
    ).toBe('circle');
    expect(
      content
        ?.querySelector('[data-log-id="task-b"] .workflow-task-status')
        ?.textContent?.trim(),
    ).toBe('Running');
  });
});
