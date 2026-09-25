// Node imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, FileSystem, Layer } from 'effect';
import { describe } from 'vitest';

// Local imports
import { AgentDirectoryService } from '@agent/index';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  globalStorageFsTestLayer,
  nodePlatformLayer,
  pathExists,
} from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';

const MISSING_CUSTOM_PATH = path.resolve('/texra-missing-parent', 'custom');

class RecordingIssueReporter {
  readonly reports: Array<{ message: string; docsId: string }> = [];

  report(message: string, docsId: string): Effect.Effect<void> {
    return Effect.sync(() => {
      this.reports.push({ message, docsId });
    });
  }
}

const RESOURCES_PATH = path.resolve('/texra-resources');

function createService(customDirectory = ''): {
  service: AgentDirectoryService;
  reporter: RecordingIssueReporter;
} {
  const reporter = new RecordingIssueReporter();
  const service = new AgentDirectoryService({
    channel: 'AgentDirectoryServiceTest',
    resourcesPath: RESOURCES_PATH,
    customDirectoryStore: {
      get: () => Effect.succeed(customDirectory),
    },
    issueReporter: reporter,
  });

  return { service, reporter };
}

describe('AgentDirectoryService', () => {
  const tempDirs = useTempDirs();

  setupPlatform(() => createTempDirPlatform('texra-agent-dirs-', tempDirs));

  function storageBase(): string {
    return testWorkspaceRoots().globalStorage;
  }

  /** The service's readers over the process's global storage view, which the
   *  process runtime serves and this suite provides for `runPromise`. */
  function runDirectories<A, E>(
    program: Effect.Effect<A, E, GlobalStorageFs | FileSystem.FileSystem>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.provide(
        program,
        Layer.merge(globalStorageFsTestLayer(storageBase()), nodePlatformLayer),
      ),
    );
  }

  it('uses a configured absolute custom directory with an existing parent', async () => {
    const parentDir = await makeTempDir('texra-agent-parent-', tempDirs);
    const customPath = path.join(parentDir, 'custom');
    const { service, reporter } = createService(customPath);

    assert.equal(await runDirectories(service.custom()), customPath);
    assert.equal(await pathExists(customPath), true);
    assert.equal(
      await pathExists(path.join(storageBase(), 'custom_agents')),
      false,
    );
    assert.deepEqual(reporter.reports, []);
  });

  it.each([
    {
      name: 'relative configured paths',
      customPath: 'relative/custom',
      message: 'Custom agents directory must be an absolute path',
    },
    {
      name: 'a missing configured parent',
      customPath: MISSING_CUSTOM_PATH,
      message: 'Parent directory for custom agents directory does not exist',
    },
  ])(
    'falls back to the default custom directory for $name',
    async ({ customPath, message }) => {
      const { service, reporter } = createService(customPath);

      assert.equal(
        await runDirectories(service.custom()),
        path.join(storageBase(), 'custom_agents'),
      );
      assert.equal(
        await pathExists(path.join(storageBase(), 'custom_agents')),
        true,
      );
      assert.deepEqual(reporter.reports, [
        { message, docsId: 'custom-agents' },
      ]);
    },
  );

  it('returns local directories in source-priority order', async () => {
    const parentDir = await makeTempDir('texra-agent-parent-', tempDirs);
    const customPath = path.join(parentDir, 'custom');
    const { service } = createService(customPath);

    assert.deepEqual(await runDirectories(service.getAllLocal()), [
      { directory: customPath, source: 'custom' },
      {
        directory: path.join(RESOURCES_PATH, 'agents'),
        source: 'builtInWorkflow',
      },
      {
        directory: path.join(RESOURCES_PATH, 'tool_use_agents'),
        source: 'builtInToolUse',
      },
    ]);
  });
});
