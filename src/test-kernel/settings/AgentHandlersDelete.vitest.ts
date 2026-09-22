import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, FileSystem } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { withProcessServices } from '@platform/processRuntime';
import { AgentHandlers } from '@settingsView/handlers/agentHandlers';
import type { AgentSource } from '@shared/schemas';
import {
  initTestProcessRuntime,
  testRuntime,
} from '@test/support/testProcessRuntime';
import { bareProcessRuntime } from '@test/support/bareProcessRuntime';
import { installedHost } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  /** The custom agents directory, a real temp path per test. */
  customDirectory: vi.fn(() => ''),
  applySettingsTeamRoster:
    vi.fn<
      typeof import('@controllers/settingsView/SettingsTeamRosterController').applySettingsTeamRoster
    >(),
  getAgent: vi.fn(() => ({ path: '/custom/my-agent.yaml' })),
  getSourceDirectory: vi.fn(
    async (_source: AgentSource) => undefined as string | undefined,
  ),
  logWarn: vi.fn(),
  refreshAfterAgentMutation: vi.fn(() => Effect.void),
  showLoggedMessage: vi.fn(() => Effect.succeed('')),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showTextDocument: vi.fn(),
    showWarningMessage: mocks.showWarningMessage,
  },
  workspace: { openTextDocument: vi.fn() },
  Uri: { file: (path: string) => ({ fsPath: path }) },
}));

vi.mock('@agent/index', () => ({
  getAgent: mocks.getAgent,
  loadAgents: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('@agent/remote/remoteAgentConfigClient', () => ({
  fetchRemoteAgentConfigYaml: vi.fn(() => Effect.succeed('')),
}));
vi.mock('@common/teams/TeamRosterApplication', () => ({
  applyTeamRosterWithPreflight: vi.fn(),
}));
vi.mock('@controllers/settingsView/SettingsAgentControllerFactory', () => ({
  createSettingsAgentControllers: () => ({
    catalog: {},
    directory: {},
    roster: {},
  }),
}));
vi.mock('@controllers/settingsView/SettingsTeamRosterController', () => ({
  applySettingsTeamRoster: mocks.applySettingsTeamRoster,
}));
vi.mock('@frontend/auth/agentCatalogRefreshScope', () => ({
  withAgentCatalogAuthRefreshDeferred: (work: Effect.Effect<unknown>) => work,
}));
vi.mock('@frontend/agents/AgentDirectoryManager', () => ({
  // The readers as the manager declares them: `AgentHandlers` runs them on
  // its own runtime, so a promise-returning double is not what it calls.
  agentDirectories: {
    custom: () => Effect.sync(() => mocks.customDirectory()),
    getDirectory: (source: AgentSource) =>
      Effect.promise(() => mocks.getSourceDirectory(source)),
  },
}));
vi.mock('@frontend/ui/dialogs', () => ({
  chooseTeamAvailabilityViaDialog: vi.fn(),
}));
vi.mock('@frontend/ui/errorHandlingUtils', () => ({
  showLoggedErrorMessage: vi.fn(() => Effect.succeed('')),
  showLoggedMessage: mocks.showLoggedMessage,
}));
vi.mock('@shared/settingsView/handlers/agentSelectionHandlers', () => ({
  buildAgentModePresetsMessage: vi.fn(),
  buildAgentSelectionMessage: vi.fn(),
  buildCustomAgentDirMessage: vi.fn(),
}));
function createHandlers(): AgentHandlers {
  return new AgentHandlers(
    {
      channel: 'test',
      extensionContext: {} as import('vscode').ExtensionContext,
      log: {
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        warn: mocks.logWarn,
      },
      withActiveWebview: vi.fn(() => Effect.void),
      postMessageToActiveWebview: vi.fn(() => Effect.void),
    },
    mocks.refreshAfterAgentMutation,
    installedHost().roots,
    () => Effect.void,
  );
}

/** The handlers hand back a program; the registry runs it on this host's
 *  runtime, as the settings message dispatch does. */
function customizeAgent(handlers: AgentHandlers): Promise<void> {
  return testRuntime().runPromise(
    handlers.runAgentFileAction(
      'customizeAgent',
      handlers.agentActions.customizeAgent(CUSTOMIZE_MY_AGENT),
    ),
  );
}

const DELETE_MY_AGENT = {
  command: 'deleteCustomAgent',
  agentName: 'my-agent',
} as const;

const CUSTOMIZE_MY_AGENT = {
  command: 'customizeAgent',
  agentSource: 'builtInWorkflow',
  agentName: 'my-agent',
} as const;

const AGENT_YAML = 'name: my-agent\n';

const APPLY_AGENT_MODE_PRESET = {
  command: 'applyAgentModePreset',
  presetId: 'my-preset',
} as const;

/** Whether `target` names an entry, read through the same filesystem the
 *  handlers write with. */
function onDisk(target: string): Promise<boolean> {
  return testRuntime().runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.exists(target);
    }),
  );
}

describe('AgentHandlers custom-agent file actions', () => {
  // Real roots: the handlers copy and delete through the standard library's
  // `FileSystem`, so the copy that lands and the file that survives are what
  // these tests read back.
  let root: string;
  let bundledDir: string;
  let customDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(path.join(tmpdir(), 'texra-agent-handlers-'));
    bundledDir = path.join(root, 'bundled');
    customDir = path.join(root, 'custom');
    await mkdir(path.join(bundledDir, 'writing'), { recursive: true });
    await writeFile(
      path.join(bundledDir, 'writing', 'my-agent.yaml'),
      AGENT_YAML,
    );
    mocks.customDirectory.mockReturnValue(customDir);
    mocks.getAgent.mockReturnValue({
      path: path.join(customDir, 'my-agent.yaml'),
    });
    initTestProcessRuntime(bareProcessRuntime());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.live(
    'coalesces repeated requests while the host confirmation is pending',
    () =>
      Effect.gen(function* () {
        let resolveConfirmation!: (choice: string | undefined) => void;
        const pendingConfirmation = new Promise<string | undefined>(
          (resolve) => {
            resolveConfirmation = resolve;
          },
        );
        const warned = Deferred.makeUnsafe<void>();
        mocks.showWarningMessage.mockImplementationOnce(() => {
          Deferred.doneUnsafe(warned, Effect.void);
          return pendingConfirmation;
        });
        const handlers = createHandlers();

        const first = yield* Effect.forkChild(
          withProcessServices(
            testRuntime(),
            handlers.handleDeleteCustomAgent(DELETE_MY_AGENT),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(warned);
        expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

        yield* withProcessServices(
          testRuntime(),
          handlers.handleDeleteCustomAgent(DELETE_MY_AGENT),
        );
        expect(mocks.showWarningMessage).toHaveBeenCalledTimes(1);

        resolveConfirmation(undefined);
        yield* Fiber.join(first);

        mocks.showWarningMessage.mockResolvedValueOnce(undefined);
        yield* withProcessServices(
          testRuntime(),
          handlers.handleDeleteCustomAgent(DELETE_MY_AGENT),
        );
        expect(mocks.showWarningMessage).toHaveBeenCalledTimes(2);
      }),
  );

  it.live('rejects deletion outside the configured custom directory', () =>
    Effect.gen(function* () {
      const outside = path.join(bundledDir, 'my-agent.yaml');
      yield* Effect.promise(() => writeFile(outside, AGENT_YAML));
      mocks.getAgent.mockReturnValueOnce({ path: outside });

      yield* withProcessServices(
        testRuntime(),
        createHandlers().handleDeleteCustomAgent(DELETE_MY_AGENT),
      );

      expect(mocks.showLoggedMessage).toHaveBeenCalledWith(
        'test',
        'Refusing to delete: file is not inside the custom agents directory.',
      );
      expect(mocks.showWarningMessage).not.toHaveBeenCalled();
      expect(yield* Effect.promise(() => onDisk(outside))).toBe(true);
    }),
  );

  it('preserves the source-relative path when creating a custom copy', async () => {
    mocks.getAgent.mockReturnValueOnce({
      path: path.join(bundledDir, 'writing', 'my-agent.yaml'),
    });
    mocks.getSourceDirectory.mockResolvedValueOnce(bundledDir);

    await customizeAgent(createHandlers());

    // The copy lands under the custom directory at the path the agent had
    // relative to its source directory — `writing/` is preserved.
    expect(
      await readFile(path.join(customDir, 'writing', 'my-agent.yaml'), 'utf8'),
    ).toBe(AGENT_YAML);
    expect(mocks.refreshAfterAgentMutation).toHaveBeenCalledOnce();
  });

  it('rejects a custom-copy target outside the configured directory', async () => {
    mocks.getAgent.mockReturnValueOnce({
      path: path.join(root, 'outside', 'my-agent.yaml'),
    });
    mocks.getSourceDirectory.mockResolvedValueOnce(bundledDir);

    await customizeAgent(createHandlers());

    expect(mocks.showLoggedMessage).toHaveBeenCalledWith(
      'test',
      'Refusing to copy: target path escapes the custom agents directory.',
    );
    // The refusal precedes the directory creation, so nothing was written.
    expect(await onDisk(customDir)).toBe(false);
  });
});
