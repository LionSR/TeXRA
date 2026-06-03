import { describe, expect, it } from 'vitest';

import {
  agentFormWidth,
  agentSelectWindow,
  currentVisibleAgent,
  hiddenCurrentAgentHint,
} from '@cli/chat/tui/forms/AgentListForm';

describe('CLI AgentListForm row budget', () => {
  const visibleAgents = [
    { value: 'builtInToolUse:chat', label: 'chat' },
    { value: 'remote:lean', label: 'lean' },
  ];

  it('clamps the regular form width to the terminal columns', () => {
    expect(agentFormWidth(120)).toBe(80);
    expect(agentFormWidth(80)).toBe(80);
    expect(agentFormWidth(60)).toBe(60);
  });

  it('resolves the current visible agent from bare names or canonical keys', () => {
    expect(currentVisibleAgent(visibleAgents, 'chat')?.label).toBe('chat');
    expect(currentVisibleAgent(visibleAgents, 'remote:lean')?.label).toBe(
      'lean',
    );
    expect(
      currentVisibleAgent(visibleAgents, 'builtInToolUse:lean')?.label,
    ).toBe('lean');
  });

  it('labels the current agent when it is hidden from the picker', () => {
    expect(hiddenCurrentAgentHint(visibleAgents, 'builtInToolUse:review')).toBe(
      'Current: review (hidden from picker)',
    );
    expect(hiddenCurrentAgentHint(visibleAgents, 'chat')).toBeUndefined();
  });

  it('windows long agent lists inside the available foreground rows', () => {
    expect(
      agentSelectWindow({
        availableRows: 12,
        itemCount: 12,
        workflowCount: 10,
      }),
    ).toEqual({
      maxVisibleItems: 2,
      showOverflow: true,
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    });
  });

  it('accounts for the hidden-current hint in the row budget', () => {
    expect(
      agentSelectWindow({
        availableRows: 12,
        extraRows: 1,
        itemCount: 12,
        workflowCount: 10,
      }),
    ).toEqual({
      maxVisibleItems: 1,
      showOverflow: true,
      maxVisibleWorkflows: 0,
      showWorkflowOverflow: false,
    });
  });

  it('shows workflows only when the row budget has room for them', () => {
    expect(
      agentSelectWindow({
        availableRows: 24,
        itemCount: 6,
        workflowCount: 3,
      }),
    ).toEqual({
      maxVisibleItems: 6,
      showOverflow: false,
      maxVisibleWorkflows: 3,
      showWorkflowOverflow: false,
    });
  });
});
