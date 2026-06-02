import { describe, expect, it } from 'vitest';

import {
  subagentPickerSelection,
  type ChildControlItem,
} from '@cli/chat/tui/state/childControls';

function row(
  over: Partial<Pick<ChildControlItem, 'childStreamId' | 'executionId'>> = {},
): Pick<ChildControlItem, 'childStreamId' | 'executionId'> {
  return {
    executionId: 'exec-1',
    childStreamId: 'reviewer@opus#exec-1',
    ...over,
  };
}

describe('subagentPickerSelection (Enter behavior in the child-control picker)', () => {
  it('opens the scoped transcript viewer for a subagent row backed by a stream', () => {
    expect(subagentPickerSelection('subagents', row())).toEqual({
      kind: 'view',
      streamId: 'reviewer@opus#exec-1',
    });
  });

  it('falls back to the inline detail view when a subagent row has no stream', () => {
    expect(
      subagentPickerSelection('subagents', row({ childStreamId: undefined })),
    ).toEqual({ kind: 'detail', executionId: 'exec-1' });
  });

  it('keeps tasks mode on the inline detail view even with a stream', () => {
    expect(subagentPickerSelection('tasks', row())).toEqual({
      kind: 'detail',
      executionId: 'exec-1',
    });
  });

  it('returns undefined when there is no highlighted row', () => {
    expect(subagentPickerSelection('subagents', undefined)).toBeUndefined();
    expect(subagentPickerSelection('tasks', undefined)).toBeUndefined();
  });
});
