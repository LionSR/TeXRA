import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { Effect } from 'effect';
import {
  __resetUserConfigWarningDedupeForTests,
  resolveChatDefaults as nativeResolveChatDefaults,
} from '@cli/runtime/chatDefaults';
import {
  CLI_BUILTIN_DEFAULT_MODEL,
  loadWorkspaceCliConfig,
} from '@cli/runtime/cliConfig';
import * as logSinks from '@cli/runtime/logSinks';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { GlobalStorageFS } from '@utils/files/storageFS';

/** A cwd with no `.texra` directory, so the workspace tier finds nothing. */
const NO_WORKSPACE = '/tmp/no-such-texra-workspace';

/**
 * Shared config layers exercised at both the workspace and user tiers: an
 * unprefixed `texra.agent`/`texra.model` pair plus a prefixed `texra.chat`
 * override, so tests can assert the command-specific layer wins.
 */
const CHAT_TIER_CONFIG = {
  'texra.agent': 'generic',
  'texra.model': 'gpt55',
  'texra.chat': { agent: 'assistant', model: 'deepseekT' },
};

/** A missing user config, shaped like a genuine `fs` ENOENT rejection. */
function enoentError(): NodeJS.ErrnoException {
  const error = new Error(
    'ENOENT: no such file or directory',
  ) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

const resolveChatDefaults = (
  options: Parameters<typeof nativeResolveChatDefaults>[0],
) => Effect.runPromise(nativeResolveChatDefaults(options));

// Spied, not stubbed: the workspace tiers below still read real `.texra`
// config files, while the fast-path tests assert the loader is never reached.
vi.mock('@cli/runtime/cliConfig', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/cliConfig')>();
  return {
    ...actual,
    loadWorkspaceCliConfig: vi.fn(actual.loadWorkspaceCliConfig),
  };
});

const mockedLoadWorkspaceCliConfig = vi.mocked(loadWorkspaceCliConfig);

vi.mock('@utils/files/storageFS', () => ({
  GlobalStorageFS: {
    readJson: vi.fn(async () => {
      throw new Error('no user defaults');
    }),
  },
}));

const mockedReadJson = vi.mocked(GlobalStorageFS.readJson);

beforeEach(() => {
  mockedLoadWorkspaceCliConfig.mockClear();
  mockedReadJson.mockReset();
  // A missing user config (the common case) mirrors a real ENOENT rejection.
  mockedReadJson.mockRejectedValue(enoentError());
  __resetUserConfigWarningDedupeForTests();
});

const tempDirs = useTempDirs();

async function workspaceWithConfig(config: unknown): Promise<string> {
  const workspace = await makeTempDir('texra-chat-defaults-', tempDirs);
  await mkdir(join(workspace, '.texra'), { recursive: true });
  await writeFile(
    join(workspace, '.texra', 'config.json'),
    JSON.stringify(config),
  );
  return workspace;
}

function expectChatDefaults(
  options: Parameters<typeof resolveChatDefaults>[0],
  expected: Record<string, unknown>,
): Promise<void> {
  return expect(resolveChatDefaults(options)).resolves.toMatchObject(expected);
}

describe('CLI chat defaults', () => {
  it('uses assistant and DeepSeek as the built-in chat defaults', async () => {
    expect(CLI_BUILTIN_DEFAULT_MODEL).toBe('deepseekproT');
    expect(MODEL_CONFIGS[CLI_BUILTIN_DEFAULT_MODEL]).toBeDefined();

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekproT',
        modelSource: 'builtin-default',
      },
    );
  });

  it('uses the first visible tool-use agent when assistant is hidden by a roster', async () => {
    await expectChatDefaults(
      {
        cwd: NO_WORKSPACE,
        visibleToolUseAgents: [{ name: 'research' }, { name: 'review' }],
      },
      {
        agent: 'research',
        model: 'deepseekproT',
      },
    );
  });

  it('ignores non-llm-zoo model ids in workspace defaults', async () => {
    const workspace = await workspaceWithConfig({
      'texra.agent': 'assistant',
      'texra.model': 'claude-opus-4-7',
    });

    await expectChatDefaults(
      { cwd: workspace },
      {
        agent: 'assistant',
        model: 'deepseekproT',
        modelSource: 'builtin-default',
      },
    );
  });

  it('uses command-specific workspace defaults below environment overrides', async () => {
    const workspace = await workspaceWithConfig(CHAT_TIER_CONFIG);

    await expectChatDefaults(
      { cwd: workspace, envModel: 'sonnet46T' },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        modelSource: 'environment',
      },
    );
  });

  it('ignores simplifier from configured chat default tiers', async () => {
    const workspace = await workspaceWithConfig({
      'texra.chat': { agent: 'simplifier', model: 'sonnet46T' },
    });

    await expectChatDefaults(
      { cwd: workspace },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        modelSource: 'workspace-config',
      },
    );

    mockedReadJson.mockResolvedValueOnce({
      'texra.agent': 'simplifier',
      'texra.model': 'sonnet46T',
    });
    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        modelSource: 'user-config',
      },
    );
  });

  it('does not honor TEXRA_AGENT=simplifier as a default agent', async () => {
    await expectChatDefaults(
      { cwd: NO_WORKSPACE, envAgent: 'simplifier' },
      {
        agent: 'assistant',
      },
    );
  });

  it('still honors an explicit simplifier agent override', async () => {
    await expectChatDefaults(
      {
        cwd: NO_WORKSPACE,
        agentOverride: 'simplifier',
        modelOverride: 'deepseekT',
      },
      {
        agent: 'simplifier',
      },
    );
  });

  it('skips workspace and user I/O when explicit overrides resolve agent and model', async () => {
    const workspace = await workspaceWithConfig({
      'texra.chat': { agent: 'assistant', model: 'sonnet46T' },
    });

    await expectChatDefaults(
      {
        cwd: workspace,
        agentOverride: 'simplifier',
        modelOverride: 'deepseekT',
      },
      {
        agent: 'simplifier',
        model: 'deepseekT',
        modelSource: 'explicit-override',
      },
    );
    expect(mockedLoadWorkspaceCliConfig).not.toHaveBeenCalled();
    expect(mockedReadJson).not.toHaveBeenCalled();
  });

  it('keeps default-tier loading when only the model is directly resolved', async () => {
    const workspace = await workspaceWithConfig({
      'texra.chat': { agent: 'assistant', model: 'sonnet46T' },
    });

    await expectChatDefaults(
      { cwd: workspace, modelOverride: 'deepseekT' },
      {
        agent: 'assistant',
        model: 'deepseekT',
        modelSource: 'explicit-override',
      },
    );
    expect(mockedLoadWorkspaceCliConfig).toHaveBeenCalledOnce();
  });

  it('skips workspace and user I/O when environment resolves agent and model', async () => {
    await expectChatDefaults(
      { cwd: NO_WORKSPACE, envAgent: 'assistant', envModel: 'sonnet46T' },
      {
        agent: 'assistant',
        model: 'sonnet46T',
        modelSource: 'environment',
      },
    );
    expect(mockedLoadWorkspaceCliConfig).not.toHaveBeenCalled();
    expect(mockedReadJson).not.toHaveBeenCalled();
  });

  it('still loads the model tiers when only the agent is directly resolved', async () => {
    const workspace = await workspaceWithConfig({
      'texra.chat': { model: 'sonnet46T' },
    });

    await expectChatDefaults(
      { cwd: workspace, agentOverride: 'simplifier' },
      {
        agent: 'simplifier',
        model: 'sonnet46T',
        modelSource: 'workspace-config',
      },
    );
    expect(mockedLoadWorkspaceCliConfig).toHaveBeenCalledOnce();
  });

  it('uses prefixed command-specific workspace defaults', async () => {
    const workspace = await workspaceWithConfig(CHAT_TIER_CONFIG);

    await expectChatDefaults(
      { cwd: workspace },
      {
        agent: 'assistant',
        model: 'deepseekT',
      },
    );
  });

  it('uses the shared config parser for prefixed user chat defaults', async () => {
    mockedReadJson.mockResolvedValueOnce(CHAT_TIER_CONFIG);

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekT',
        modelSource: 'user-config',
      },
    );
  });

  it('warns instead of silently dropping defaults when the user config is corrupt', async () => {
    // Not an ENOENT — e.g. truncated/hand-edited JSON, or a permission error.
    // The old behavior caught every readJson failure alike and silently fell
    // through to {}, indistinguishable from "no user config".
    const corrupt = new Error('Failed to parse JSON from config.json');
    mockedReadJson.mockRejectedValueOnce(corrupt);
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekproT',
      },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('config.json'),
    );
    warnSpy.mockRestore();
  });

  it('suppresses user-config warnings under --quiet', async () => {
    // These warnings are printed inside resolveChatDefaults itself, not
    // through contextFromArgs's gated configWarnings path, so they need
    // their own --quiet check to avoid always printing regardless of it.
    const corrupt = new Error('Failed to parse JSON from config.json');
    mockedReadJson.mockRejectedValueOnce(corrupt);
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    await expectChatDefaults(
      { cwd: NO_WORKSPACE, quiet: true },
      {
        agent: 'assistant',
        model: 'deepseekproT',
      },
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warns instead of silently dropping defaults when the user config is not an object', async () => {
    // Valid JSON, wrong top-level shape (e.g. hand-edited to an array) —
    // distinct from the corrupt-JSON case above, and from a missing file.
    mockedReadJson.mockResolvedValueOnce([]);
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
        model: 'deepseekproT',
      },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('expected a JSON object'),
    );
    warnSpy.mockRestore();
  });

  it('does not warn about unknown top-level keys in the shared user config', async () => {
    // config.json is shared by all three hosts; a setting only the
    // extension or desktop honors is not "unknown" from the user's
    // perspective just because the CLI doesn't read it.
    mockedReadJson.mockResolvedValueOnce({
      'agentReview.runOnCommit': true,
      'texra.agent': 'assistant',
    });
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
      },
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('still warns about an unknown key inside the CLI-exclusive chat section', async () => {
    // Unlike the shared top level, texra.chat.* is CLI-only structure in
    // every host — nothing else reads or writes it — so a typo here (e.g.
    // "modle" for "model") is always worth a warning, not suppressed by the
    // same reportUnknownKeys: false that guards the shared top-level rows.
    mockedReadJson.mockResolvedValueOnce({
      'texra.agent': 'assistant',
      'texra.chat': { modle: 'deepseekT' },
    });
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
      },
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('texra.chat.modle'),
    );
    warnSpy.mockRestore();
  });

  it('does not warn about fields this tier does not resolve', async () => {
    // agent/model (top-level and chat.*) are the only fields
    // defaultsFromConfigValues reads here. approvalPolicy is already
    // validated and warned about separately by loadUserApprovalPolicy;
    // outputFormat and run.* are never consumed by chat defaults at all.
    // Warning about them here would duplicate that other warning and, since
    // orchestrate's launcher loop calls resolveChatDefaults on every
    // iteration, would reprint on every pass through the loop.
    mockedReadJson.mockResolvedValueOnce({
      'texra.agent': 'assistant',
      'texra.approvalPolicy': 'not-a-real-policy',
      'texra.outputFormat': 'not-a-real-format',
      'texra.run': { model: 42 },
    });
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    await expectChatDefaults(
      { cwd: NO_WORKSPACE },
      {
        agent: 'assistant',
      },
    );

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reprints a warning once an intervening valid read clears the dedup state', async () => {
    // The warning text carries only the field name, not the invalid value,
    // so a field a user fixes and later breaks again the same way must
    // still warn — deduping must not be "seen this message ever," only
    // "seen this message on the immediately preceding read."
    const invalidModel = {
      'texra.agent': 'assistant',
      'texra.model': 'not-a-real-model-xyz',
    };
    const validModel = { 'texra.agent': 'assistant', 'texra.model': 'gpt55' };
    const warnSpy = vi
      .spyOn(logSinks, 'writeTextStderr')
      .mockImplementation(() => {});

    mockedReadJson.mockResolvedValueOnce(invalidModel);
    await resolveChatDefaults({ cwd: NO_WORKSPACE });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Same invalid config again: deduped against the previous read.
    mockedReadJson.mockResolvedValueOnce(invalidModel);
    await resolveChatDefaults({ cwd: NO_WORKSPACE });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Fixed: no warning, and the dedup state no longer carries the old one.
    mockedReadJson.mockResolvedValueOnce(validModel);
    await resolveChatDefaults({ cwd: NO_WORKSPACE });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Broken again: warns again, since the previous read had no warnings.
    mockedReadJson.mockResolvedValueOnce(invalidModel);
    await resolveChatDefaults({ cwd: NO_WORKSPACE });
    expect(warnSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });
});
