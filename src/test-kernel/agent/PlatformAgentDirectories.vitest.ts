// Node imports
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { platform } from '@platform/platform';
import {
  fakeProcessServices,
  setupPlatform,
} from '@test/support/setupPlatform';
import {
  createTempDirPlatform,
  makeTempDir,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { GlobalStorageFS } from '@utils/files/storageFS';

const SYNC_MARKER_FILE = '.bundled-agent-sync.json';
const VERSION_STATE_KEY = 'lastKnownVersion';

const logs = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@logger/logUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@logger/logUtils')>();
  return { ...actual, createLog: () => logs };
});

const { bootstrapPlatformAgentDirectories } =
  await import('@agent/index/platformAgentDirectories');

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

describe('bootstrapPlatformAgentDirectories', () => {
  const tempDirs = useTempDirs();
  let resourcesPath: string;

  setupPlatform(() => createTempDirPlatform('texra-agent-sync-', tempDirs));

  beforeEach(async () => {
    vi.clearAllMocks();
    resourcesPath = join(
      await makeTempDir('texra-agent-bundle-', tempDirs),
      'resources',
    );
    await Promise.all([
      writeText(join(resourcesPath, 'agents', 'writer.yaml'), 'name: writer\n'),
      writeText(
        join(resourcesPath, 'tool_use_agents', 'researcher.yaml'),
        'name: researcher\n',
      ),
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The bootstrap program over the fake host's process services: the suite
   *  runs it on the `it.effect` runtime, not a process runtime. */
  function bootstrap(currentVersion: string | undefined = '1.0.0') {
    return Effect.provide(
      bootstrapPlatformAgentDirectories({
        channel: 'test',
        resourcesPath,
        currentVersion,
        versionStateKey: VERSION_STATE_KEY,
      }),
      fakeProcessServices(),
    );
  }

  it.effect("adopts a sibling process's recent sync instead of copying", () =>
    Effect.gen(function* () {
      const copy = vi.spyOn(platform().fs, 'copy');
      yield* Effect.promise(() =>
        writeText(
          GlobalStorageFS.fullPath(SYNC_MARKER_FILE),
          // `it.effect` starts the TestClock at 0, so a marker stamped 0 is
          // "moments ago" to the recency window.
          `${JSON.stringify({
            completedAt: 0,
            ownerPid: process.pid + 1,
            version: '1.0.0',
          })}\n`,
        ),
      );

      expect(yield* bootstrap('1.0.0')).toBe(true);

      expect(copy).not.toHaveBeenCalled();
      expect(platform().globalState.get<string>(VERSION_STATE_KEY)).toBe(
        '1.0.0',
      );
    }),
  );

  it.effect('does not fail reconciliation when the marker write fails', () =>
    Effect.gen(function* () {
      const copy = vi.spyOn(platform().fs, 'copy').mockResolvedValue(undefined);
      const writeFileImpl = platform().fs.writeFile.bind(platform().fs);
      vi.spyOn(platform().fs, 'writeFile').mockImplementation(
        async (target, content) => {
          if (target.endsWith(SYNC_MARKER_FILE)) {
            throw new Error('marker unwritable');
          }
          await writeFileImpl(target, content);
        },
      );

      yield* bootstrap();

      expect(copy).toHaveBeenCalledTimes(2);
      expect(platform().globalState.get<string>(VERSION_STATE_KEY)).toBe(
        '1.0.0',
      );
      expect(logs.warn).toHaveBeenCalledWith(
        'Failed to write bundled agent sync marker: marker unwritable',
      );
      expect(logs.error).not.toHaveBeenCalled();
    }),
  );

  it.effect('reports a copy failure without aborting host startup', () =>
    Effect.gen(function* () {
      vi.spyOn(platform().fs, 'copy').mockRejectedValue(
        new Error('copy failed'),
      );

      expect(yield* bootstrap()).toBe(false);

      expect(logs.error).toHaveBeenCalledWith(
        expect.stringContaining('copy failed'),
      );
    }),
  );
});
