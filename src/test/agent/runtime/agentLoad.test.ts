// Standard library imports
import { strict as assert } from 'assert';
import * as path from 'path';

// Local imports - agent runtime
import type { ResolvedAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { loadAgentSettingAndPrompts } from '@agent/runtime/agentLoad';
import { AbsoluteFS } from '@utils/files';

describe('loadAgentSettingAndPrompts', () => {
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

  beforeEach(() => {
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

  afterEach(() => {
    absoluteFsAny.exists = originalExists;
    absoluteFsAny.read = originalRead;
  });

  it('uses the _multiple definition when available', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const baseDefinitionPath = path.join(agentPath, 'polish.yaml');
    const multipleDefinitionPath = path.join(agentPath, 'polish_multiple.yaml');
    const multipleResolution: ResolvedAgent = {
      entry: {
        source: 'custom',
        name: 'polish',
        path: baseDefinitionPath,
        multiplePath: multipleDefinitionPath,
        category: AgentCategory.Workflow,
      },
      definitionPath: multipleDefinitionPath,
      resolvedName: 'polish_multiple',
      usedFallback: false,
    };

    fileContents.set(
      normalize(multipleDefinitionPath),
      [
        'name: polish_multiple',
        'settings:',
        '  rounds: 1',
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
        '  rounds: 1',
        'prompts:',
        '  userRequest: base variant',
        '',
      ].join('\n'),
    );

    const [, prompts] = await loadAgentSettingAndPrompts(multipleResolution, {
      preferMultiple: true,
    });

    assert.strictEqual(prompts.userRequest, 'multiple variant');
  });

  it('falls back to the base definition when _multiple is missing', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const baseDefinitionPath = path.join(agentPath, 'summarize.yaml');
    const fallbackResolution: ResolvedAgent = {
      entry: {
        source: 'custom',
        name: 'summarize',
        path: baseDefinitionPath,
        category: AgentCategory.Workflow,
      },
      definitionPath: baseDefinitionPath,
      resolvedName: 'summarize',
      usedFallback: true,
    };

    fileContents.set(
      normalize(baseDefinitionPath),
      [
        'name: summarize',
        'settings:',
        '  rounds: 1',
        'prompts:',
        '  userRequest: base only',
        '',
      ].join('\n'),
    );

    const [, prompts] = await loadAgentSettingAndPrompts(fallbackResolution, {
      preferMultiple: true,
    });

    assert.strictEqual(prompts.userRequest, 'base only');
  });
});
