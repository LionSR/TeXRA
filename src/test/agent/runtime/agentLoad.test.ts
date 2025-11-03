// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent runtime
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
import * as logger from '@logger/logUtils';
import { AbsoluteFS } from '@utils/files';

suite('loadAgentSettingAndPrompts', () => {
  const absoluteFsAny = AbsoluteFS as unknown as {
    exists: (filePath: string) => Promise<boolean>;
    read: (filePath: string) => Promise<string>;
  };
  const originalExists = absoluteFsAny.exists;
  const originalRead = absoluteFsAny.read;

  const fileContents = new Map<string, string>();

  function normalize(filePath: string): string {
    return path.normalize(filePath);
  }

  setup(() => {
    fileContents.clear();

    absoluteFsAny.exists = async (filePath: string) =>
      fileContents.has(normalize(filePath));

    absoluteFsAny.read = async (filePath: string) => {
      const normalized = normalize(filePath);
      const content = fileContents.get(normalized);
      if (!content) {
        throw new Error(`File not found: ${filePath}`);
      }
      return content;
    };
  });

  teardown(() => {
    absoluteFsAny.exists = originalExists;
    absoluteFsAny.read = originalRead;
  });

  test('uses the _multiple definition when available', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const baseDefinitionPath = path.join(agentPath, 'polish.yaml');
    const multipleDefinitionPath = path.join(agentPath, 'polish_multiple.yaml');
    const agentPathInfo = {
      directory: agentPath,
      source: AgentDirectorySource.Custom,
    } as const;

    fileContents.set(
      normalize(multipleDefinitionPath),
      [
        'name: polish_multiple',
        'settings:',
        '  agentType: direct',
        'prompts:',
        '  userRequest: multiple variant',
        '',
      ].join('\n'),
    );

    fileContents.set(
      normalize(baseDefinitionPath),
      [
        'name: polish',
        'settings:',
        '  agentType: direct',
        'prompts:',
        '  userRequest: base variant',
        '',
      ].join('\n'),
    );

    const [, prompts] = await loadAgentSettingAndPrompts(
      agentPathInfo,
      'polish',
      {
        preferMultiple: true,
      },
    );

    assert.strictEqual(prompts.userRequest, 'multiple variant');
  });

  test('falls back to the base definition when _multiple is missing', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const baseDefinitionPath = path.join(agentPath, 'summarize.yaml');
    const agentPathInfo = {
      directory: agentPath,
      source: AgentDirectorySource.Custom,
    } as const;

    fileContents.set(
      normalize(baseDefinitionPath),
      [
        'name: summarize',
        'settings:',
        '  agentType: direct',
        'prompts:',
        '  userRequest: base only',
        '',
      ].join('\n'),
    );

    const recordedWarnings: { channel: string; message: string }[] = [];
    const loggerAny = logger as typeof logger & {
      warn: typeof logger.warn;
    };
    const originalWarn = loggerAny.warn;
    loggerAny.warn = (channel, message) => {
      recordedWarnings.push({ channel, message });
    };

    try {
      const [, prompts] = await loadAgentSettingAndPrompts(
        agentPathInfo,
        'summarize',
        {
          preferMultiple: true,
        },
      );

      assert.strictEqual(prompts.userRequest, 'base only');
    } finally {
      loggerAny.warn = originalWarn;
    }

    assert.deepStrictEqual(recordedWarnings, [
      {
        channel: 'agentLoad',
        message:
          'Requested multiple outputs for agent "summarize" but no _multiple definition was found. Falling back to base definition.',
      },
    ]);
  });
});
