import * as path from 'node:path';

import { Effect } from 'effect';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { REPO_ROOT } from '@test/support/repoScan';
import { installedHost, setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';

const mocks = vi.hoisted(() => ({
  readCliWorkspaceAgents: vi.fn(),
  setWorkspaceCliChatAgent: vi.fn(() => Effect.void),
}));

vi.mock('@cli/runtime/workspaceAgents', () => ({
  formatCliWorkspaceAgents: () => 'Workspace agents',
  readCliWorkspaceAgents: () =>
    Effect.promise(() => mocks.readCliWorkspaceAgents()),
}));

vi.mock('@cli/runtime/cliConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/cliConfig')>()),
  setWorkspaceCliChatAgent: mocks.setWorkspaceCliChatAgent,
}));

const { runCli } = await import('@cli/commands/root');

const tempDirs = useTempDirs();

// The workspace agents controller runs real over the bundled catalogs: the installed
// host's agent directories are the repo's resources, with an empty custom dir
// standing in for a workspace without custom agents.
let customAgentsDir: string;

const bundledAgentDirectories = () => ({
  custom: () => Effect.succeed(customAgentsDir),
  customConfigured: () => Effect.succeed(false),
  builtIn: () =>
    Effect.succeed(path.join(REPO_ROOT, 'packages/extension/resources/agents')),
});

beforeAll(async () => {
  customAgentsDir = await makeTempDir('texra-config-agents-', tempDirs);
});

setupPlatform({}, { agentDirectories: bundledAgentDirectories() });

// The catalog is loaded over the installed host's agent directories before
// each command runs, as the process runtime does at build, so the one real
// scan's info line lands before the output spies.
beforeEach(async () => {
  const { AgentCatalog } = await import('@agent/index/agentCatalog');
  await testRuntime().runPromise(
    AgentCatalog.use((catalog) => catalog.refresh),
  );
});

/** The selection the real workspace agents controller last persisted. */
function readSelection(): Promise<unknown> {
  return Effect.runPromise(
    installedHost().roots.repoState.get(WorkspaceStateKey.WORKSPACE_AGENTS),
  );
}

describe('CLI config command', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderr = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    stderr = '';
    // The controller reads and writes the installed host's own stores; each
    // test starts from an unset selection.
    const host = installedHost();
    await Effect.runPromise(
      host.roots.repoState.update(
        WorkspaceStateKey.WORKSPACE_AGENTS,
        undefined,
      ),
    );
    cliInitPlatformMock.initCliPlatform.mockReturnValue(
      Effect.succeed({ runtime: testRuntime(), roots: host.roots }),
    );
    cliInitPlatformMock.installCliProcessRuntime.mockImplementation(() =>
      testRuntime(),
    );
    mocks.readCliWorkspaceAgents.mockResolvedValue({
      selection: { kind: 'all' },
      effectiveSelection: { kind: 'all' },
      agentKeys: 'all',
      unresolvedNames: [],
    });
    stdoutSpy = spyOnStreamWrite(process.stdout);
    stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('stores a custom --agents list as the workspace selection', async () => {
    const keys = ['builtIn:write', 'custom:review'];
    const result = await runCli([
      'config',
      'agents',
      '--agents',
      keys.join(','),
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(0);
    expect(await readSelection()).toEqual({ kind: 'custom', agentKeys: keys });
  });

  it.each([
    {
      name: 'team',
      flag: '--team',
      value: 'missing-team',
      message: 'Unknown agent team: missing-team',
    },
    {
      name: 'default team',
      flag: '--default-team',
      value: 'custom-team',
      message: 'Only a built-in team can be the user default: custom-team',
    },
  ])(
    'reports an invalid $name id as a usage error',
    async ({ flag, value, message }) => {
      const result = await runCli([
        'config',
        'agents',
        flag,
        value,
        '--output-format',
        'json',
        '--no-input',
      ]);

      expect(result.exitCode).toBe(2);
      // The real workspace agents controller owns the refusal; its message names the
      // value the command passed through.
      expect(stderr).toContain(message);
      expect(await readSelection()).toBeUndefined();
    },
  );
});
