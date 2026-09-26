import { describe, expect, it } from 'vitest';

import {
  AgentDefinitionSchema,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import { AgentCategory } from '@shared/schemas';

describe('AgentDefinitionSchema', () => {
  it('preserves inherited defaults until the post-merge final parse', () => {
    const parentSettings = AgentSettingSchema.parse({
      agentCategory: AgentCategory.Workflow,
      rounds: 5,
      tools: [{ name: 'grep' }],
    });
    const parentPrompts = AgentPromptSchema.parse({
      systemPrompt: 'You are careful.',
      userRequest: 'Parent request',
    });
    const child = AgentDefinitionSchema.parse({
      name: 'child',
      inherits: 'parent',
      prompts: {
        userRequest: 'Child request',
      },
    });

    const settings = AgentSettingSchema.parse(
      mergeInheritedAgentObject(parentSettings, child.settings),
    );
    const prompts = AgentPromptSchema.parse(
      mergeInheritedAgentObject(parentPrompts, child.prompts),
    );

    expect(settings.agentCategory).toBe(AgentCategory.Workflow);
    if (settings.agentCategory !== AgentCategory.Workflow) {
      throw new Error('expected workflow settings');
    }
    expect(settings.rounds).toBe(5);
    expect(settings.tools).toEqual([{ name: 'grep' }]);
    expect(prompts.systemPrompt).toBe('You are careful.');
    expect(prompts.userRequest).toBe('Child request');
  });
});
