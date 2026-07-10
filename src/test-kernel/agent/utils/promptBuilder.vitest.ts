// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Type imports
import type { AgentPrompt } from '@agent/core/definition/AgentDataclass';
import { buildInitialToolUsePrompts, PromptBuilder } from '@utils/prompt';

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

  it('keeps memory checks relevant and schema-valid', async () => {
    const prompts = await buildInitialToolUsePrompts(
      {
        systemPrompt: 'system',
        userPrefix: '',
        userRequest: 'request',
      } as AgentPrompt,
      {},
      undefined,
      { resolvedToolNames: ['memory'] },
    );

    assert.match(
      prompts.instructionSuffix,
      /For a self-contained request, do not inspect or write memory/,
    );
    assert.match(
      prompts.instructionSuffix,
      /use the `view` command with path `\/memories`/,
    );
    assert.match(
      prompts.instructionSuffix,
      /When memory is relevant, consult pinned memories first/,
    );
    assert.doesNotMatch(
      prompts.instructionSuffix,
      /Always consult pinned memories at session start/,
    );
    assert.match(
      prompts.instructionSuffix,
      /When project context, coding patterns, or conventions are relevant to the task and git is available, look into git history/,
    );
    assert.doesNotMatch(
      prompts.instructionSuffix,
      /^ +- When git is available, look into git history/m,
    );
  });
});
