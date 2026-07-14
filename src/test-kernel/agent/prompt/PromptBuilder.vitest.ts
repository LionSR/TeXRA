// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Type imports
import { buildInitialToolUsePrompts, PromptBuilder } from '@agent/prompt';
import type { AgentPrompt } from '@agent/core/definition/AgentDataclass';

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

  it('keeps memory checks relevant and points view at the memory root', async () => {
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
      /do not read unpinned memory files or write memory/,
    );
    assert.match(prompts.instructionSuffix, /`view`[^`\n]*`\/memories`/);
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

    // Behavioral contract, not exact prose (review note on #7959): pinned
    // files must be individually viewed at session start — a directory
    // listing alone does not load their content — and this must hold even
    // for self-contained-looking requests.
    assert.match(
      prompts.instructionSuffix,
      /Pinned memories are always loaded/,
    );
    assert.match(
      prompts.instructionSuffix,
      /`view` each \[pinned\] file|`view` each pinned file|read each pinned memory file/,
    );
    assert.match(
      prompts.instructionSuffix,
      /regardless of how self-contained|even for requests that otherwise look self-contained/,
    );
    assert.doesNotMatch(
      prompts.instructionSuffix,
      /When memory is relevant, consult pinned memories first/,
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
