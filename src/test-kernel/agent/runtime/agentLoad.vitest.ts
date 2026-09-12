import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import {
  afterAll,
  beforeAll,
  describe,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

import { getAgent, loadAgents, refresh } from '@agent/index';
import type { AgentEntry } from '@agent/index/agentEntry';
import {
  loadAgentSettingAndPrompts,
  validateAgentYamlContent,
} from '@agent/runtime/agentLoad';
import type { AgentDirectoriesPort } from '@platform/interfaces';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { AgentCategory } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';

vi.mock('@agent/index', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/index')>('@agent/index');
  return { ...actual, getAgent: vi.fn(actual.getAgent) };
});

const tempDirs: string[] = [];

afterAll(async () => {
  await cleanupTempDirs(tempDirs);
});

describe('validateAgentYamlContent', () => {
  it('rejects root settings that only satisfy the partial YAML schema', () => {
    assert.throws(() =>
      validateAgentYamlContent(
        [
          'name: bad_tool_use_root',
          'settings:',
          '  agentCategory: toolUse',
          '  rounds: 2',
          '',
        ].join('\n'),
      ),
    );
  });

  it('keeps inherited child settings partial before parent merging', () => {
    validateAgentYamlContent(
      [
        'name: child',
        'inherits: parent',
        'settings:',
        '  rounds: 2',
        'prompts:',
        '  userRequest: Override the parent request.',
        '',
      ].join('\n'),
    );
  });

  it('validates root agents after resolving raw tool names', () => {
    validateAgentYamlContent(
      [
        'name: root_tool_use',
        'settings:',
        '  agentCategory: toolUse',
        '  tools:',
        '    - grep',
        '',
      ].join('\n'),
    );
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
  const fileContents = new Map<string, string>();

  function putYaml(entry: AgentEntry, lines: string[]): void {
    fileContents.set(path.normalize(entry.path), lines.join('\n'));
  }

  function customEntry(name: string, category: AgentCategory): AgentEntry {
    const definitionPath = path.join('/', 'tmp', 'agents', `${name}.yaml`);
    return { source: 'custom', name, path: definitionPath, category };
  }

  beforeEach(() => {
    fileContents.clear();

    vi.spyOn(AbsoluteFS, 'exists').mockImplementation(
      async (filePath: string) => fileContents.has(path.normalize(filePath)),
    );

    vi.spyOn(AbsoluteFS, 'read').mockImplementation(
      async (filePath: string) => {
        const content = fileContents.get(path.normalize(filePath));
        if (!content) {
          throw new Error(`File not found: ${filePath}`);
        }
        return content;
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads settings and prompts from the given definition path', async () => {
    const entry = customEntry('polish', AgentCategory.Workflow);

    putYaml(entry, [
      'name: polish',
      'settings:',
      // agentCategory is the discriminator of AgentSettingSchema; only
      // builtInToolUse agents get it defaulted, so custom YAMLs declare it.
      '  agentCategory: workflow',
      '  rounds: 1',
      'prompts:',
      '  userRequest: unified variant',
      '',
    ]);

    const [, prompts] = await loadAgentSettingAndPrompts(entry);

    assert.strictEqual(prompts.userRequest, 'unified variant');
  });

  it('rejects with a wrapped error naming the path for malformed YAML', async () => {
    const entry = customEntry('broken', AgentCategory.Workflow);

    fileContents.set(path.normalize(entry.path), 'name: "unterminated\n');

    await assert.rejects(
      () => loadAgentSettingAndPrompts(entry),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith(`Failed to parse YAML at ${entry.path}:`),
    );
  });

  it('rejects a circular "inherits" chain instead of recursing without bound', async () => {
    const entryA = customEntry('agent_a', AgentCategory.Workflow);
    const entryB = customEntry('agent_b', AgentCategory.Workflow);
    const entryByName: Record<string, AgentEntry> = {
      agent_a: entryA,
      agent_b: entryB,
    };

    putYaml(entryA, [
      'name: agent_a',
      'inherits: agent_b',
      'settings:',
      '  agentCategory: workflow',
      'prompts: {}',
      '',
    ]);
    putYaml(entryB, [
      'name: agent_b',
      'inherits: agent_a',
      'settings:',
      '  agentCategory: workflow',
      'prompts: {}',
      '',
    ]);

    const actual =
      await vi.importActual<typeof import('@agent/index')>('@agent/index');
    const getAgentMock = vi.mocked(getAgent);
    getAgentMock.mockImplementation(
      (identifier: string) => entryByName[identifier.split(':').pop()!],
    );

    try {
      await assert.rejects(
        () => loadAgentSettingAndPrompts(entryA),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith('Circular "inherits" chain detected:'),
      );
    } finally {
      // mockRestore() only rehydrates vi.spyOn() mocks; this is a plain
      // vi.fn(actual.getAgent), so restore the real implementation
      // explicitly to avoid leaving `getAgent` returning undefined for
      // any later test in this describe block.
      getAgentMock.mockImplementation(actual.getAgent);
    }
  });
});

describe('agent registry load state', () => {
  let agentDir = '';

  async function installDirectories(
    directories: AgentDirectoriesPort,
  ): Promise<void> {
    await installPlatform(
      {},
      { fs: nodeFilesystem, agentDirectories: directories },
    );
  }

  function countingDirectories(counter: {
    scans: number;
  }): AgentDirectoriesPort {
    return {
      custom: async () => {
        counter.scans += 1;
        return agentDir;
      },
      builtIn: async () => agentDir,
      builtInToolUse: async () => agentDir,
    };
  }

  beforeAll(async () => {
    agentDir = await makeTempDir('texra-load-state-', tempDirs);
    await writeFile(
      path.join(agentDir, 'stateProbe.yaml'),
      [
        'name: stateProbe',
        'description: Probe agent for load-state tests.',
        'settings:',
        '  agentCategory: toolUse',
        '  tools: []',
        'prompts:',
        '  systemPrompt: Probe.',
        '',
      ].join('\n'),
    );
  });

  it('runs a single scan for loads that start together', async () => {
    const counter = { scans: 0 };
    await installDirectories(countingDirectories(counter));
    await Effect.runPromise(refresh({ includeRemote: false }));
    counter.scans = 0;

    await Promise.all([
      Effect.runPromise(loadAgents({ includeRemote: true })),
      Effect.runPromise(loadAgents({ includeRemote: true })),
    ]);

    assert.strictEqual(counter.scans, 1);
    assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');
  });

  it('keeps serving the published catalog when a refresh fails', async () => {
    const counter = { scans: 0 };
    await installDirectories(countingDirectories(counter));
    await Effect.runPromise(refresh({ includeRemote: false }));
    assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');

    const scanFailure = new Error('agent directory unavailable');
    await installDirectories({
      custom: async () => {
        throw scanFailure;
      },
      builtIn: async () => agentDir,
      builtInToolUse: async () => agentDir,
    });

    await assert.rejects(
      Effect.runPromise(refresh({ includeRemote: false })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.message, scanFailure.message);
        return true;
      },
    );

    // A failed rebuild leaves the previously published catalog in place.
    assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');
  });
});
