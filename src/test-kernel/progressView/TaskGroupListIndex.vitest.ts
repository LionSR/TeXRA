// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import {
  LOG_LEVELS,
  STREAM_STATUS,
  type LogMessageData,
  type TaskGroup,
} from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

type TimelineEntry =
  | { key: string; time: number; msg: LogMessageData }
  | { key: string; time: number; tree: GroupTreeForTest };

interface GroupTreeForTest {
  group: TaskGroup;
  children: GroupTreeForTest[];
  messages: LogMessageData[];
}

type TaskGroupListInternals = HTMLElement & {
  groups: TaskGroup[];
  messages: LogMessageData[];
  cachedTree: GroupTreeForTest[];
  cachedUngrouped: LogMessageData[];
  cachedTimeline: TimelineEntry[];
  ungroupedMessageById: Map<string, LogMessageData>;
  ungroupedMessageIndex: Map<string, number>;
  buildGroupTree: () => [GroupTreeForTest[], LogMessageData[]];
  buildFullTimeline: () => TimelineEntry[];
  replaceSingleMessage: (message: LogMessageData) => void;
  updateTimelineMessageRefs: () => void;
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
  [element.cachedTree, element.cachedUngrouped] = element.buildGroupTree();
  element.cachedTimeline = element.buildFullTimeline();
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

    list.replaceSingleMessage(updated);

    expect(list.cachedUngrouped[1]).toBe(updated);
    expect(list.ungroupedMessageById.get('m2')).toBe(updated);
    expect(list.ungroupedMessageIndex.get('m2')).toBe(1);

    const timelineEntry = list.cachedTimeline.find(
      (entry): entry is Extract<TimelineEntry, { msg: LogMessageData }> =>
        entry.key === 'm2' && 'msg' in entry,
    );
    expect(timelineEntry?.msg).toBe(original[1]);

    list.cachedUngrouped = new Proxy(list.cachedUngrouped, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          throw new Error('unexpected ungrouped array scan');
        }
        return Reflect.get(target, property, receiver);
      },
    }) as LogMessageData[];

    list.updateTimelineMessageRefs();

    expect(timelineEntry?.msg).toBe(updated);
  });

  it('patches stable group metadata without rebuilding the message tree', () => {
    const group = createGroup('g1', STREAM_STATUS.RUNNING);
    const message = createMessage('m1', 'grouped', 2, group.id);
    const list = createList([message]);
    list.groups = [group];
    [list.cachedTree, list.cachedUngrouped] = list.buildGroupTree();
    list.cachedTimeline = list.buildFullTimeline();

    const originalTree = list.cachedTree[0];
    const stoppedGroup = {
      ...group,
      status: STREAM_STATUS.STOPPED,
      endTime: 3,
    };
    list.groups = [stoppedGroup];
    list.buildGroupTree = () => {
      throw new Error('unexpected full group tree rebuild');
    };
    list.updateTimelineMessageRefs = () => {
      throw new Error('unexpected timeline message scan');
    };

    list.willUpdate(new Map([['groups', [group]]]));

    expect(list.cachedTree[0]).toBe(originalTree);
    expect(list.cachedTree[0]?.group).toBe(stoppedGroup);
    expect(list.cachedTree[0]?.messages).toEqual([message]);
    expect(list.cachedTimeline).toHaveLength(1);
  });
});
