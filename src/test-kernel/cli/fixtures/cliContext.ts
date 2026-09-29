import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { CliContext } from '@cli/runtime/cliContext';
import { MemoryConfigProvider } from '@platform/defaults/memoryConfigProvider';

/**
 * This test file's own storage root, removed when the file finishes. A fixed
 * path was shared with every other checkout on the machine, so a store a
 * newer build wrote there (a later event format) failed the next run here.
 */
export const testStorageRoot = mkdtempSync(
  join(tmpdir(), 'texra-test-storage-'),
);
afterAll(() => rmSync(testStorageRoot, { recursive: true, force: true }));

const BASE_CLI_CONTEXT = {
  storageRoot: testStorageRoot,
  cwd: '/tmp/project',
  mode: 'headless',
  outputFormat: 'text',
  approvalPolicy: 'never',
  quietLogs: false,
  minimumLogLevel: 'Info' as const,
  stdoutIsTty: false,
  termIsDumb: false,
  stderrIsTty: false,
  stdoutColorEnabled: false,
  stderrColorEnabled: false,
  commandName: 'texra',
  version: '0.0.0',
  resourcesPath: '/tmp/resources',
  config: new MemoryConfigProvider(),
  configWarnings: [],
  configDegradations: [],
  skillSourceOptions: {},
} satisfies CliContext;

/** Creates a complete post-normalization CLI context for tests. */
export function createTestCliContext(
  overrides: Partial<CliContext> = {},
): CliContext {
  return { ...BASE_CLI_CONTEXT, ...overrides };
}

/**
 * The run-command suites' shared default: progress rendering on, everything
 * else at the base defaults.
 */
export function createRunCommandCliContext(
  overrides: Partial<CliContext> = {},
): CliContext {
  return createTestCliContext({ renderRunProgress: true, ...overrides });
}

/**
 * The TUI host-interaction suites' shared interactive context: an interactive
 * `ask`-policy session against the conventional `/work` + `/resources` paths.
 */
export function createTuiCliContext(
  overrides: Partial<CliContext> = {},
): CliContext {
  return createTestCliContext({
    cwd: '/work',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    resourcesPath: '/resources',
    ...overrides,
  });
}
