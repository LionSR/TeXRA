// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent utilities
import { PromptBuilder } from '@agent/utils/PromptBuilder';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';
import type {
  AgentPrompt,
  AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';

describe('PromptBuilder', () => {
  const baseSetting: AgentWorkflowSetting = {
    agentType: AgentType.CoT,
    agentCategory: AgentCategory.Workflow,
    documentTag: 'document',
    endTag: '</document>',
    temperature: 0,
    isRewrite: true,
    rounds: 2,
    prefills: [],
    outputExt: 'tex',
    defaultOutputFiles: [],
    requiredFiles: {},
    requiredFilesInternal: {},
    isMultipleOutput: false,
    filePatternsContain: [],
    tools: [],
  } as AgentWorkflowSetting;

  it('uses array-based userRequest entries for reflections', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: 'system',
      userPrefix: 'prefix',
      userRequest: ['initial {{ value }}', 'reflect {{ value }}'],
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, baseSetting, { value: 'test' });
    const initial = await builder.buildInitialPrompts();
    assert.equal(initial.userRequest, 'initial test');

    const reflect = await builder.buildUserRequest(1);
    assert.equal(reflect, 'reflect test');

    const fallback = await builder.buildUserRequest(3);
    assert.equal(fallback, 'reflect test');
  });

  it('handles single string userRequest without reflections', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: 'initial only',
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, baseSetting, {});
    const initial = await builder.buildInitialPrompts();
    assert.equal(initial.userRequest, 'initial only');

    const reflectPrompt = await builder.buildUserRequest(1);
    assert.equal(reflectPrompt, '');
  });
});
