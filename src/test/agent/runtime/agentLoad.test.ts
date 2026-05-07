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

  it('loads settings and prompts from the given definition path', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const definitionPath = path.join(agentPath, 'polish.yaml');
    const resolution: ResolvedAgent = {
      entry: {
        source: 'custom',
        name: 'polish',
        path: definitionPath,
        category: AgentCategory.Workflow,
      },
      definitionPath,
      resolvedName: 'polish',
    };

    fileContents.set(
      normalize(definitionPath),
      [
        'name: polish',
        'settings:',
        '  rounds: 1',
        'prompts:',
        '  userRequest: unified variant',
        '',
      ].join('\n'),
    );

    const [, prompts] = await loadAgentSettingAndPrompts(resolution);

    assert.strictEqual(prompts.userRequest, 'unified variant');
  });

  it('accepts the internal registry-metadata field in agent settings', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const definitionPath = path.join(agentPath, 'latexFixer.yaml');
    const resolution: ResolvedAgent = {
      entry: {
        source: 'custom',
        name: 'latexFixer',
        path: definitionPath,
        category: AgentCategory.ToolUse,
      },
      definitionPath,
      resolvedName: 'latexFixer',
    };

    fileContents.set(
      normalize(definitionPath),
      [
        'name: latexFixer',
        'settings:',
        '  agentCategory: toolUse',
        '  internal: true',
        'prompts:',
        '  userRequest: fix it',
        '',
      ].join('\n'),
    );

    const [settings] = await loadAgentSettingAndPrompts(resolution);
    assert.strictEqual(
      settings.internal,
      true,
      'internal: true should round-trip through AgentSettingSchema',
    );
  });
});
