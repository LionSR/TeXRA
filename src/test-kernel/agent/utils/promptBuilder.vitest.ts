// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Type imports
import type { AgentPrompt } from '@agent/core/definition/AgentDataclass';
import { PromptBuilder } from '@utils/prompt';

describe('PromptBuilder', () => {
  it('uses array-based userRequest entries for reflections', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: 'system',
      userPrefix: 'prefix',
      userRequest: ['initial {{ value }}', 'reflect {{ value }}'],
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, { value: 'test' });
    const initial = await builder.buildInitialPrompts();
    assert.equal(initial.userRequest, 'initial test');

    const reflect = await builder.buildUserRequest(1);
    assert.equal(reflect, 'reflect test');

    const fallback = await builder.buildUserRequest(3);
    assert.equal(fallback, 'reflect test');
  });

  it('handles single string userRequest by reusing for subsequent rounds', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: 'initial only',
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, {});
    const initial = await builder.buildInitialPrompts();
    assert.equal(initial.userRequest, 'initial only');

    // Single-template agents reuse the template for subsequent rounds
    const reflectPrompt = await builder.buildUserRequest(1);
    assert.equal(reflectPrompt, 'initial only');
  });
});
