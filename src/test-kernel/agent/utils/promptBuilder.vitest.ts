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
      /do not inspect or write unpinned memory/,
    );
    assert.match(
      prompts.instructionSuffix,
      /use the `view` command with path `\/memories`/,
    );
  });

  it('keeps pinned-memory consultation unconditional even for self-contained requests', async () => {
    // Regression test for #7957: relevance gating (added in #7855) must not
    // silently drop pinned memories, which are documented as loading every
    // session (docs/guide/memory.md, MemoryTool's description).
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
      /Always consult pinned memories at session start, even for requests that otherwise look self-contained/,
    );
    assert.match(
      prompts.instructionSuffix,
      /Pinned memories are always loaded: use the `view` command with path `\/memories` at session start regardless of how self-contained the request looks/,
    );
    assert.doesNotMatch(
      prompts.instructionSuffix,
      /When memory is relevant, consult pinned memories first/,
    );
  });
});
