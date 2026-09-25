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
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { REPO_ROOT } from '@test/support/repoScan';
import { installedHost, setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { testRuntime } from '@test/support/testProcessRuntime';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  installCliProcessRuntime: vi.fn(),
  readCliAgentRoster: vi.fn(),
  setWorkspaceCliChatAgent: vi.fn(() => Effect.void),
}));

vi.mock('@cli/runtime/initPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/initPlatform')>()),
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/cliProcessRuntime', async () => ({
  installCliProcessRuntime: mocks.installCliProcessRuntime,
  disposeCliProcessRuntime: Effect.void,
}));

vi.mock('@cli/runtime/agentRoster', () => ({
  formatCliAgentRoster: () => 'Agent roster',
  readCliAgentRoster: () => Effect.promise(() => mocks.readCliAgentRoster()),
}));

vi.mock('@cli/runtime/cliConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/cliConfig')>()),
  setWorkspaceCliChatAgent: mocks.setWorkspaceCliChatAgent,
}));

const { runCli } = await import('@cli/commands/root');

const tempDirs = useTempDirs();

// The roster controller runs real over the bundled catalogs: the installed
// host's agent directories are the repo's resources, with an empty custom dir
// standing in for a workspace without custom agents.
let customAgentsDir: string;

const bundledAgentDirectories = () => ({
  custom: () => Effect.succeed(customAgentsDir),
  builtIn: () =>
    Effect.succeed(path.join(REPO_ROOT, 'packages/extension/resources/agents')),
  builtInToolUse: () =>
    Effect.succeed(
      path.join(REPO_ROOT, 'packages/extension/resources/tool_use_agents'),
    ),
});

beforeAll(async () => {
  customAgentsDir = await makeTempDir('texra-config-agents-', tempDirs);
});

setupPlatform({}, { agentDirectories: bundledAgentDirectories() });

/** The selection the real roster controller last persisted. */
function readSelection(): Promise<unknown> {
  return Effect.runPromise(
    installedHost().roots.workspaceState.get(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
    ),
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
      host.roots.workspaceState.update(
        WorkspaceStateKey.AGENT_ROSTER_SELECTION,
        undefined,
      ),
    );
    mocks.initCliPlatform.mockReturnValue(
      Effect.succeed({ runtime: testRuntime(), roots: host.roots }),
    );
    mocks.installCliProcessRuntime.mockImplementation(async () =>
      testRuntime(),
    );
    mocks.readCliAgentRoster.mockResolvedValue({
      selection: { kind: 'all' },
      effectiveSelection: { kind: 'all' },
      workflowAgentKeys: [],
      toolUseAgentKeys: [],
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

  it.each([
    ['workflow', '--workflow', ['builtInWorkflow:write', 'custom:review']],
    ['toolUse', '--tool-use', ['builtInToolUse:assistant', 'custom:review']],
  ] as const)(
    'changes only the %s category when the other list is omitted',
    async (category, flag, keys) => {
      const result = await runCli([
        'config',
        'agents',
        flag,
        keys.join(','),
        '--output-format',
        'json',
        '--no-input',
      ]);

      expect(result.exitCode).toBe(0);
      expect(await readSelection()).toEqual({
        kind: 'custom',
        agentKeys: {
          workflow: category === 'workflow' ? keys : 'all',
          toolUse: category === 'toolUse' ? keys : 'all',
        },
      });
    },
  );

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
      // The real roster controller owns the refusal; its message names the
      // value the command passed through.
      expect(stderr).toContain(message);
      expect(await readSelection()).toBeUndefined();
    },
  );

  it('canonicalizes a default chat agent from the effective roster', async () => {
    const result = await runCli([
      'config',
      'agents',
      '--default-agent',
      'assistant',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(0);
    // The write also carries the command's setting stores; the assertion pins
    // the canonicalized agent key.
    expect(mocks.setWorkspaceCliChatAgent).toHaveBeenCalledWith(
      expect.anything(),
      'builtInToolUse:assistant',
    );
  });

  it('rejects a default chat agent outside the effective roster', async () => {
    const result = await runCli([
      'config',
      'agents',
      '--default-agent',
      'missing-agent',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(2);
    expect(stderr).toContain(
      'Default chat agent "missing-agent" is not in the effective workspace roster.',
    );
    expect(mocks.setWorkspaceCliChatAgent).not.toHaveBeenCalled();
  });
});
