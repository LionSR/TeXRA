import { describe, expect, it } from 'vitest';
import { Effect } from 'effect';
import { MODEL_CONFIGS } from 'llm-zoo';

import { resolveChatDefaults } from '@cli/runtime/chatDefaults';
import { CLI_CHEAP_START_MODEL } from '@cli/runtime/cliConfig';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { FakeConfigProvider } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

type ChatDefaultsInit = Omit<
  Parameters<typeof resolveChatDefaults>[0],
  'stores'
>;

/**
 * Installs a host whose workspace roots read `workspace` as the project
 * `.texra/config.json` layer and `user` as the shared user-level file — the
 * two layers `JsonConfigProvider` merges for the real CLI.
 */
async function withConfig(layers: {
  readonly workspace?: Record<string, unknown>;
  readonly user?: Record<string, unknown>;
}): Promise<void> {
  const config = new FakeConfigProvider(layers.workspace ?? {});
  for (const [key, value] of Object.entries(layers.user ?? {})) {
    await Effect.runPromise(config.update(key, value, 'global'));
  }
  await installPlatform({}, { config });
}

async function expectChatDefaults(
  init: ChatDefaultsInit,
  expected: Record<string, unknown>,
): Promise<void> {
  expect(
    resolveChatDefaults({ ...init, stores: testWorkspaceRoots() }),
  ).toMatchObject(expected);
}

describe('CLI chat defaults', () => {
  it('uses assistant and the cheap-start model as the built-in defaults', async () => {
    expect(MODEL_CONFIGS[CLI_CHEAP_START_MODEL]).toBeDefined();
    await withConfig({});

    await expectChatDefaults(
      {},
      {
        agent: 'assistant',
        model: CLI_CHEAP_START_MODEL,
        modelSource: 'builtin-default',
      },
    );
  });

  it('uses the first visible tool-use agent when assistant is hidden by the workspace agents', async () => {
    await withConfig({});

    await expectChatDefaults(
      { visibleToolUseAgents: [{ name: 'research' }, { name: 'review' }] },
      { agent: 'research', model: CLI_CHEAP_START_MODEL },
    );
  });

  it('prefers the chat section over the top-level rows', async () => {
    await withConfig({
      workspace: {
        'texra.agent': 'generic',
        'texra.model': 'openai/gpt-5.5-2026-04-23',
        'texra.chat': {
          agent: 'assistant',
          model: 'deepseek/deepseek-v4-flash',
        },
      },
    });

    await expectChatDefaults(
      {},
      {
        agent: 'assistant',
        model: 'deepseek/deepseek-v4-flash',
        modelSource: 'workspace-config',
      },
    );
  });

  it('falls through to the user layer per field', async () => {
    await withConfig({
      user: {
        'texra.agent': 'assistant',
        'texra.chat': { model: 'deepseek/deepseek-v4-flash' },
      },
    });

    await expectChatDefaults(
      {},
      {
        agent: 'assistant',
        model: 'deepseek/deepseek-v4-flash',
        modelSource: 'user-config',
      },
    );
  });

  it('lets the environment outrank config and an override outrank both', async () => {
    await withConfig({
      workspace: {
        'texra.chat': {
          agent: 'assistant',
          model: 'deepseek/deepseek-v4-flash',
        },
      },
    });

    await expectChatDefaults(
      { envModel: 'anthropic/claude-sonnet-4-6' },
      {
        agent: 'assistant',
        model: 'anthropic/claude-sonnet-4-6',
        modelSource: 'environment',
      },
    );
    await expectChatDefaults(
      {
        envModel: 'anthropic/claude-sonnet-4-6',
        modelOverride: 'openai/gpt-5.5-2026-04-23',
      },
      { model: 'openai/gpt-5.5-2026-04-23', modelSource: 'explicit-override' },
    );
  });

  it('ignores an agent that cannot be an implicit default, unless it is explicit', async () => {
    await withConfig({
      workspace: {
        'texra.chat': {
          agent: 'simplifier',
          model: 'anthropic/claude-sonnet-4-6',
        },
      },
    });

    // Configured and environment tiers drop it; the explicit flag keeps it.
    await expectChatDefaults(
      {},
      { agent: 'assistant', model: 'anthropic/claude-sonnet-4-6' },
    );
    await expectChatDefaults(
      { envAgent: 'simplifier' },
      { agent: 'assistant' },
    );
    await expectChatDefaults(
      { agentOverride: 'simplifier' },
      { agent: 'simplifier' },
    );
  });
});
