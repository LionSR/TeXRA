/**
 * The Agents page of the settings body both GUI hosts answer through: the
 * roster toggles, the agent-file actions, the custom agent directory and the
 * team presets, with the refresh every mutation ends in. The host binds only
 * what it shows its own way (a document, a folder picker, the AI creator).
 */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import {
  agentSourceDirectory,
  createWorkspaceAgentRosterController,
  getAgent,
  getAgentsByCategory,
  getCustomAgentScanIssues,
  loadAgents,
  refresh,
} from '@agent/index';
import { createSettingsAgentActions } from '@controllers/settingsView/backend/SettingsAgentActions';
import {
  templateAgentNamePrompt,
  validateTemplateAgentName,
  writeTemplateAgentFile,
} from '@controllers/settingsView/backend/templateAgentCreation';
import { fetchRemoteAgentPromptYaml } from '@controllers/settingsView/remoteAgentPrompt';
import { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import { applySettingsTeamRoster } from '@controllers/settingsView/SettingsTeamRosterController';
import { AgentDirectories } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { agentKey } from '@shared/schemas';
import {
  buildAgentModePresetsMessage,
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { allSettledVoid } from '@utils/core/allSettledVoid';

import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

type HostEffect = Effect.Effect<void, Error, ProcessServices>;

interface SettingsAgentCommandsPorts {
  readonly roots: Pick<WorkspaceRoots, 'workspaceState' | 'globalState'>;
  /** The packaged resources root; the agent templates live under it. */
  readonly resourcesPath: string;
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
}

/** The Agents page: its arms, its opening data, and its mutation refresh. */
export function settingsAgentCommands(ports: SettingsAgentCommandsPorts) {
  const { bindings, present } = ports;
  const { globalState } = ports.roots;
  const roster = createWorkspaceAgentRosterController(ports.roots);
  const catalog = new SettingsAgentCatalogController({
    workspaceState: ports.roots.workspaceState,
    roster,
    getAgents: getAgentsByCategory,
  });
  const customDirectory = AgentDirectories.use((directories) =>
    directories.custom(),
  );

  const postSelection = present.post(
    Effect.andThen(
      loadAgents(),
      buildAgentSelectionMessage({
        buildSelectionItems: () => catalog.buildSelectionItems(),
        getCustomAgentScanIssues,
      }),
    ),
  );
  const postCustomDir = present.post(
    buildCustomAgentDirMessage(globalState, customDirectory),
  );
  const postPresets = present.post(
    buildAgentModePresetsMessage({
      getCustomPresets: () => catalog.getCustomPresets(),
      getOrchestratorAgentNames: () => catalog.getOrchestratorAgentNames(),
      getActiveTeamId: () => roster.getActiveTeamId(),
    }),
  );

  /**
   * Repaint the roster and the team presets, and reload every launcher's
   * catalogs. A mutation that moved agent files re-reads the registry first,
   * so nothing below it paints the catalog it replaced. The presets ride
   * along because enabling one agent rewrites the selection as `custom`,
   * which retires whatever team was applied.
   */
  const refreshAfterAgentMutation = (
    selectedToolUseAgent?: string,
    agentCatalogAlreadyFresh = false,
  ): HostEffect =>
    Effect.gen(function* () {
      if (!agentCatalogAlreadyFresh) yield* refresh();
      yield* allSettledVoid<Error, ProcessServices>([
        postPresets,
        postSelection,
        bindings.refreshCatalogs(selectedToolUseAgent),
      ]);
    });

  const afterCustomDirChange = Effect.andThen(
    bindings.customAgentDirChanged,
    allSettledVoid<Error, ProcessServices>([
      postCustomDir,
      refreshAfterAgentMutation(),
    ]),
  );

  const actions = createSettingsAgentActions({
    findAgent: (source, name) => getAgent(agentKey(source, name)),
    getCustomAgentDirectory: () => customDirectory,
    getSourceDirectory: (source) =>
      AgentDirectories.use((directories) =>
        agentSourceDirectory(directories, source),
      ),
    openDocument: bindings.openPath,
    openReadOnlyDocument: (filePath) =>
      Effect.flatMap(
        FileSystem.FileSystem.use((fs) => fs.readFileString(filePath)),
        (text) => bindings.showReadOnlyYaml(path.basename(filePath), text),
      ),
    revealFile: bindings.revealPath,
    confirmAction: (message, confirmLabel) =>
      bindings.prompt.confirm(message, { modal: true, confirmLabel }),
    showInfoMessage: present.notice,
    showErrorMessage: present.alert,
    refreshAfterMutation: () => refreshAfterAgentMutation(),
  });

  const createFromTemplate = (category: 'workflow' | 'toolUse') =>
    Effect.gen(function* () {
      const name = yield* bindings.prompt.input({
        prompt: templateAgentNamePrompt(category),
        placeHolder: 'my_agent',
      });
      if (!name) return;
      const invalid = validateTemplateAgentName(name);
      if (invalid) return yield* present.alert(invalid);
      // The custom agent directory is the user's choice, outside every root,
      // so it is created through the process filesystem.
      const customDir = yield* customDirectory;
      yield* FileSystem.FileSystem.use((fs) =>
        fs.makeDirectory(customDir, { recursive: true }),
      );
      const written = yield* writeTemplateAgentFile(
        { category, name, customDir },
        ports.resourcesPath,
      );
      if (!written.ok) return yield* present.alert(written.message);
      yield* bindings.openPath(written.filePath);
      yield* refreshAfterAgentMutation();
    });

  const handlers = {
    setAgentEnabled: (message) =>
      present.reported(
        'Failed to update agent visibility',
        roster
          .setAgentEnabled({
            category: message.category,
            source: message.agentSource,
            name: message.agentName,
            enabled: message.enabled,
          })
          .pipe(Effect.andThen(refreshAfterAgentMutation(undefined, true))),
      ),
    setAllAgentsEnabled: (message) =>
      present.reported(
        'Failed to update agent visibility',
        catalog
          .setAllAgentsEnabled(message)
          .pipe(Effect.andThen(refreshAfterAgentMutation(undefined, true))),
      ),
    openAgentYaml: (message) =>
      present.reported(
        'Failed to open agent YAML file',
        actions.openAgentYaml(message),
      ),
    customizeAgent: (message) =>
      present.reported(
        'Failed to create custom agent copy',
        actions.customizeAgent(message),
      ),
    deleteCustomAgent: (message) =>
      present.reported(
        'Failed to delete custom agent',
        actions.deleteCustomAgent(message),
      ),
    revealAgentFile: (message) =>
      present.reported(
        'Failed to reveal agent file',
        actions.revealAgentFile(message),
      ),
    openAgentFolder: (message) =>
      present.reported(
        'Failed to open agent folder',
        Effect.gen(function* () {
          const directory = yield* AgentDirectories.use((directories) =>
            agentSourceDirectory(directories, message.folderType),
          );
          if (!directory) {
            return yield* present.alert(
              `No local directory for agent source: ${message.folderType}`,
            );
          }
          yield* bindings.revealPath(directory);
        }),
      ),
    createAgent: (message) =>
      present.reported(
        'Failed to create agent',
        message.mode === 'template'
          ? createFromTemplate(message.category)
          : bindings
              .createAgentWithAI(message.category)
              .pipe(Effect.andThen(refreshAfterAgentMutation())),
      ),
    viewRemoteAgentPrompt: (message) =>
      present.reported(
        'Failed to view remote agent prompt',
        Effect.gen(function* () {
          const config = yield* fetchRemoteAgentPromptYaml(message.agentName);
          if (config == null) {
            return yield* present.alert(
              'Authentication required. Sign in using "TeXRA: Sign In".',
            );
          }
          yield* bindings.showReadOnlyYaml(`${message.agentName}.yaml`, config);
        }),
      ),
    setCustomAgentDir: () =>
      present.reported(
        'Failed to set custom agent directory',
        Effect.gen(function* () {
          const selected = yield* bindings.pickFolder(
            'Select Custom Agents Folder',
          );
          if (!selected) return;
          // A folder already there is the post-condition; a real fault (the
          // path is a file) fails instead of writing the setting anyway.
          yield* FileSystem.FileSystem.use((fs) =>
            fs.makeDirectory(selected, { recursive: true }),
          );
          yield* globalState.update(GlobalStateKey.CUSTOM_AGENT_DIR, selected);
          yield* afterCustomDirChange;
        }),
      ),
    resetCustomAgentDir: () =>
      present.reported(
        'Failed to reset custom agent directory',
        globalState
          .update(GlobalStateKey.CUSTOM_AGENT_DIR, undefined)
          .pipe(Effect.andThen(afterCustomDirChange)),
      ),
    applyAgentModePreset: (message) =>
      present.reported(
        'Failed to apply agent team',
        applySettingsTeamRoster(message.presetId, {
          catalog,
          loadLocalCatalog: () => loadAgents({ includeRemote: false }),
          canAccessRemoteCatalog: bindings.remoteCatalog.canAccess,
          signIn: bindings.remoteCatalog.signIn,
          forceRefreshRemoteCatalog: () => refresh({ includeRemote: true }),
          presentation: {
            chooseTeamAvailability: bindings.chooseTeamAvailability,
            showInfoMessage: present.notice,
            showErrorMessage: present.alert,
          },
          refreshAfterApply: (selectedToolUseAgent) =>
            refreshAfterAgentMutation(selectedToolUseAgent, true),
        }),
      ),
    saveAgentModePreset: () =>
      present.reported(
        'Failed to save agent team',
        Effect.gen(function* () {
          const name = yield* bindings.prompt.input({
            prompt: 'Name for the new team',
            placeHolder: 'e.g. My Research Team',
          });
          if (!name?.trim()) return;
          yield* loadAgents();
          const preset = yield* catalog.saveCurrentPreset(name);
          yield* refreshAfterAgentMutation(undefined, true);
          yield* present.notice(`Saved team "${preset.name}"`);
        }),
      ),
    deleteAgentModePreset: (message) =>
      present.reported(
        'Failed to delete agent team',
        Effect.gen(function* () {
          const target = yield* catalog.getCustomPreset(message.presetId);
          if (!target) {
            return yield* present.alert(
              `Unknown custom team: ${message.presetId}`,
            );
          }
          const confirmed = yield* bindings.prompt.confirm(
            `Delete team "${target.name}"?`,
            { modal: true, confirmLabel: 'Delete' },
          );
          if (!confirmed) return;
          yield* catalog.deleteCustomPreset(message.presetId);
          yield* refreshAfterAgentMutation(undefined, true);
        }),
      ),
  } satisfies Partial<SettingsViewInboundHandlerRegistry>;

  return {
    handlers,
    /** The Agents page's opening data. */
    postStartup: allSettledVoid<Error, ProcessServices>([
      postPresets,
      postSelection,
      postCustomDir,
    ]),
    refreshAfterAgentMutation,
  };
}
