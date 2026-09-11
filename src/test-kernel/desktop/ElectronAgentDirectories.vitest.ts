// Node imports
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';
import { inquiryRecordsLayer } from '@controllers/session/inquiryRecords';

// Local imports
import { NO_TOOL_AVAILABILITY_HOST } from '@platform/interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import type {
  AgentDirectoriesPort,
  StorageProvider,
} from '@platform/interfaces';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import type { JsonStore } from '@platform/defaults/jsonStore';
import type { NodeAgentDirectoryBootstrapOptions } from '@platform/defaults/nodeHost';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { nodeFileLocks } from '@platform/defaults/fileLocks';
import { nodeHostEnvironment } from '@platform/defaults/nodeHostEnvironment';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { UpdateCheckRecords } from '@shared/session/updateCheckRecords';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { testHttpClientLayer } from '@test/support/fetchTestUtils';
import { FakeConfigProvider, FakeSecrets } from '@test/support/FakePlatform';
import { writeSkill } from '@test/support/skillFixtures';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

import { loadSourceModule } from './loadSourceModule.ts';

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

interface AgentDirectoryHarness {
  bootstrapNodeAgentDirectories: (
    options: NodeAgentDirectoryBootstrapOptions,
  ) => Effect.Effect<void>;
  agentDirectories: AgentDirectoriesPort;
  globalStateStore: JsonStore;
  resourcesPath: string;
  storage: StorageProvider;
}

describe('desktop agent directory bootstrap', () => {
  const tempDirs = useTempDirs();

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function createHarness(): Effect.Effect<AgentDirectoryHarness, unknown> {
    return Effect.gen(function* () {
      vi.resetModules();
      const tempDir = yield* Effect.promise(() =>
        makeTempDir('texra-electron-agents-', tempDirs),
      );
      const resourcesPath = join(tempDir, 'resources');
      const userDataPath = join(tempDir, 'userData');
      const workspacePath = join(tempDir, 'workspace');
      yield* Effect.promise(() =>
        Promise.all([
          writeText(
            join(resourcesPath, 'agents', 'writer.yaml'),
            'name: writer\n',
          ),
          writeText(
            join(resourcesPath, 'tool_use_agents', 'researcher.yaml'),
            'name: researcher\n',
          ),
          mkdir(join(resourcesPath, 'skills'), { recursive: true }),
          mkdir(workspacePath, { recursive: true }),
        ]),
      );

      const [
        { JsonStore },
        { bootstrapNodeAgentDirectories: bootstrapEffect },
        { initPlatform, platform },
        { initProcessWorkspaceRoots },
        { createPlatformAgentDirectories },
        { effectRuntime, initProcessRuntime },
      ] = yield* Effect.promise(() =>
        Promise.all([
          loadSourceModule('@platform/defaults/jsonStore'),
          loadSourceModule('@platform/defaults/nodeHost'),
          import('@platform/platform'),
          import('@platform/workspaceRoots'),
          import('@agent/index/platformAgentDirectories'),
          import('@platform/processRuntime'),
        ]),
      );
      const storage = new WorkspaceStorageProvider(userDataPath, workspacePath);
      // The desktop entry installs the process runtime before it opens a store;
      // this harness stands in for that entry, so it installs a bare one.
      try {
        effectRuntime();
      } catch {
        initProcessRuntime(
          ManagedRuntime.make(
            Layer.mergeAll(
              testHttpClientLayer,
              Layer.mock(UpdateCheckRecords, {}),
              inquiryRecordsLayer(() => storage.getGlobalStoragePath()).pipe(
                Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
              ),
            ),
          ),
        );
      }
      const [globalStateStore, workspaceStateStore] = yield* Effect.all([
        JsonStore.open(join(userDataPath, 'state', 'global.json')),
        JsonStore.open(join(storage.getStoragePath(), 'state.json')),
      ]);

      initPlatform({
        globalState: globalStateStore,
        fs: nodeFilesystem,
        storage,
        fileLocks: nodeFileLocks,
        processes: nodeProcesses,
        hostEnvironment: nodeHostEnvironment,
        secrets: new FakeSecrets(),
        lifecycle: createLifecycleHost(),
        agentResume: { tryResumeRun: async () => false },
        agentDirectories: createPlatformAgentDirectories({
          channel: 'test',
          customDirectoryStore: {
            get: () =>
              globalStateStore.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR),
          },
        }),
        languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
        toolAvailability: NO_TOOL_AVAILABILITY_HOST,
        toolMissingHandler: () => {},
      });
      initProcessWorkspaceRoots({
        workspace: workspacePath,
        storage: storage.getStoragePath(),
        config: new FakeConfigProvider(),
        workspaceState: workspaceStateStore,
      });

      return {
        // The desktop entry runs this program on the process runtime; the
        // harness hands the Effect to the test, which runs it on its own
        // @effect/vitest runtime instead.
        bootstrapNodeAgentDirectories: (
          options: NodeAgentDirectoryBootstrapOptions,
        ) => bootstrapEffect(options),
        agentDirectories: platform().agentDirectories,
        globalStateStore,
        resourcesPath,
        storage,
      };
    });
  }

  it.effect(
    'copies bundled agents into fresh userData storage and registers directory access',
    () =>
      Effect.gen(function* () {
        const {
          agentDirectories,
          bootstrapNodeAgentDirectories,
          globalStateStore,
          resourcesPath,
          storage,
        } = yield* createHarness();

        yield* bootstrapNodeAgentDirectories({
          channel: 'desktop',
          resourcesPath,
          currentVersion: '1.2.3',
          versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
        });

        const builtInDir = yield* Effect.promise(() =>
          agentDirectories.builtIn(),
        );
        const toolUseDir = yield* Effect.promise(() =>
          agentDirectories.builtInToolUse(),
        );

        expect(builtInDir).toBe(join(storage.getGlobalStoragePath(), 'agents'));
        expect(toolUseDir).toBe(
          join(storage.getGlobalStoragePath(), 'tool_use_agents'),
        );
        expect(
          yield* Effect.promise(() =>
            readFile(join(builtInDir, 'writer.yaml'), 'utf8'),
          ),
        ).toBe('name: writer\n');
        expect(
          yield* Effect.promise(() =>
            readFile(join(toolUseDir, 'researcher.yaml'), 'utf8'),
          ),
        ).toBe('name: researcher\n');
        expect(globalStateStore.get(GlobalStateKey.LAST_KNOWN_VERSION)).toBe(
          '1.2.3',
        );
      }),
  );

  it.effect(
    'skips same-resource re-entry but refreshes when the resource path changes',
    () =>
      Effect.gen(function* () {
        const { bootstrapNodeAgentDirectories, resourcesPath, storage } =
          yield* createHarness();
        const options = {
          channel: 'desktop',
          resourcesPath,
          currentVersion: '1.2.3',
          versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
        };

        yield* bootstrapNodeAgentDirectories(options);
        const copiedAgent = join(
          storage.getGlobalStoragePath(),
          'agents',
          'writer.yaml',
        );
        yield* Effect.promise(() =>
          writeFile(copiedAgent, 'name: locally-edited\n'),
        );

        yield* bootstrapNodeAgentDirectories(options);
        expect(yield* Effect.promise(() => readFile(copiedAgent, 'utf8'))).toBe(
          'name: locally-edited\n',
        );

        const nextResourcesPath = join(
          dirname(resourcesPath),
          'resources-next',
        );
        yield* Effect.promise(() =>
          writeText(
            join(nextResourcesPath, 'agents', 'writer.yaml'),
            'name: next\n',
          ),
        );
        yield* Effect.promise(() =>
          writeText(
            join(nextResourcesPath, 'tool_use_agents', 'researcher.yaml'),
            'name: researcher\n',
          ),
        );

        yield* bootstrapNodeAgentDirectories({
          ...options,
          resourcesPath: nextResourcesPath,
          currentVersion: '1.2.4',
        });
        expect(yield* Effect.promise(() => readFile(copiedAgent, 'utf8'))).toBe(
          'name: next\n',
        );
      }),
  );

  it.effect(
    'retries a failed reconcile and guards the resource path after success',
    () =>
      Effect.gen(function* () {
        const { bootstrapNodeAgentDirectories, resourcesPath, storage } =
          yield* createHarness();
        const copy = vi
          .spyOn(nodeFilesystem, 'copy')
          .mockRejectedValueOnce(new Error('copy failed'));
        const options = {
          channel: 'desktop',
          resourcesPath,
          currentVersion: '1.2.3',
          versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
        };

        yield* bootstrapNodeAgentDirectories(options);
        expect(copy).toHaveBeenCalledOnce();

        yield* bootstrapNodeAgentDirectories(options);
        expect(copy).toHaveBeenCalledTimes(3);

        const copiedAgent = join(
          storage.getGlobalStoragePath(),
          'agents',
          'writer.yaml',
        );
        yield* Effect.promise(() =>
          writeFile(copiedAgent, 'name: locally-edited\n'),
        );

        yield* bootstrapNodeAgentDirectories(options);
        expect(copy).toHaveBeenCalledTimes(3);
        expect(yield* Effect.promise(() => readFile(copiedAgent, 'utf8'))).toBe(
          'name: locally-edited\n',
        );
      }),
  );

  it.live('coalesces concurrent bootstraps for the same resource path', () =>
    Effect.gen(function* () {
      const { bootstrapNodeAgentDirectories, resourcesPath } =
        yield* createHarness();
      const copy = vi
        .spyOn(nodeFilesystem, 'copy')
        .mockResolvedValue(undefined);
      const options = {
        channel: 'desktop',
        resourcesPath,
        currentVersion: '1.2.3',
        versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
      };

      yield* Effect.all(
        [
          bootstrapNodeAgentDirectories(options),
          bootstrapNodeAgentDirectories(options),
        ],
        { concurrency: 'unbounded' },
      );

      expect(copy).toHaveBeenCalledTimes(2);
    }),
  );

  it.live('runs a queued bootstrap after its predecessor rejects', () =>
    Effect.gen(function* () {
      const { bootstrapNodeAgentDirectories, resourcesPath } =
        yield* createHarness();
      const copy = vi
        .spyOn(nodeFilesystem, 'copy')
        .mockResolvedValue(undefined);
      const first = yield* Effect.forkChild(
        Effect.exit(
          bootstrapNodeAgentDirectories({
            channel: 'desktop',
            get resourcesPath(): string {
              throw new Error('unexpected bootstrap failure');
            },
            currentVersion: '1.2.3',
            versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
          }),
        ),
      );
      const second = yield* Effect.forkChild(
        bootstrapNodeAgentDirectories({
          channel: 'desktop',
          resourcesPath,
          currentVersion: '1.2.3',
          versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
        }),
      );

      const firstExit = yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(Exit.isFailure(firstExit)).toBe(true);
      if (Exit.isFailure(firstExit)) {
        expect(Cause.pretty(firstExit.cause)).toContain(
          'unexpected bootstrap failure',
        );
      }
      expect(copy).toHaveBeenCalledTimes(2);
    }),
  );

  it.live('serializes overlapping resource paths in request order', () =>
    Effect.gen(function* () {
      const { bootstrapNodeAgentDirectories, resourcesPath } =
        yield* createHarness();
      const nextResourcesPath = join(dirname(resourcesPath), 'resources-next');
      let releaseFirstCopy!: () => void;
      const firstCopyBlocked = new Promise<void>((resolve) => {
        releaseFirstCopy = resolve;
      });
      const copiedSources: string[] = [];
      vi.spyOn(nodeFilesystem, 'copy').mockImplementation(async (source) => {
        copiedSources.push(source);
        if (copiedSources.length === 1) await firstCopyBlocked;
      });
      const withFileLock = vi
        .spyOn(nodeFileLocks, 'withFileLock')
        .mockImplementation(() => (self) => self);
      const first = yield* Effect.forkChild(
        bootstrapNodeAgentDirectories({
          channel: 'desktop',
          resourcesPath,
          currentVersion: '1.2.3',
          versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
        }),
      );
      yield* Effect.promise(() =>
        vi.waitFor(() => expect(copiedSources).toHaveLength(1)),
      );
      const secondOptions = {
        channel: 'desktop',
        resourcesPath: nextResourcesPath,
        currentVersion: '1.2.4',
        versionStateKey: GlobalStateKey.LAST_KNOWN_VERSION,
      };
      const second = yield* Effect.forkChild(
        bootstrapNodeAgentDirectories(secondOptions),
      );

      yield* Effect.promise(() => nextTurn());
      expect(withFileLock).toHaveBeenCalledOnce();
      expect(copiedSources).toEqual([join(resourcesPath, 'agents')]);

      releaseFirstCopy();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(copiedSources).toEqual([
        join(resourcesPath, 'agents'),
        join(resourcesPath, 'tool_use_agents'),
        join(nextResourcesPath, 'agents'),
        join(nextResourcesPath, 'tool_use_agents'),
      ]);

      yield* bootstrapNodeAgentDirectories(secondOptions);
      expect(copiedSources).toHaveLength(4);
    }),
  );

  it.effect(
    'registers runtime skills through the shared Node host defaults',
    () =>
      Effect.gen(function* () {
        const { resourcesPath } = yield* createHarness();
        // Project sources resolve from the process workspace the harness installed.
        const projectPath = join(dirname(resourcesPath), 'workspace');
        yield* Effect.promise(() =>
          Promise.all([
            writeSkill(join(resourcesPath, 'skills'), 'bundled-skill', {
              name: 'bundled-skill',
              description: 'Bundled skill.',
            }),
            writeSkill(join(projectPath, '.texra', 'skills'), 'project-skill', {
              name: 'project-skill',
              description: 'Project skill.',
            }),
            writeSkill(join(projectPath, '.codex', 'skills'), 'interop-skill', {
              name: 'interop-skill',
              description: 'Interop skill.',
            }),
            writeSkill(join(projectPath, 'vendor', 'skills'), 'custom-skill', {
              name: 'custom-skill',
              description: 'Custom skill.',
            }),
          ]),
        );
        const { initializeNodeRuntimeSkills } = yield* Effect.promise(() =>
          loadSourceModule('@platform/defaults/nodeHost'),
        );
        const { loadRuntimeSkillDisplay } = yield* Effect.promise(
          () => import('@skills/runtimeSkills'),
        );

        initializeNodeRuntimeSkills({
          resourcesPath,
          skillSourceOptions: {
            includeInterop: true,
            additionalPaths: ['vendor/skills'],
          },
        });

        const { skills } = yield* Effect.promise(() =>
          loadRuntimeSkillDisplay(),
        );
        expect(skills).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: 'custom-skill',
              scope: 'custom',
            }),
            expect.objectContaining({
              name: 'project-skill',
              scope: 'project',
            }),
            expect.objectContaining({
              name: 'interop-skill',
              scope: 'interop',
            }),
            expect.objectContaining({
              name: 'bundled-skill',
              scope: 'bundled',
            }),
          ]),
        );
      }),
  );
});
