// Third-party imports

// Standard library imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';
import { describe, it, beforeEach, afterEach, vi } from 'vitest';

// Local imports - agent runtime
import { resolveAgent, type ResolvedAgent } from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  loadAgentSettingAndPrompts,
  validateAgentYamlContent,
} from '@agent/runtime/agentLoad';
import { AbsoluteFS } from '@utils/files';

vi.mock('@agent/index', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/index')>('@agent/index');
  return { ...actual, resolveAgent: vi.fn(actual.resolveAgent) };
});

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

  it('wraps malformed YAML text through the shared parse boundary', () => {
    assert.throws(
      () => validateAgentYamlContent('name: "unterminated'),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith('Failed to parse agent YAML:'),
    );
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

  function customResolution(
    name: string,
    category: AgentCategory,
  ): ResolvedAgent {
    const definitionPath = path.join('/', 'tmp', 'agents', `${name}.yaml`);
    return {
      entry: { source: 'custom', name, path: definitionPath, category },
      definitionPath,
      resolvedName: name,
    };
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
    const resolution = customResolution('polish', AgentCategory.Workflow);

    fileContents.set(
      normalize(resolution.definitionPath),
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
    const resolution = customResolution('latexFixer', AgentCategory.ToolUse);

    fileContents.set(
      normalize(resolution.definitionPath),
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
    const resolution = customResolution('legacy', AgentCategory.Workflow);

    fileContents.set(
      normalize(resolution.definitionPath),
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

  it('rejects with a wrapped error naming the path for malformed YAML', async () => {
    const resolution = customResolution('broken', AgentCategory.Workflow);

    fileContents.set(
      normalize(resolution.definitionPath),
      'name: "unterminated\n',
    );

    await assert.rejects(
      () => loadAgentSettingAndPrompts(resolution),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith(
          `Failed to parse YAML at ${resolution.definitionPath}:`,
        ),
    );
  });

  it('rejects a circular "inherits" chain instead of recursing without bound', async () => {
    const resolutionA = customResolution('agent_a', AgentCategory.Workflow);
    const resolutionB = customResolution('agent_b', AgentCategory.Workflow);
    const resolutionByName: Record<string, ResolvedAgent> = {
      agent_a: resolutionA,
      agent_b: resolutionB,
    };

    fileContents.set(
      normalize(resolutionA.definitionPath),
      [
        'name: agent_a',
        'inherits: agent_b',
        'settings:',
        '  agentCategory: workflow',
        'prompts: {}',
        '',
      ].join('\n'),
    );
    fileContents.set(
      normalize(resolutionB.definitionPath),
      [
        'name: agent_b',
        'inherits: agent_a',
        'settings:',
        '  agentCategory: workflow',
        'prompts: {}',
        '',
      ].join('\n'),
    );

    const resolveAgentMock = vi.mocked(resolveAgent);
    resolveAgentMock.mockImplementation(
      (identifier: string) => resolutionByName[identifier.split(':').pop()!],
    );

    try {
      await assert.rejects(
        () => loadAgentSettingAndPrompts(resolutionA),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith('Circular "inherits" chain detected:'),
      );
    } finally {
      resolveAgentMock.mockRestore();
    }
  });
});
