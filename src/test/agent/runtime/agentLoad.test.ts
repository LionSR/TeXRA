// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent core
import { AgentType } from '@agent/core/AgentDataclass';

// Local imports - agent runtime
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';

// Local imports - utilities
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

    const [, prompts] = await loadAgentSettingAndPrompts(
      agentPathInfo,
      'summarize',
      {
        preferMultiple: true,
      },
    );

    assert.strictEqual(prompts.userRequest, 'base only');
  });

  test('sets tool-use agent type for built-in tool agents without explicit type', async () => {
    const agentPath = path.join('/', 'tmp', 'tool-use');
    const baseDefinitionPath = path.join(agentPath, 'toolsmith.yaml');
    const agentPathInfo = {
      directory: agentPath,
      source: AgentDirectorySource.BuiltInToolUse,
    } as const;

    fileContents.set(
      normalize(baseDefinitionPath),
      [
        'name: toolsmith',
        'settings:',
        '  temperature: 0.1',
        'prompts:',
        '  userRequest: gather tools',
        '',
      ].join('\n'),
    );

    const [settings] = await loadAgentSettingAndPrompts(
      agentPathInfo,
      'toolsmith',
    );

    assert.strictEqual(settings.agentType, AgentType.ToolUse);
  });
});
