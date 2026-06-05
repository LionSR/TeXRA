import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  buildInitialChatAgentConfig,
  restorePendingSkillActivations,
  takePendingSkillActivations,
} from '@cli/chat/tui/runChatTui';

describe('CLI chat run config', () => {
  it('tags preset-launched team chats with the multi-agent preset id', () => {
    expect(
      buildInitialChatAgentConfig({
        agent: 'orchestrator',
        model: 'deepseekT',
        instruction: 'prove the bounded case',
        workingDirectory: '/tmp/project',
        cliMultiAgentPresetId: 'physicist',
      }),
    ).toMatchObject({
      agent: 'orchestrator',
      model: 'deepseekT',
      instruction: 'prove the bounded case',
      workingDirectory: '/tmp/project',
      agentCategory: AgentCategory.ToolUse,
      cliMultiAgentPresetId: 'physicist',
    });
  });

  it('does not tag ordinary chats as multi-agent preset runs', () => {
    expect(
      buildInitialChatAgentConfig({
        agent: 'chat',
        model: 'deepseekT',
        instruction: 'hello',
        workingDirectory: '/tmp/project',
      }),
    ).not.toHaveProperty('cliMultiAgentPresetId');
  });

  it('preserves display instruction separately from model instruction', () => {
    expect(
      buildInitialChatAgentConfig({
        agent: 'chat',
        model: 'deepseekT',
        instruction: '<skill_activation>hidden</skill_activation>',
        displayInstruction: 'summarize this proof',
        workingDirectory: '/tmp/project',
      }),
    ).toMatchObject({
      instruction: '<skill_activation>hidden</skill_activation>',
      displayInstruction: 'summarize this proof',
    });
  });

  it('preserves an empty display instruction instead of dropping it', () => {
    expect(
      buildInitialChatAgentConfig({
        agent: 'chat',
        model: 'deepseekT',
        instruction: '<skill_activation>hidden</skill_activation>',
        displayInstruction: '',
        workingDirectory: '/tmp/project',
      }),
    ).toMatchObject({
      instruction: '<skill_activation>hidden</skill_activation>',
      displayInstruction: '',
    });
  });

  it('reserves pending skill activations for only one prepared message', () => {
    const pending = new Map([
      ['proof-audit', '<skill_activation>proof</skill_activation>'],
    ]);

    const first = takePendingSkillActivations(pending, 'first request');
    const second = takePendingSkillActivations(pending, 'second request');

    expect(first).toMatchObject({
      displayInstruction: 'first request',
      reservedSkillActivations: [
        {
          name: 'proof-audit',
          activationPrompt: '<skill_activation>proof</skill_activation>',
        },
      ],
    });
    expect(first.instruction).toContain(
      '<skill_activation>proof</skill_activation>',
    );
    expect(first.instruction).toContain(
      '<user_request>\nfirst request\n</user_request>',
    );
    expect(second).toEqual({
      instruction: 'second request',
      reservedSkillActivations: [],
    });
  });

  it('restores reserved skill activations without replacing newer selections', () => {
    const pending = new Map([
      ['proof-audit', '<skill_activation>old</skill_activation>'],
    ]);
    const reserved = takePendingSkillActivations(
      pending,
      'first request',
    ).reservedSkillActivations;

    restorePendingSkillActivations(pending, reserved);
    expect(pending.get('proof-audit')).toBe(
      '<skill_activation>old</skill_activation>',
    );

    pending.clear();
    pending.set('proof-audit', '<skill_activation>new</skill_activation>');
    restorePendingSkillActivations(pending, reserved);

    expect(pending.get('proof-audit')).toBe(
      '<skill_activation>new</skill_activation>',
    );
  });

  it('escapes user request text inside skill activation wrappers', () => {
    const pending = new Map([
      ['proof-audit', '<skill_activation>proof</skill_activation>'],
    ]);

    const prepared = takePendingSkillActivations(pending, 'compare A < B & C');

    expect(prepared.displayInstruction).toBe('compare A < B & C');
    expect(prepared.instruction).toContain(
      '<user_request>\ncompare A &lt; B &amp; C\n</user_request>',
    );
  });
});
