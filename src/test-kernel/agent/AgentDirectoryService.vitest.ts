// Node imports
import { strict as assert } from 'node:assert';
import * as path from 'node:path';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { AgentDirectoryService } from '@agent/index';
import type {
  AbsoluteDirectoryAccess,
  AgentDirectoryIssueReporter,
  AgentDirectoryPathStorage,
  AgentDirectoryServiceLogger,
} from '@agent/index/AgentDirectoryService';

const STORAGE_BASE_PATH = path.resolve('/global-storage');
const VALID_PARENT_PATH = path.resolve('/valid-parent');
const VALID_CUSTOM_PATH = path.join(VALID_PARENT_PATH, 'custom');
const MISSING_CUSTOM_PATH = path.join('/missing', 'custom');

class RecordingStorage implements AgentDirectoryPathStorage {
  readonly ensured: string[] = [];

  constructor(private readonly basePath: string) {}

  async ensureDir(relativePath: string): Promise<void> {
    this.ensured.push(relativePath);
  }

  fullPath(relativePath: string): string {
    return path.join(this.basePath, relativePath);
  }
}

class RecordingAbsoluteDirectories implements AbsoluteDirectoryAccess {
  readonly ensured: string[] = [];

  constructor(private readonly existingPaths: ReadonlySet<string>) {}

  async exists(absolutePath: string): Promise<boolean> {
    return this.existingPaths.has(absolutePath);
  }

  async ensureDir(absolutePath: string): Promise<void> {
    this.ensured.push(absolutePath);
  }
}

class RecordingIssueReporter implements AgentDirectoryIssueReporter {
  readonly reports: Array<{ message: string; docsId: string }> = [];

  async report(message: string, docsId: string): Promise<void> {
    this.reports.push({ message, docsId });
  }
}

class RecordingLogger implements AgentDirectoryServiceLogger {
  readonly debugMessages: string[] = [];
  readonly errorMessages: string[] = [];

  debug(message: string): void {
    this.debugMessages.push(message);
  }

  error(message: string): void {
    this.errorMessages.push(message);
  }
}

function createService(customDirectory = ''): {
  service: AgentDirectoryService;
  storage: RecordingStorage;
  absoluteDirectories: RecordingAbsoluteDirectories;
  reporter: RecordingIssueReporter;
} {
  const storage = new RecordingStorage(STORAGE_BASE_PATH);
  const reporter = new RecordingIssueReporter();
  const absoluteDirectories = new RecordingAbsoluteDirectories(
    new Set([VALID_PARENT_PATH]),
  );
  const logger = new RecordingLogger();
  const service = new AgentDirectoryService({
    storage,
    customDirectoryStore: {
      get: () => customDirectory,
    },
    absoluteDirectories,
    issueReporter: reporter,
    logger,
  });

  return { service, storage, absoluteDirectories, reporter };
}

describe('AgentDirectoryService', () => {
  it('resolves built-in directories from writable storage', async () => {
    const { service, storage } = createService();

    assert.equal(
      await service.builtIn(),
      path.join(STORAGE_BASE_PATH, 'agents'),
    );
    assert.equal(
      await service.builtInToolUse(),
      path.join(STORAGE_BASE_PATH, 'tool_use_agents'),
    );
    assert.deepEqual(storage.ensured, ['agents', 'tool_use_agents']);
  });

  it('uses the default custom directory when no custom path is configured', async () => {
    const { service, storage } = createService('   ');

    assert.equal(
      await service.custom(),
      path.join(STORAGE_BASE_PATH, 'custom_agents'),
    );
    assert.deepEqual(storage.ensured, ['custom_agents']);
  });

  it('uses a configured absolute custom directory with an existing parent', async () => {
    const { service, storage, absoluteDirectories, reporter } =
      createService(VALID_CUSTOM_PATH);

    assert.equal(await service.custom(), VALID_CUSTOM_PATH);
    assert.deepEqual(storage.ensured, []);
    assert.deepEqual(absoluteDirectories.ensured, [VALID_CUSTOM_PATH]);
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
      const { service, storage, reporter } = createService(customPath);

      assert.equal(
        await service.custom(),
        path.join(STORAGE_BASE_PATH, 'custom_agents'),
      );
      assert.deepEqual(storage.ensured, ['custom_agents']);
      assert.deepEqual(reporter.reports, [
        { message, docsId: 'custom-agents' },
      ]);
    },
  );

  it('returns local directories in source-priority order', async () => {
    const { service } = createService(VALID_CUSTOM_PATH);

    assert.deepEqual(await service.getAllLocal(), [
      { directory: VALID_CUSTOM_PATH, source: 'custom' },
      {
        directory: path.join(STORAGE_BASE_PATH, 'agents'),
        source: 'builtInWorkflow',
      },
      {
        directory: path.join(STORAGE_BASE_PATH, 'tool_use_agents'),
        source: 'builtInToolUse',
      },
    ]);
  });

  it('does not resolve a local directory for remote agents', async () => {
    const { service } = createService();

    assert.equal(await service.getDirectory('remote'), undefined);
  });
});
