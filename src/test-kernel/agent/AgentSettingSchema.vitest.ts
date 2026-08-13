import { describe, expect, it } from 'vitest';

import {
  AgentDefinitionSchema,
  AgentPromptSchema,
  AgentSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import { AgentCategory } from '@shared/schemas';

describe('AgentDefinitionSchema', () => {
  it('keeps inherited child settings and prompts partial before merging', () => {
    const result = AgentDefinitionSchema.parse({
      name: 'child',
      inherits: 'parent',
      settings: {
        tools: ['grep'],
      },
      prompts: {
        userRequest: 'Do the thing',
      },
    });

    expect(result.settings).toEqual({ tools: ['grep'] });
    expect(Object.hasOwn(result.settings, 'rounds')).toBe(false);
    expect(Object.hasOwn(result.settings, 'agentCategory')).toBe(false);
    expect(result.prompts).toEqual({ userRequest: 'Do the thing' });
    expect(Object.hasOwn(result.prompts, 'systemPrompt')).toBe(false);
  });

  it('accepts inherited children that omit settings and prompts blocks', () => {
    const result = AgentDefinitionSchema.parse({
      name: 'child',
      inherits: 'parent',
    });

    expect(result.settings).toEqual({});
    expect(result.prompts).toEqual({});
  });

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

  it('rejects unknown top-level metadata', () => {
    const result = AgentDefinitionSchema.safeParse({
      name: 'assistant',
      title: 'Assistant',
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error('unknown metadata should not be valid');
    }
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['title'],
      }),
    ]);
  });

  it('rejects names that are not identifiers', () => {
    expect(() =>
      AgentDefinitionSchema.parse({
        name: 'review team',
      }),
    ).toThrow('Agent names must be identifiers');
  });
});
