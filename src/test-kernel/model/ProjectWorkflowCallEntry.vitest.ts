import { describe, expect, it } from 'vitest';

import {
  projectWorkflowCallEntries,
  projectWorkflowCallEntry,
} from '@model/projectWorkflowCallEntry';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type StreamLogEntry,
} from '@shared/schemas';

function workflowCallEntry(model: string): StreamLogEntry {
  return {
    seqNo: 1,
    id: 'workflow-call-1',
    type: STREAM_LOG_ENTRY_TYPES.LOG,
    level: LOG_LEVELS.INFO,
    timestamp: 100,
    messageType: MESSAGE_TYPES.WORKFLOW_TASK,
    text: 'Summarize',
    data: {
      id: 'call-1',
      label: 'Summarize',
      status: 'completed',
      model,
    },
  };
}

describe('projectWorkflowCallEntry', () => {
  it('projects a workflow-call canonical model id to its runtime label', () => {
    const projected = projectWorkflowCallEntry(workflowCallEntry('gpt56-'));

    expect(projected.data).toMatchObject({ model: 'GPT-5.6 Terra' });
  });

  it('leaves non-workflow entries untouched', () => {
    const entry: StreamLogEntry = {
      seqNo: 1,
      id: 'entry-1',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 100,
      messageType: MESSAGE_TYPES.DEFAULT,
      text: 'hello',
      data: { model: 'gpt56-' },
    };

    expect(projectWorkflowCallEntry(entry)).toBe(entry);
  });
});

describe('projectWorkflowCallEntries', () => {
  it('projects every entry in a range', () => {
    const projected = projectWorkflowCallEntries([
      workflowCallEntry('gpt56-'),
      {
        seqNo: 2,
        id: 'other',
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        level: LOG_LEVELS.INFO,
        timestamp: 200,
        messageType: MESSAGE_TYPES.DEFAULT,
        text: 'other',
      },
    ]);

    expect(projected[0].data).toMatchObject({ model: 'GPT-5.6 Terra' });
    expect(projected[1].id).toBe('other');
  });
});
