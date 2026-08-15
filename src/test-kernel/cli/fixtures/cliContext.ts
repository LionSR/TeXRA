// Local imports - CLI runtime
import type { CliContext } from '@cli/runtime/cliContext';

const BASE_CLI_CONTEXT = {
  cwd: '/tmp/project',
  mode: 'headless',
  outputFormat: 'text',
  approvalPolicy: 'never',
  quietLogs: false,
  stdoutIsTty: false,
  termIsDumb: false,
  stderrIsTty: false,
  stdoutColorEnabled: false,
  stderrColorEnabled: false,
  commandName: 'texra',
  version: '0.0.0',
  resourcesPath: '/tmp/resources',
  cliConfig: {},
  configWarnings: [],
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
