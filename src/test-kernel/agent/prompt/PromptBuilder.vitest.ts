import { describe, expect, it } from 'vitest';

import type { AgentPrompt } from '@agent/core/definition/AgentDataclass';
import {
  buildInitialToolUsePrompts,
  PromptBuilder,
} from '@agent/prompt/PromptBuilder';

function buildMemoryPrompts(): ReturnType<typeof buildInitialToolUsePrompts> {
  return buildInitialToolUsePrompts(
    {
      systemPrompt: 'system',
      userPrefix: '',
      userRequest: 'request',
    } as AgentPrompt,
    {},
    undefined,
    { resolvedToolNames: ['memory'] },
  );
}

describe('PromptBuilder', () => {
  it('uses array-based userRequest entries for reflections', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: 'system',
      userPrefix: 'prefix',
      userRequest: ['initial {{ value }}', 'reflect {{ value }}'],
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, { value: 'test' });
    const initial = await builder.buildInitialPrompts();
    expect(initial.userRequest).toBe('initial test');

    const reflect = await builder.buildUserRequest(1);
    expect(reflect).toBe('reflect test');

    const fallback = await builder.buildUserRequest(3);
    expect(fallback).toBe('reflect test');
  });

  it('handles single string userRequest by reusing for subsequent rounds', async () => {
    const prompt: AgentPrompt = {
      systemPrompt: '',
      userPrefix: '',
      userRequest: 'initial only',
    } as AgentPrompt;

    const builder = new PromptBuilder(prompt, {});
    const initial = await builder.buildInitialPrompts();
    expect(initial.userRequest).toBe('initial only');

    // Single-template agents reuse the template for subsequent rounds
    const reflectPrompt = await builder.buildUserRequest(1);
    expect(reflectPrompt).toBe('initial only');
  });

  it('keeps memory checks relevant and points view at the memory root', async () => {
    const prompts = await buildMemoryPrompts();

    expect(prompts.instructionSuffix).toMatch(
      /do not read unpinned memory files or write memory/,
    );
    expect(prompts.instructionSuffix).toMatch(/`view`[^`\n]*`\/memories`/);
  });

  it.each([
    {
      isAnthropic: true,
      includedBranch: 'Independent tool calls may be issued together',
      excludedBranch: 'Always produce valid JSON when calling a tool',
    },
    {
      isAnthropic: false,
      includedBranch: 'Always produce valid JSON when calling a tool',
      excludedBranch: 'Independent tool calls may be issued together',
    },
  ])(
    'keeps authored instructions free of em dashes for Anthropic=$isAnthropic',
    async ({ isAnthropic, includedBranch, excludedBranch }) => {
      const sentinels = {
        cwd: 'cwd \u2014 content',
        bibliography: 'bibliography \u2014 content',
        skills: 'skills \u2014 content',
        user: 'user \u2014 content',
        attachedMemory: 'attached memory \u2014 content',
      };
      const prompts = await buildInitialToolUsePrompts(
        {
          systemPrompt: 'system {{ USER_CONTENT }}',
          userPrefix: 'prefix {{ USER_CONTENT }}',
          userRequest: 'request {{ USER_CONTENT }}',
        } as AgentPrompt,
        {
          IS_ANTHROPIC_MODEL: isAnthropic,
          CWD: sentinels.cwd,
          DEFAULT_BIB_PATH: sentinels.bibliography,
          AVAILABLE_SKILLS: sentinels.skills,
          USER_CONTENT: sentinels.user,
          ATTACHED_MEMORIES: sentinels.attachedMemory,
        },
        undefined,
        {
          resolvedToolNames: ['memory'],
          hasDelegationTools: true,
        },
      );
      const instructionsWithoutWorkspace = prompts.instructionSuffix.split(
        '<workspace_info>',
        1,
      )[0];

      expect(prompts.systemPrompt).toContain(sentinels.user);
      expect(prompts.systemPrompt).toContain(sentinels.attachedMemory);
      expect(prompts.userPrefix).toContain(sentinels.user);
      expect(prompts.userRequest).toContain(sentinels.user);
      expect(instructionsWithoutWorkspace).toContain(sentinels.cwd);
      expect(instructionsWithoutWorkspace).toContain(sentinels.bibliography);
      expect(instructionsWithoutWorkspace).toContain(sentinels.skills);
      expect(instructionsWithoutWorkspace).toContain(includedBranch);
      expect(instructionsWithoutWorkspace).not.toContain(excludedBranch);
      expect(instructionsWithoutWorkspace).toContain(
        '<orchestrator_memory_protocol>',
      );

      const authoredInstructions = [
        sentinels.cwd,
        sentinels.bibliography,
        sentinels.skills,
      ].reduce(
        (instructions, sentinel) => instructions.replaceAll(sentinel, ''),
        instructionsWithoutWorkspace,
      );
      expect(authoredInstructions).not.toContain('\u2014');
    },
  );

  it('keeps pinned-memory consultation unconditional even for self-contained requests', async () => {
    // Regression test for #7957: relevance gating (added in #7855) must not
    // silently drop pinned memories, which are documented as loading every
    // session (docs/guide/memory.md, MemoryTool's description).
    const prompts = await buildMemoryPrompts();

    // Behavioral contract, not exact prose (review note on #7959): pinned
    // files must be individually viewed at session start — a directory
    // listing alone does not load their content — and this must hold even
    // for self-contained-looking requests.
    expect(prompts.instructionSuffix).toMatch(
      /Pinned memories are always loaded/,
    );
    expect(prompts.instructionSuffix).toMatch(
      /`view` each \[pinned\] file|`view` each pinned file|read each pinned memory file/,
    );
    expect(prompts.instructionSuffix).toMatch(
      /regardless of how self-contained|even for requests that otherwise look self-contained/,
    );
    expect(prompts.instructionSuffix).not.toMatch(
      /When memory is relevant, consult pinned memories first/,
    );
    expect(prompts.instructionSuffix).toMatch(
      /When project context, coding patterns, or conventions are relevant to the task and git is available, look into git history/,
    );
    expect(prompts.instructionSuffix).not.toMatch(
      /^ +- When git is available, look into git history/m,
    );
  });
});
