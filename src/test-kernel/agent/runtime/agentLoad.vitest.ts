// Third-party imports

// Standard library imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'vitest';

// Local imports - agent runtime
import type { ResolvedAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  loadAgentSettingAndPrompts,
  validateAgentYamlContent,
} from '@agent/runtime/agentLoad';
import { AbsoluteFS } from '@utils/files';

describe('validateAgentYamlContent', () => {
  it('rejects root settings that only satisfy the partial YAML schema', () => {
    assert.throws(() =>
      validateAgentYamlContent({
        name: 'bad_tool_use_root',
        settings: {
          agentCategory: AgentCategory.ToolUse,
          rounds: 2,
        },
      }),
    );
  });

  it('keeps inherited child settings partial before parent merging', () => {
    const result = validateAgentYamlContent({
      name: 'child',
      inherits: 'parent',
      settings: {
        rounds: 2,
      },
      prompts: {
        userRequest: 'Override the parent request.',
      },
    });

    assert.deepStrictEqual(result.settings, { rounds: 2 });
    assert.deepStrictEqual(result.prompts, {
      userRequest: 'Override the parent request.',
    });
  });

  it('validates root agents after resolving raw tool names', () => {
    const result = validateAgentYamlContent({
      name: 'root_tool_use',
      settings: {
        agentCategory: AgentCategory.ToolUse,
        tools: ['grep'],
      },
    });

    assert.deepStrictEqual(result.settings.tools, ['grep']);
  });
});

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
        // agentCategory is the discriminator of AgentSettingSchema; only
        // builtInToolUse agents get it defaulted, so custom YAMLs declare it.
        '  agentCategory: workflow',
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

  it('loads legacy workflow settings that still declare outputExt', async () => {
    const agentPath = path.join('/', 'tmp', 'agents');
    const definitionPath = path.join(agentPath, 'legacy.yaml');
    const resolution: ResolvedAgent = {
      entry: {
        source: 'custom',
        name: 'legacy',
        path: definitionPath,
        category: AgentCategory.Workflow,
      },
      definitionPath,
      resolvedName: 'legacy',
    };

    fileContents.set(
      normalize(definitionPath),
      [
        'name: legacy',
        'settings:',
        '  agentCategory: workflow',
        '  outputExt: tex',
        'prompts:',
        '  userRequest: fix it',
        '',
      ].join('\n'),
    );

    const [settings] = await loadAgentSettingAndPrompts(resolution);
    assert.strictEqual(settings.agentCategory, AgentCategory.Workflow);
    assert.strictEqual(Object.hasOwn(settings, 'outputExt'), false);
  });
});
