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

  it('clamps the regular form width to the terminal columns', () => {
    expect(formFrameWidth(120)).toBe(80);
    expect(formFrameWidth(80)).toBe(80);
    expect(formFrameWidth(60)).toBe(60);
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

  it('labels the primary agent section from the visible row kinds', () => {
    expect(agentPickerPrimarySectionTitle([])).toBe('Tool-use agents');
    expect(agentPickerPrimarySectionTitle([{ isOrchestrator: false }])).toBe(
      'Tool-use agents',
    );
    expect(
      agentPickerPrimarySectionTitle([{ isOrchestrator: undefined }]),
    ).toBe('Tool-use agents');
    expect(agentPickerPrimarySectionTitle([{ isOrchestrator: true }])).toBe(
      'Delegating agents',
    );
    expect(
      agentPickerPrimarySectionTitle([
        { isOrchestrator: false },
        { isOrchestrator: true },
      ]),
    ).toBe('Tool-use and delegating agents');
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

  it('shows the full default workflow roster in the normal picker budget', () => {
    expect(
      agentSelectWindow({
        availableRows: 18,
        extraRows: 1,
        itemCount: 5,
        workflowCount: 2,
      }),
    ).toEqual({
      maxVisibleItems: 5,
      showOverflow: false,
      maxVisibleWorkflows: 2,
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
