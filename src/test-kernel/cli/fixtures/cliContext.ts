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
