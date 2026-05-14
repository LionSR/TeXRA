// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import {
  LOG_LEVELS,
  type LogMessageData,
  type TaskGroup,
} from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

type TimelineEntry =
  | { key: string; time: number; msg: LogMessageData }
  | { key: string; time: number; tree: unknown };

type TaskGroupListInternals = HTMLElement & {
  groups: TaskGroup[];
  messages: LogMessageData[];
  cachedTree: unknown[];
  cachedUngrouped: LogMessageData[];
  cachedTimeline: TimelineEntry[];
  ungroupedMessageById: Map<string, LogMessageData>;
  ungroupedMessageIndex: Map<string, number>;
  buildGroupTree: () => [unknown[], LogMessageData[]];
  buildFullTimeline: () => TimelineEntry[];
  replaceSingleMessage: (message: LogMessageData) => void;
  updateTimelineMessageRefs: () => void;
};

useLitComponentTestDom(
  () => import('@progressView/frontend/components/TaskGroupList'),
);

function createMessage(
  id: string,
  text: string,
  timestamp: number,
): LogMessageData {
  return {
    id,
    text,
    timestamp,
    level: LOG_LEVELS.INFO,
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
});
