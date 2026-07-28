// Third-party imports

// Standard library imports
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, it, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

// Local imports - agent runtime
import {
  clearInlineAgents,
  getAgent,
  loadAgents,
  refresh,
  registerInlineAgents,
  resolveAgent,
  resolveAgentForLaunch,
  type ResolvedAgent,
} from '@agent/index';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  loadAgentSettingAndPrompts,
  validateAgentYamlContent,
} from '@agent/runtime/agentLoad';
import type { AgentDirectoriesPort } from '@platform/interfaces';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { installPlatform } from '@test/support/setupPlatform';
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

    const actual =
      await vi.importActual<typeof import('@agent/index')>('@agent/index');
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
      // mockRestore() only rehydrates vi.spyOn() mocks; this is a plain
      // vi.fn(actual.resolveAgent), so restore the real implementation
      // explicitly to avoid leaving `resolveAgent` returning undefined for
      // any later test in this describe block.
      resolveAgentMock.mockImplementation(actual.resolveAgent);
    }
  });
});

describe('inline agent definitions', () => {
  const SCRATCHPAD = {
    name: 'scratchpad',
    description: 'Registered as a value, never written to disk.',
    settings: { agentCategory: AgentCategory.ToolUse, tools: ['grep'] },
    prompts: { systemPrompt: 'You are an inline agent.' },
  };

  async function useAgentDirectories(
    dir: string,
    workspaceState: Record<string, unknown> = {},
  ): Promise<void> {
    const directories: AgentDirectoriesPort = {
      custom: async () => dir,
      builtIn: async () => dir,
      builtInToolUse: async () => dir,
    };
    await installPlatform(
      { workspaceState },
      { fs: nodeFilesystem, agentDirectories: directories },
    );
  }

  beforeAll(async () => {
    // Every agent directory points at an empty folder: nothing the registry
    // returns below can have come from YAML on disk.
    await useAgentDirectories(
      await mkdtemp(path.join(tmpdir(), 'texra-empty-agents-')),
    );
    registerInlineAgents([SCRATCHPAD]);
    await loadAgents({ includeRemote: false });
  });

  it('resolves a registered definition with no YAML behind it', () => {
    const entry = getAgent('scratchpad');
    assert.strictEqual(entry?.source, 'inline');
    assert.strictEqual(entry.path, '');
    assert.strictEqual(entry.category, AgentCategory.ToolUse);
    assert.deepStrictEqual(entry.tools, ['grep']);
    assert.strictEqual(getAgent('inline:scratchpad')?.name, 'scratchpad');
  });

  it('returns settings and prompts without reading the filesystem', async () => {
    const resolution = resolveAgentForLaunch(
      AgentCategory.ToolUse,
      'scratchpad',
    );
    assert.ok(resolution, 'launch resolution should find the inline agent');
    assert.strictEqual(resolution.definitionPath, '');

    const read = vi.spyOn(AbsoluteFS, 'read');
    try {
      const [settings, prompts] = await loadAgentSettingAndPrompts(resolution);

      assert.strictEqual(settings.agentCategory, AgentCategory.ToolUse);
      assert.strictEqual(
        prompts.systemPrompt,
        'You are an inline agent.',
        'prompts should come back already parsed',
      );
      assert.strictEqual(read.mock.calls.length, 0);
    } finally {
      read.mockRestore();
    }
  });

  it('survives a catalog refresh that rebuilds the cache', async () => {
    await refresh({ includeRemote: false });
    assert.strictEqual(getAgent('inline:scratchpad')?.source, 'inline');
  });

  it('accepts a registration made after the initial load', () => {
    registerInlineAgents([
      {
        name: 'lateComer',
        settings: { agentCategory: AgentCategory.Workflow, rounds: 3 },
        prompts: { userRequest: 'Do the thing.' },
      },
    ]);

    const entry = getAgent('lateComer');
    assert.strictEqual(entry?.source, 'inline');
    assert.strictEqual(entry.rounds, 3);
  });

  it('defaults an omitted category to a launchable workflow definition', async () => {
    registerInlineAgents([
      {
        name: 'defaultWorkflow',
        settings: { rounds: 1 },
        prompts: { userRequest: 'Do the thing.' },
      },
    ]);

    const resolution = resolveAgentForLaunch(
      AgentCategory.Workflow,
      'defaultWorkflow',
    );
    assert.ok(resolution);
    const [settings] = await loadAgentSettingAndPrompts(resolution);
    assert.strictEqual(settings.agentCategory, AgentCategory.Workflow);
  });

  it('applies a stored tool-use override during late registration', async () => {
    const emptyDir = await mkdtemp(path.join(tmpdir(), 'texra-empty-agents-'));
    await useAgentDirectories(emptyDir, {
      [WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS]: ['lateOverride'],
    });
    await refresh({ includeRemote: false });

    registerInlineAgents([
      {
        name: 'lateOverride',
        settings: { agentCategory: AgentCategory.Workflow, rounds: 3 },
        prompts: {},
      },
    ]);

    const entry = getAgent('inline:lateOverride');
    assert.strictEqual(entry?.category, AgentCategory.ToolUse);
    assert.strictEqual(entry.rounds, undefined);
    const overriddenResolution = resolveAgentForLaunch(
      AgentCategory.ToolUse,
      'inline:lateOverride',
    );
    assert.ok(overriddenResolution);
    const [overriddenSettings] =
      await loadAgentSettingAndPrompts(overriddenResolution);
    assert.strictEqual(overriddenSettings.agentCategory, AgentCategory.ToolUse);

    await useAgentDirectories(emptyDir);
    await refresh({ includeRemote: false });
    const restored = getAgent('inline:lateOverride');
    assert.strictEqual(restored?.category, AgentCategory.Workflow);
    assert.strictEqual(restored.rounds, 3);
  });

  it('removes cleared definitions from the live registry immediately', () => {
    try {
      clearInlineAgents();
      assert.strictEqual(getAgent('scratchpad'), undefined);
      assert.strictEqual(resolveAgent('inline:scratchpad'), undefined);
    } finally {
      registerInlineAgents([SCRATCHPAD]);
    }
  });

  it('rejects a definition that declares inherits', () => {
    assert.throws(
      () =>
        registerInlineAgents([
          {
            name: 'derived',
            inherits: 'scratchpad',
            settings: { agentCategory: AgentCategory.ToolUse },
            prompts: {},
          },
        ]),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('must be self-contained'),
    );
  });

  it('rejects a malformed definition at the registration call', () => {
    assert.throws(() => registerInlineAgents([{ name: '' }]));
  });

  it('rejects every workflow-only setting on a tool-use definition', () => {
    assert.throws(() =>
      registerInlineAgents([
        {
          name: 'invalidToolUse',
          settings: {
            agentCategory: AgentCategory.ToolUse,
            isRewrite: false,
          },
          prompts: {},
        },
      ]),
    );
  });

  it('does not expose the stored definition through a resolution', async () => {
    registerInlineAgents([
      {
        name: 'immutableResolution',
        settings: {
          agentCategory: AgentCategory.ToolUse,
          tools: ['grep'],
        },
        prompts: { userRequest: 'Original request.' },
      },
    ]);

    const first = resolveAgent('inline:immutableResolution');
    assert.ok(first?.inlineDefinition);
    first.inlineDefinition.prompts.userRequest = 'Mutated request.';
    first.inlineDefinition.settings.tools?.push('bash');

    const second = resolveAgentForLaunch(
      AgentCategory.ToolUse,
      'inline:immutableResolution',
    );
    assert.ok(second);
    const [settings, prompts] = await loadAgentSettingAndPrompts(second);
    assert.strictEqual(prompts.userRequest, 'Original request.');
    assert.deepStrictEqual(
      settings.tools.map((tool) => tool.name),
      ['grep'],
    );
  });

  it('preserves runtime schemas in object-form tool definitions', async () => {
    const runtimeSchema = z.strictObject({ query: z.string() });
    const parameters = {
      type: 'object',
      properties: { query: { type: 'string' } },
    };
    registerInlineAgents([
      {
        name: 'runtimeToolSchema',
        settings: {
          agentCategory: AgentCategory.ToolUse,
          tools: [
            {
              name: 'runtimeTool',
              parameters,
              zodSchema: runtimeSchema,
            },
          ],
        },
        prompts: {},
      },
    ]);
    parameters.properties.query.type = 'number';

    const resolution = resolveAgentForLaunch(
      AgentCategory.ToolUse,
      'inline:runtimeToolSchema',
    );
    assert.ok(resolution);
    const [settings] = await loadAgentSettingAndPrompts(resolution);
    assert.strictEqual(settings.tools[0]?.zodSchema, runtimeSchema);
    assert.deepStrictEqual(settings.tools[0]?.parameters, {
      type: 'object',
      properties: { query: { type: 'string' } },
    });
  });

  it('fails loudly when the load path names an unregistered inline agent', async () => {
    await assert.rejects(
      () =>
        loadAgentSettingAndPrompts({
          entry: {
            name: 'ghost',
            source: 'inline',
            path: '',
            category: AgentCategory.ToolUse,
          },
          definitionPath: '',
          resolvedName: 'ghost',
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Inline agent "ghost" is not registered'),
    );
  });

  it('keys inline agents apart from a same-named custom agent', async () => {
    const customDir = await mkdtemp(path.join(tmpdir(), 'texra-custom-'));
    await writeFile(
      path.join(customDir, 'scratchpad.yaml'),
      [
        'name: scratchpad',
        'description: On-disk namesake',
        'settings:',
        '  agentCategory: toolUse',
        '  tools: []',
        'prompts:',
        '  systemPrompt: On-disk scratchpad.',
        '',
      ].join('\n'),
    );
    await useAgentDirectories(customDir);
    await refresh({ includeRemote: false });

    // Distinct keys, so neither registration displaces the other...
    assert.strictEqual(
      getAgent('custom:scratchpad')?.path,
      path.join(customDir, 'scratchpad.yaml'),
    );
    assert.strictEqual(getAgent('inline:scratchpad')?.path, '');
    // ...and the bare name prefers the definition the embedder supplied.
    assert.strictEqual(getAgent('scratchpad')?.source, 'inline');
  });
});
