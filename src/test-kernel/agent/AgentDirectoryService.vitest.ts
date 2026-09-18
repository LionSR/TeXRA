// Node imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { describe, it } from 'vitest';

// Local imports
import { AgentDirectoryService, agentSourceDirectory } from '@agent/index';
import type { AgentDirectoryIssueReporter } from '@agent/index/AgentDirectoryService';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { workspaceRoots } from '@platform/workspaceRoots';
import { globalStorageFsTestLayer } from '@test/support/fsTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { AbsoluteFS } from '@utils/files/absoluteFS';

const MISSING_CUSTOM_PATH = path.resolve('/texra-missing-parent', 'custom');

class RecordingIssueReporter implements AgentDirectoryIssueReporter {
  readonly reports: Array<{ message: string; docsId: string }> = [];

  async report(message: string, docsId: string): Promise<void> {
    this.reports.push({ message, docsId });
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
      get: () => customDirectory,
    },
    issueReporter: reporter,
  });

  return { service, reporter };
}

describe('AgentDirectoryService', () => {
  const tempDirs = useTempDirs();

  setupPlatform(() => createTempDirPlatform('texra-agent-dirs-', tempDirs));

  function storageBase(): string {
    return workspaceRoots().globalStorage;
  }

  /** The service's readers over the process's global storage view, which the
   *  process runtime serves and this suite provides for `runPromise`. */
  function runDirectories<A, E>(
    program: Effect.Effect<A, E, GlobalStorageFs>,
  ): Promise<A> {
    return Effect.runPromise(
      Effect.provide(program, globalStorageFsTestLayer(storageBase())),
    );
  }

  it('resolves built-in directories inside the packaged resources', async () => {
    const { service } = createService();

    assert.equal(
      await Effect.runPromise(service.builtIn()),
      path.join(RESOURCES_PATH, 'agents'),
    );
    assert.equal(
      await Effect.runPromise(service.builtInToolUse()),
      path.join(RESOURCES_PATH, 'tool_use_agents'),
    );
    // Packaged content is read in place: nothing is created under storage.
    assert.equal(
      await AbsoluteFS.exists(path.join(storageBase(), 'agents')),
      false,
    );
  });

  it('uses the default custom directory when no custom path is configured', async () => {
    const { service } = createService('   ');

    assert.equal(
      await runDirectories(service.custom()),
      path.join(storageBase(), 'custom_agents'),
    );
    assert.equal(
      await AbsoluteFS.exists(path.join(storageBase(), 'custom_agents')),
      true,
    );
  });

  it('uses a configured absolute custom directory with an existing parent', async () => {
    const parentDir = await makeTempDir('texra-agent-parent-', tempDirs);
    const customPath = path.join(parentDir, 'custom');
    const { service, reporter } = createService(customPath);

    assert.equal(await runDirectories(service.custom()), customPath);
    assert.equal(await AbsoluteFS.exists(customPath), true);
    assert.equal(
      await AbsoluteFS.exists(path.join(storageBase(), 'custom_agents')),
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
        await AbsoluteFS.exists(path.join(storageBase(), 'custom_agents')),
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

  it('does not resolve a local directory for remote agents', async () => {
    const { service } = createService();

    assert.equal(
      await runDirectories(agentSourceDirectory(service, 'remote')),
      undefined,
    );
  });
});
