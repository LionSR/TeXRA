/**
 * The Agents page of the settings body both GUI hosts answer through: the
 * agent toggles, the agent-file actions, the custom agent directory and the
 * team presets, with the refresh every mutation ends in. The host binds only
 * what it shows its own way (a document, a folder picker, the AI creator).
 */
import * as path from 'node:path';

import { Effect, FileSystem } from 'effect';

import {
  agentSourceRoots,
  changedBuiltInOf,
  createWorkspaceAgentsController,
  getAgent,
  getCatalogAgents,
  getCustomAgentScanIssues,
  keepCustomAgent,
  refresh,
} from '@agent/index';
import { AgentDirectories } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { agentKey } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { createSettingsAgentActions } from '@texra/controllers/settingsView/backend/SettingsAgentActions';
import {
  templateAgentNamePrompt,
  validateTemplateAgentName,
  writeTemplateAgentFile,
} from '@texra/controllers/settingsView/backend/templateAgentCreation';
import { SettingsAgentCatalogController } from '@texra/controllers/settingsView/SettingsAgentCatalogController';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import { applySettingsTeam } from '@texra/controllers/settingsView/SettingsTeamController';
import {
  buildAgentModePresetsMessage,
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
} from '@texra/shared/settingsView/handlers/agentSelectionHandlers';
import { registerCustomAgentRoot } from '@tools/agentCatalogFollower';
import { allSettledVoid } from '@utils/core/allSettledVoid';

import type {
  SettingsHostBindings,
  SettingsPresentation,
} from './settingsHostBindings';

type HostEffect = Effect.Effect<void, Error, ProcessServices>;

interface SettingsAgentCommandsPorts {
  readonly roots: Pick<WorkspaceRoots, 'repoState' | 'globalState'>;
  /** The packaged resources root; the agent templates live under it. */
  readonly resourcesPath: string;
  readonly bindings: SettingsHostBindings;
  readonly present: SettingsPresentation;
}

/** The Agents page: its arms, its opening data, and its mutation refresh. */
export function settingsAgentCommands(ports: SettingsAgentCommandsPorts) {
  const { bindings, present } = ports;
  const { globalState } = ports.roots;
  const workspaceAgents = createWorkspaceAgentsController(ports.roots);
  const catalog = new SettingsAgentCatalogController({
    repoState: ports.roots.repoState,
    workspaceAgents,
    getAgents: getCatalogAgents,
    newerBuiltInOf: (entry) => changedBuiltInOf(entry)?.source,
  });
  const customDirectory = AgentDirectories.use((directories) =>
    directories.custom(),
  );

  const postSelection = present.post(
    buildAgentSelectionMessage({
      buildSelectionItems: () => catalog.buildSelectionItems(),
      getCustomAgentScanIssues,
    }),
  );
  const postCustomDir = present.post(
    buildCustomAgentDirMessage(globalState, customDirectory),
  );
  const postPresets = present.post(
    buildAgentModePresetsMessage({
      getCustomPresets: () => catalog.getCustomPresets(),
      getOrchestratorAgentNames: () => catalog.getOrchestratorAgentNames(),
      getActiveTeamId: () => workspaceAgents.getActiveTeamId(),
    }),
  );

  /**
   * Repaint the agent list and the team presets, and reload every launcher's
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

  // The file tools admit the new directory before the change reports done,
  // so a `creator` run launched right after can write there.
  const afterCustomDirChange = Effect.andThen(
    registerCustomAgentRoot,
    allSettledVoid<Error, ProcessServices>([
      postCustomDir,
      refreshAfterAgentMutation(),
    ]),
  );

  const actions = createSettingsAgentActions({
    findAgent: (source, name) => getAgent(agentKey(source, name)),
    getCustomAgentDirectory: () => customDirectory,
    getSourceRoots: (source) =>
      AgentDirectories.use((directories) =>
        agentSourceRoots(directories, source),
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
    forgetDeletedAgent: (name) => workspaceAgents.forgetDeletedAgent(name),
  });

  const handlers = {
    setAgentEnabled: (message) =>
      present.reported(
        'Failed to update agent visibility',
        workspaceAgents
          .setAgentEnabled({
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
    keepCustomAgent: (message) =>
      present.reported(
        'Failed to keep the custom agent',
        Effect.gen(function* () {
          if (!(yield* keepCustomAgent(message.agentName))) {
            return yield* present.alert(
              `${message.agentName} has no newer built-in version to dismiss.`,
            );
          }
          yield* refreshAfterAgentMutation();
        }),
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
          const [directory] = yield* AgentDirectories.use((directories) =>
            agentSourceRoots(directories, message.folderType),
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
        Effect.gen(function* () {
          const name = yield* bindings.prompt.input({
            prompt: templateAgentNamePrompt(message.task),
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
            { task: message.task, name, customDir },
            ports.resourcesPath,
          );
          if (!written.ok) return yield* present.alert(written.message);
          yield* bindings.openPath(written.filePath);
          yield* refreshAfterAgentMutation();
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
        applySettingsTeam(message.presetId, {
          workspaceAgents,
          catalog,
          presentation: {
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
