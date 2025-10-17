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
      userReflect: '',
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, baseSetting, { value: 'test' });
    const initial = await builder.buildInitialPrompts();
    assert.equal(initial.userRequest, 'initial test');

    const reflect = await builder.buildReflectPrompt(1);
    assert.equal(reflect, 'reflect test');

    const fallback = await builder.buildReflectPrompt(3);
    assert.equal(fallback, 'reflect test');
  });

  it('falls back to legacy userReflect prompts', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: 'initial only',
      userReflect: ['reflect one', 'reflect two'],
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, baseSetting, {});
    const reflectOne = await builder.buildReflectPrompt(1);
    assert.equal(reflectOne, 'reflect one');

    const reflectTwo = await builder.buildReflectPrompt(2);
    assert.equal(reflectTwo, 'reflect two');

    const fallback = await builder.buildReflectPrompt(3);
    assert.equal(fallback, 'reflect one');
  });

  it('skips empty templates when selecting initial request and reflections', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: ['', '   ', 'primary', '', 'follow-up'],
      userReflect: '',
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, baseSetting, {});
    const initial = await builder.buildInitialPrompts();
    assert.equal(initial.userRequest, 'primary');

    const reflect = await builder.buildReflectPrompt(1);
    assert.equal(reflect, 'follow-up');

    const fallback = await builder.buildReflectPrompt(2);
    assert.equal(fallback, 'follow-up');
  });
});
