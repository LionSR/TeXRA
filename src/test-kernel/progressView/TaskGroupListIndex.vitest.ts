// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progressView frontend
import type {
  GroupTree,
  MessageIndex,
  TimelineEntry,
} from '@progressView/frontend/components/messageIndex';

// Local imports - shared schemas
import {
  LOG_LEVELS,
  STREAM_STATUS,
  type LogMessageData,
  type TaskGroup,
} from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

type TaskGroupListInternals = HTMLElement & {
  groups: TaskGroup[];
  messages: LogMessageData[];
  hasStreams: boolean;
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
  status: typeof STREAM_STATUS.RUNNING | typeof STREAM_STATUS.STOPPED,
): TaskGroup {
  return {
    id,
    name: id,
    startTime: 1,
    status,
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
    const group = createGroup('g1', STREAM_STATUS.RUNNING);
    const message = createMessage('m1', 'grouped', 2, group.id);
    const list = createList([message]);
    list.groups = [group];
    list.index.rebuildTree([group], [message]);
    list.index.rebuildTimeline();

    const originalTree: GroupTree | undefined = list.index.tree[0];
    const stoppedGroup = {
      ...group,
      status: STREAM_STATUS.STOPPED,
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

    revealButton?.click();
    await list.updateComplete;

    expect(list.shadowRoot?.querySelectorAll('[data-log-id]')).toHaveLength(
      130,
    );
    expect(list.shadowRoot?.textContent).toContain('entry 0');
  });

  it('bounds rendered message DOM inside large groups', async () => {
    const group = createGroup('g1', STREAM_STATUS.RUNNING);
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
    const group = createGroup('g1', STREAM_STATUS.RUNNING);
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
