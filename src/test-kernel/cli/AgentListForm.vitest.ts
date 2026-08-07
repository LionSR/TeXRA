import { describe, expect, it } from 'vitest';

import {
  agentPickerPrimarySectionTitle,
  agentSelectWindow,
  currentVisibleAgent,
  hiddenCurrentAgentHint,
} from '@cli/chat/tui/forms/AgentListForm';
import { formFrameWidth } from '@cli/chat/tui/forms/_shared/FormFrame';

describe('CLI AgentListForm row budget', () => {
  const visibleAgents = [
    { value: 'builtInToolUse:chat', label: 'chat' },
    { value: 'remote:lean', label: 'lean' },
  ];

  it.each([
    [120, 80],
    [80, 80],
    [60, 60],
  ])(
    'clamps the regular form width %i to the terminal columns',
    (columns, expected) => {
      expect(formFrameWidth(columns)).toBe(expected);
    },
  );

  it('resolves the current visible agent from bare names or canonical keys', () => {
    expect(currentVisibleAgent(visibleAgents, 'chat')?.label).toBe('chat');
    expect(currentVisibleAgent(visibleAgents, 'remote:lean')?.label).toBe(
      'lean',
    );
    expect(
      currentVisibleAgent(visibleAgents, 'builtInToolUse:lean')?.label,
    ).toBe('lean');
  });

  it('resolves current agents by canonical names and values', () => {
    const canonicalAgents = [
      { value: 'remote:review', label: 'review' },
      { value: 'remote:leanOrchestrator', label: 'leanOrchestrator' },
    ];

    const reviewAgent = currentVisibleAgent(canonicalAgents, 'review');

    expect(reviewAgent?.label).toBe('review');
    expect(reviewAgent?.value).toBe('remote:review');
    expect(
      currentVisibleAgent(canonicalAgents, 'leanOrchestrator')?.label,
    ).toBe('leanOrchestrator');
    expect(hiddenCurrentAgentHint(canonicalAgents, 'review')).toBeUndefined();
  });

  it('does not match arbitrary labels when canonical names differ', () => {
    const agentsWithReadableLabel = [
      {
        value: 'remote:review',
        label: 'Readable review label',
      },
    ];

    expect(
      currentVisibleAgent(agentsWithReadableLabel, 'Readable review label'),
    ).toBeUndefined();
    expect(currentVisibleAgent(agentsWithReadableLabel, 'review')?.value).toBe(
      'remote:review',
    );
    expect(
      hiddenCurrentAgentHint(agentsWithReadableLabel, 'Readable review label'),
    ).toBe('Current: Readable review label (hidden from picker)');
  });

  it('labels the current agent when it is hidden from the picker', () => {
    expect(hiddenCurrentAgentHint(visibleAgents, 'builtInToolUse:review')).toBe(
      'Current: review (hidden from picker)',
    );
    expect(hiddenCurrentAgentHint(visibleAgents, 'chat')).toBeUndefined();
  });

  it.each([
    { rows: [], expected: 'Tool-use agents' },
    { rows: [{ isOrchestrator: false }], expected: 'Tool-use agents' },
    { rows: [{ isOrchestrator: undefined }], expected: 'Tool-use agents' },
    { rows: [{ isOrchestrator: true }], expected: 'Delegating agents' },
    {
      rows: [{ isOrchestrator: false }, { isOrchestrator: true }],
      expected: 'Tool-use and delegating agents',
    },
  ])(
    'labels the primary agent section "$expected" from the visible row kinds',
    ({ rows, expected }) => {
      expect(agentPickerPrimarySectionTitle(rows)).toBe(expected);
    },
  );

  it.each([
    {
      name: 'windows long agent lists inside the available foreground rows',
      input: { availableRows: 12, itemCount: 12, workflowCount: 10 },
      expected: {
        maxVisibleItems: 2,
        showOverflow: true,
        maxVisibleWorkflows: 0,
        showWorkflowOverflow: false,
      },
    },
    {
      name: 'accounts for the hidden-current hint in the row budget',
      input: {
        availableRows: 12,
        extraRows: 1,
        itemCount: 12,
        workflowCount: 10,
      },
      expected: {
        maxVisibleItems: 1,
        showOverflow: true,
        maxVisibleWorkflows: 0,
        showWorkflowOverflow: false,
      },
    },
    {
      name: 'shows the full default workflow roster in the normal picker budget',
      input: {
        availableRows: 18,
        extraRows: 1,
        itemCount: 5,
        workflowCount: 2,
      },
      expected: {
        maxVisibleItems: 5,
        showOverflow: false,
        maxVisibleWorkflows: 2,
        showWorkflowOverflow: false,
      },
    },
    {
      name: 'shows workflows only when the row budget has room for them',
      input: { availableRows: 24, itemCount: 6, workflowCount: 3 },
      expected: {
        maxVisibleItems: 6,
        showOverflow: false,
        maxVisibleWorkflows: 3,
        showWorkflowOverflow: false,
      },
    },
  ])('$name', ({ input, expected }) => {
    expect(agentSelectWindow(input)).toEqual(expected);
  });
});
