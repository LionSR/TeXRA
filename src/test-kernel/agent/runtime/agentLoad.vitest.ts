import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
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
import {
  AgentDirectoriesFailed,
  type AgentDirectoriesPort,
} from '@platform/interfaces';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { AgentCategory } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import {
  nodePlatformLayer,
  unusedGlobalStorageFs,
} from '@test/support/fsTestUtils';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

/**
 * A program over the process's global storage view. Nothing under test here
 * reads it: the fake agent directories answer `custom()` themselves, so this
 * only satisfies the requirement the catalog readers name.
 */
function onGlobalStorage<A, E>(
  program: Effect.Effect<A, E, GlobalStorageFs | FileSystem.FileSystem>,
): Effect.Effect<A, E> {
  return Effect.provide(
    program,
    Layer.merge(unusedGlobalStorageFs(), nodePlatformLayer),
  );
}

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
  // The loader reads its YAML through the process filesystem, so the
  // definitions under test are real files in a temp directory of this
  // suite's own rather than an intercepted read.
  let definitionDir = '';

  function putYaml(entry: AgentEntry, lines: string[]): void {
    writeFileSync(entry.path, lines.join('\n'));
  }

  function customEntry(name: string, category: AgentCategory): AgentEntry {
    const definitionPath = path.join(definitionDir, `${name}.yaml`);
    return { source: 'custom', name, path: definitionPath, category };
  }

  /** The loader on the process filesystem it reads its definitions through. */
  const loadDefinition = (entry: AgentEntry) =>
    loadAgentSettingAndPrompts(entry).pipe(Effect.provide(nodePlatformLayer));

  beforeAll(async () => {
    definitionDir = await makeTempDir('texra-agent-load-', tempDirs);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect('loads settings and prompts from the given definition path', () =>
    Effect.gen(function* () {
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

      const [, prompts] = yield* loadDefinition(entry);

      assert.strictEqual(prompts.userRequest, 'unified variant');
    }),
  );

  it.effect(
    'rejects with a wrapped error naming the path for malformed YAML',
    () =>
      Effect.gen(function* () {
        const entry = customEntry('broken', AgentCategory.Workflow);

        writeFileSync(entry.path, 'name: "unterminated\n');

        const error = yield* Effect.flip(loadDefinition(entry));
        assert.ok(
          error.message.startsWith(`Failed to parse YAML at ${entry.path}:`),
        );
      }),
  );

  it.effect(
    'rejects a circular "inherits" chain instead of recursing without bound',
    () =>
      Effect.gen(function* () {
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

        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof import('@agent/index')>('@agent/index'),
        );
        const getAgentMock = vi.mocked(getAgent);
        // This is a plain vi.fn(actual.getAgent), not a spy, so restore the
        // real implementation explicitly — as a finalizer, since a failing
        // yield* never resumes a `finally` in the generator.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => getAgentMock.mockImplementation(actual.getAgent)),
        );
        getAgentMock.mockImplementation(
          (identifier: string) => entryByName[identifier.split(':').pop()!],
        );

        const error = yield* Effect.flip(loadDefinition(entryA));
        assert.ok(
          error.message.startsWith('Circular "inherits" chain detected:'),
        );
      }),
  );
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
      custom: () =>
        Effect.sync(() => {
          counter.scans += 1;
          return agentDir;
        }),
      builtIn: () => Effect.sync(() => agentDir),
      builtInToolUse: () => Effect.sync(() => agentDir),
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

  it.effect('runs a single scan for loads that start together', () =>
    Effect.gen(function* () {
      const counter = { scans: 0 };
      yield* Effect.promise(() =>
        installDirectories(countingDirectories(counter)),
      );
      yield* onGlobalStorage(refresh({ includeRemote: false }));
      counter.scans = 0;

      yield* Effect.all(
        [
          onGlobalStorage(loadAgents({ includeRemote: true })),
          onGlobalStorage(loadAgents({ includeRemote: true })),
        ],
        { concurrency: 'unbounded' },
      );

      assert.strictEqual(counter.scans, 1);
      assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');
    }),
  );

  it.effect('keeps serving the published catalog when a refresh fails', () =>
    Effect.gen(function* () {
      const counter = { scans: 0 };
      yield* Effect.promise(() =>
        installDirectories(countingDirectories(counter)),
      );
      yield* onGlobalStorage(refresh({ includeRemote: false }));
      assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');

      const scanFailure = new Error('agent directory unavailable');
      yield* Effect.promise(() =>
        installDirectories({
          custom: () =>
            Effect.fail(
              new AgentDirectoriesFailed({
                source: 'custom',
                message: scanFailure.message,
                cause: scanFailure,
              }),
            ),
          builtIn: () => Effect.sync(() => agentDir),
          builtInToolUse: () => Effect.sync(() => agentDir),
        }),
      );

      const error = yield* Effect.flip(
        onGlobalStorage(refresh({ includeRemote: false })),
      );
      assert.ok(error instanceof Error);
      assert.strictEqual(error.message, scanFailure.message);

      // A failed rebuild leaves the previously published catalog in place.
      assert.strictEqual(getAgent('custom:stateProbe')?.name, 'stateProbe');
    }),
  );
});
