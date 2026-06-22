import { describe, expect, it } from 'vitest';

import {
  agentDescription,
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

  it('resolves current agents by value name when rows use display labels', () => {
    const displayAgents = [
      { value: 'builtInToolUse:setup', label: 'Setup assistant' },
      { value: 'remote:orchestrator', label: 'Orchestrator' },
    ];

    const setupAgent = currentVisibleAgent(displayAgents, 'setup');

    expect(setupAgent?.label).toBe('Setup assistant');
    expect(setupAgent?.value).toBe('builtInToolUse:setup');
    expect(
      currentVisibleAgent(displayAgents, 'remote:orchestrator')?.label,
    ).toBe('Orchestrator');
    expect(hiddenCurrentAgentHint(displayAgents, 'setup')).toBeUndefined();
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

  it('omits default role/source noise from agent descriptions', () => {
    expect(
      agentDescription({
        value: 'builtInToolUse:research',
        label: 'Research',
        isToolUse: true,
        description: 'derivations and numerics',
      }),
    ).toBe('derivations and numerics');
    expect(
      agentDescription({
        value: 'builtInWorkflow:correct',
        label: 'correct',
        description: 'revise the manuscript',
      }),
    ).toBe('revise the manuscript');
  });

  it('keeps only distinguishing agent metadata in descriptions', () => {
    expect(
      agentDescription({
        value: 'remote:orchestrator',
        label: 'orchestrator',
        isRemote: true,
        isOrchestrator: true,
        description: 'plan and delegate tasks',
      }),
    ).toBe('delegating; remote; plan and delegate tasks');
    expect(
      agentDescription({
        value: 'custom:reviewer',
        label: 'reviewer',
        isCustom: true,
      }),
    ).toBe('custom');
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
