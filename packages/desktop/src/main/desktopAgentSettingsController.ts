import path from 'node:path';

import { Cause, Data, Effect, FileSystem } from 'effect';

import {
  type AgentEntry,
  type AgentRosterController,
  getAgent,
  getCustomAgentScanIssues,
  type loadAgents,
  type refresh,
} from '@agent/index';
import type {
  TeamAvailabilityChoice,
  TeamCatalogPortFailed,
} from '@common/teams/TeamAvailabilityPreflight';
import { type TeamAvailabilityPrompt } from '@common/teams/TeamPlan';
import type { SignInFailed } from '@common/errors/signInFailed';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import {
  createSettingsAgentActions,
  FAILURE_MESSAGES,
} from '@controllers/settingsView/backend/SettingsAgentActions';
import {
  templateAgentCategoryLabel,
  templateAgentNamePrompt,
  validateTemplateAgentName,
  writeTemplateAgentFile,
} from '@controllers/settingsView/backend/templateAgentCreation';
import { SettingsAgentCatalogController } from '@controllers/settingsView/SettingsAgentCatalogController';
import { fetchRemoteAgentPromptYaml } from '@controllers/settingsView/remoteAgentPrompt';
import { applySettingsTeamRoster } from '@controllers/settingsView/SettingsTeamRosterController';
import {
  ExternalOpenFailed,
  type MessageHost,
  type PromptFailed,
} from '@hosts/uiHosts';
import type { StateStore } from '@platform/interfaces';
import type { AgentDirectoriesFailed } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { agentKey } from '@shared/schemas';
import type { AgentCategory, AgentSource } from '@shared/schemas';
import type {
  SettingsMessageFor,
  SettingsViewInboundMessage,
} from '@shared/settingsView/settingsViewMessages';
import {
  buildAgentModePresetsMessage,
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import type { PreviewUnavailable } from './desktopPreviewHost.js';

/**
 * One of the desktop-local calls this controller drives rejected. The members
 * are the template write, the temp-file copy the desktop shows a packaged
 * definition through, the hosted-prompt fetch, and the catalog refresh that
 * follows a mutation. Each is reported to the user by the surrounding
 * `catchCause`, which is why one tag with a member name is the whole
 * vocabulary any caller here reads.
 *
 * `message` always ends with the rejection's own text, and never repeats what
 * the reporting `catchCause` already prefixes: the surrounding notification
 * renders `toErrorMessage(Cause.squash(cause))`, so a message that named only
 * the step would drop the reason the call actually gave.
 */
class AgentSettingsActionFailed extends Data.TaggedError(
  'AgentSettingsActionFailed',
)<{
  readonly member:
    | 'writeTemplateAgentFile'
    | 'createTempDir'
    | 'getRemoteAgentPrompt'
    | 'refreshAfterMutation';
  readonly message: string;
  readonly cause: unknown;
}> {}

type AgentCommand = SettingsViewInboundMessage['command'];
type AgentMessage<C extends AgentCommand> = SettingsMessageFor<C>;
type DesktopAgentHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED
  | typeof SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_AGENT_FOLDER
  | typeof SETTINGS_VIEW_COMMANDS.CREATE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.CUSTOMIZE_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT
  | typeof SETTINGS_VIEW_COMMANDS.REVEAL_AGENT_FILE
  | typeof SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT
  | typeof SETTINGS_VIEW_COMMANDS.SET_CUSTOM_AGENT_DIR
  | typeof SETTINGS_VIEW_COMMANDS.RESET_CUSTOM_AGENT_DIR
  | typeof SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET
  | typeof SETTINGS_VIEW_COMMANDS.SAVE_AGENT_MODE_PRESET
  | typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET
>;

interface DefaultDesktopAgentSettingsControllerOptions extends SettingsStatePorts {
  readonly roster: AgentRosterController<AgentEntry>;
  /** The composition root's runtime serves registry and roster programs. */
  readonly registry: {
    readonly loadAgents: typeof loadAgents;
    readonly refreshAgents: typeof refresh;
    readonly getAgents: (category: AgentCategory) => AgentEntry[];
  };
  readonly directory: {
    /** The host's agent directories as `AgentDirectoriesPort` declares them:
     *  Effects, so a directory that cannot be resolved reaches the report
     *  that asked for it instead of an untyped rejection. */
    readonly getCustomAgentDirectory: () => Effect.Effect<
      string,
      AgentDirectoriesFailed,
      GlobalStorageFs | FileSystem.FileSystem
    >;
    readonly getSourceDirectory: (
      source: AgentSource,
    ) => Effect.Effect<
      string | undefined,
      AgentDirectoriesFailed,
      GlobalStorageFs | FileSystem.FileSystem
    >;
    readonly selectCustomAgentDirectory: () => Promise<string | undefined>;
    readonly openPath: (
      filePath: string,
    ) => Effect.Effect<void, PreviewUnavailable>;
    readonly revealPath: (filePath: string) => Promise<void>;
  };
  readonly renderer: {
    readonly postToRenderer: (message: unknown) => void;
  };
  /**
   * The agent and team catalogs changed: the `host` snapshot of every open
   * paper reloads them (PRD 8.1). A team that was just applied names the
   * tool-use root the launcher should select.
   *
   * Every catalog-refresh path reloads agent and team options together: team
   * availability depends on the same catalog (sign-in, remote load, roster,
   * and custom-dir changes), so refreshing one without the other would leave
   * the launcher's team picker stale.
   */
  readonly onCatalogChanged: (
    selectedToolUseAgent?: string,
  ) => Effect.Effect<void, never, ProcessServices>;
  readonly prompts: {
    readonly promptText: (input: {
      title: string;
      prompt: string;
    }) => Effect.Effect<string | undefined>;
    /**
     * Confirm a destructive or overwriting action. Used by the custom-agent
     * delete and overwrite paths and by team deletion, which the extension
     * guards with a modal.
     */
    readonly confirm: (input: {
      title: string;
      message: string;
    }) => Effect.Effect<boolean, PromptFailed>;
    readonly chooseTeamAvailability: (
      prompt: TeamAvailabilityPrompt,
    ) => Effect.Effect<
      TeamAvailabilityChoice | undefined,
      TeamCatalogPortFailed
    >;
  };
  /**
   * Root of the packaged resources tree, used to read the bundled agent
   * templates (`templates/<kind>.yaml`) when creating an agent from template.
   */
  readonly resourcesPath: string;
  readonly remoteCatalog: {
    readonly canAccess: () => Effect.Effect<boolean>;
    readonly signIn: () => Effect.Effect<boolean, SignInFailed>;
  };
  readonly notifications: Pick<
    MessageHost,
    'showInfoMessage' | 'showErrorMessage'
  >;
}

export interface DesktopAgentSettingsController {
  readonly handlers: DesktopAgentHandlers;
  postStartupData(): Effect.Effect<void, Error, ProcessServices>;
  refreshCatalogData(): Effect.Effect<void, Error, ProcessServices>;
}

/** Owns the desktop settings agent catalog, directory, and roster behavior. */
export class DefaultDesktopAgentSettingsController implements DesktopAgentSettingsController {
  readonly handlers: DesktopAgentHandlers;

  private readonly catalogController;
  private readonly globalState: StateStore;
  private readonly roster: AgentRosterController<AgentEntry>;
  private readonly registry: DefaultDesktopAgentSettingsControllerOptions['registry'];
  private readonly directory: DefaultDesktopAgentSettingsControllerOptions['directory'];
  private readonly renderer: DefaultDesktopAgentSettingsControllerOptions['renderer'];
  private readonly onCatalogChanged: DefaultDesktopAgentSettingsControllerOptions['onCatalogChanged'];
  private readonly prompts: DefaultDesktopAgentSettingsControllerOptions['prompts'];
  private readonly remoteCatalog: DefaultDesktopAgentSettingsControllerOptions['remoteCatalog'];
  private readonly notifications: DefaultDesktopAgentSettingsControllerOptions['notifications'];
  private readonly resourcesPath: string;
  private readonly agentActions;

  constructor(options: DefaultDesktopAgentSettingsControllerOptions) {
    const {
      workspaceState,
      globalState,
      registry,
      directory,
      renderer,
      onCatalogChanged,
      prompts,
      remoteCatalog,
      notifications,
      resourcesPath,
    } = options;
    this.registry = registry;
    this.directory = directory;
    this.renderer = renderer;
    this.onCatalogChanged = onCatalogChanged;
    this.prompts = prompts;
    this.remoteCatalog = remoteCatalog;
    this.notifications = notifications;
    this.resourcesPath = resourcesPath;
    this.globalState = globalState;
    this.roster = options.roster;
    this.catalogController = new SettingsAgentCatalogController({
      workspaceState,
      roster: this.roster,
      getAgents: registry.getAgents,
    });
    this.agentActions = createSettingsAgentActions({
      findAgent: (source, name) => getAgent(agentKey(source, name)),
      getCustomAgentDirectory: directory.getCustomAgentDirectory,
      getSourceDirectory: directory.getSourceDirectory,
      openDocument: directory.openPath,
      // The desktop has no editor of its own and hands the path to the OS,
      // so a packaged definition is shown through a temporary copy that the
      // external editor may save without touching the installed bundle.
      // Both paths are outside every root, so the copy goes through the
      // process filesystem.
      openReadOnlyDocument: (filePath) =>
        Effect.gen(function* () {
          const target = path.join(
            yield* FileSystem.FileSystem.use((fs) =>
              fs.makeTempDirectory({ prefix: 'texra-agent-yaml-' }),
            ),
            path.basename(filePath),
          );
          yield* FileSystem.FileSystem.use((fs) =>
            fs.copyFile(filePath, target),
          );
          yield* directory.openPath(target);
        }),
      revealFile: (filePath) =>
        Effect.tryPromise({
          try: () => directory.revealPath(filePath),
          catch: ensureError,
        }),
      confirmAction: (message, confirmLabel) =>
        prompts.confirm({
          title:
            confirmLabel === 'Delete'
              ? 'Delete custom agent?'
              : 'Overwrite custom copy?',
          message,
        }),
      showInfoMessage: notifications.showInfoMessage,
      showErrorMessage: notifications.showErrorMessage,
      refreshAfterMutation: () => this.refreshAfterAgentMutation(),
    });
    this.handlers = {
      setAgentEnabled: (message) => this.updateAgentEnabled(message),
      setAllAgentsEnabled: (message) => this.updateAllAgentsEnabled(message),
      openAgentYaml: (message) =>
        this.runReported(
          FAILURE_MESSAGES.openAgentYaml,
          this.agentActions.openAgentYaml(message),
        ),
      openAgentFolder: () => this.openAgentFolder(),
      createAgent: (message) => this.createAgent(message),
      customizeAgent: (message) =>
        this.runReported(
          FAILURE_MESSAGES.customizeAgent,
          this.agentActions.customizeAgent(message),
        ),
      deleteCustomAgent: (message) =>
        this.runReported(
          FAILURE_MESSAGES.deleteCustomAgent,
          this.agentActions.deleteCustomAgent(message),
        ),
      revealAgentFile: (message) =>
        this.runReported(
          FAILURE_MESSAGES.revealAgentFile,
          this.agentActions.revealAgentFile(message),
        ),
      viewRemoteAgentPrompt: (message) => this.viewRemoteAgentPrompt(message),
      setCustomAgentDir: () => this.setCustomAgentDir(),
      resetCustomAgentDir: () => this.resetCustomAgentDir(),
      applyAgentModePreset: (message) =>
        this.applyAgentModePreset(message).pipe(Effect.mapError(ensureError)),
      saveAgentModePreset: () => this.saveAgentModePreset(),
      deleteAgentModePreset: (message) => this.deleteAgentModePreset(message),
    };
  }

  /**
   * Run one of this controller's programs, reporting its failure through the
   * host's own surface. The one home for the fold: the settings actions this
   * controller injects and the two flows it runs itself all report through it.
   *
   * An interrupt (the runtime disposing at shutdown) is not an action failure:
   * re-fail it instead of showing a notification. The reporting notification
   * prefixes `failureMessage` itself and carries the rejection's own text
   * behind it, as the tag it replaces did.
   */
  private runReported(
    failureMessage: string,
    action: Effect.Effect<void, Error, ProcessServices>,
  ) {
    return action.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : this.notifications.showErrorMessage(
              `${failureMessage}: ${toErrorMessage(Cause.squash(cause))}`,
            ),
      ),
    );
  }

  postStartupData(): Effect.Effect<void, Error, ProcessServices> {
    return Effect.andThen(
      this.postAgentModePresets(),
      Effect.all([this.postAgentSelectionData(), this.postCustomAgentDir()], {
        concurrency: 'unbounded',
      }).pipe(Effect.asVoid),
    );
  }

  refreshCatalogData(): Effect.Effect<void, Error, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      // Roster mutations also change the effective team.
      yield* this.postAgentModePresets();
      yield* Effect.all(
        [this.postAgentSelectionData(), this.catalogChanged()],
        { concurrency: 'unbounded' },
      );
    });
  }

  /**
   * The window's composition root owns what a catalog change means for the
   * open papers; this is the one place that crosses back into it.
   */
  private catalogChanged(
    selectedToolUseAgent?: string,
  ): Effect.Effect<void, never, ProcessServices> {
    return this.onCatalogChanged(selectedToolUseAgent);
  }

  private postAgentSelectionData(): Effect.Effect<
    void,
    Error,
    ProcessServices
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.registry.loadAgents();
      this.renderer.postToRenderer(
        yield* buildAgentSelectionMessage({
          buildSelectionItems: () =>
            this.catalogController.buildSelectionItems(),
          getCustomAgentScanIssues,
        }),
      );
    });
  }

  private postCustomAgentDir(): Effect.Effect<void, Error, ProcessServices> {
    return Effect.map(
      buildCustomAgentDirMessage(
        this.globalState,
        this.directory.getCustomAgentDirectory(),
      ),
      (message) => {
        this.renderer.postToRenderer(message);
      },
    );
  }

  private postAgentModePresets(): Effect.Effect<void, Error> {
    return Effect.map(
      buildAgentModePresetsMessage({
        getCustomPresets: () => this.catalogController.getCustomPresets(),
        getOrchestratorAgentNames: () =>
          this.catalogController.getOrchestratorAgentNames(),
        getActiveTeamId: () => this.roster.getActiveTeamId(),
      }),
      (message) => this.renderer.postToRenderer(message),
    );
  }

  private updateAgentEnabled(
    message: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED>,
  ) {
    return this.roster
      .setAgentEnabled({
        category: message.category,
        source: message.agentSource,
        name: message.agentName,
        enabled: message.enabled,
      })
      .pipe(Effect.andThen(this.refreshCatalogData()));
  }

  private updateAllAgentsEnabled(
    message: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED>,
  ) {
    return this.catalogController
      .setAllAgentsEnabled(message)
      .pipe(Effect.andThen(this.refreshCatalogData()));
  }

  private setCustomAgentDir() {
    return Effect.gen({ self: this }, function* () {
      const selectedPath = yield* Effect.tryPromise({
        try: () => this.directory.selectCustomAgentDirectory(),
        catch: ensureError,
      });
      if (!selectedPath) return;

      yield* this.globalState
        .update(GlobalStateKey.CUSTOM_AGENT_DIR, selectedPath)
        .pipe(
          Effect.andThen(
            Effect.all([this.postCustomAgentDir(), this.refreshCatalogData()], {
              concurrency: 'unbounded',
            }),
          ),
        );
    });
  }

  /**
   * Re-read the agent catalog from disk and rebroadcast every view that shows
   * it. Creating, copying, or deleting a custom agent changes the YAML files the
   * registry was built from, so a plain re-post would serve a stale catalog.
   */
  private refreshAfterAgentMutation(): Effect.Effect<
    void,
    Error,
    ProcessServices
  > {
    return this.registry
      .refreshAgents()
      .pipe(Effect.andThen(this.refreshCatalogData()));
  }

  private resetCustomAgentDir() {
    return this.globalState
      .update(GlobalStateKey.CUSTOM_AGENT_DIR, undefined)
      .pipe(
        Effect.andThen(
          Effect.all([this.postCustomAgentDir(), this.refreshCatalogData()], {
            concurrency: 'unbounded',
          }),
        ),
        Effect.asVoid,
      );
  }

  private openAgentFolder() {
    return Effect.gen({ self: this }, function* () {
      const directory = yield* this.directory.getSourceDirectory('custom');
      if (!directory) {
        yield* this.notifications.showErrorMessage(
          'No custom agent directory is available',
        );
        return;
      }
      yield* this.directory.openPath(directory);
    });
  }

  /**
   * Create a custom agent. Mirrors the extension's `handleCreateAgent`: the
   * template path writes a rendered bundled template, while the AI path is the
   * agent-creator flow. Only the template path is wired here; AI creation needs
   * the creator flow's own UI, which this host does not present yet.
   */
  private createAgent(
    data: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.CREATE_AGENT>,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (data.mode !== 'template') {
        yield* this.notifications.showErrorMessage(
          'Creating an agent with AI is not available in the desktop app yet. Choose "From template" instead.',
        );
        return;
      }

      const name = yield* this.prompts.promptText({
        title: `New ${templateAgentCategoryLabel(data.category)} agent`,
        prompt: templateAgentNamePrompt(data.category),
      });
      if (!name) return;

      const invalid = validateTemplateAgentName(name);
      if (invalid) {
        yield* this.notifications.showErrorMessage(invalid);
        return;
      }

      // The custom agent directory is the user's choice, outside every root,
      // so it is created through the process filesystem.
      yield* this.runReported(
        'Failed to create custom agent',
        Effect.gen({ self: this }, function* () {
          const customDir = yield* this.directory.getCustomAgentDirectory();
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(customDir, { recursive: true });

          const written = yield* writeTemplateAgentFile(
            { category: data.category, name, customDir },
            this.resourcesPath,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new AgentSettingsActionFailed({
                  member: 'writeTemplateAgentFile',
                  message: `The agent template could not be written: ${toErrorMessage(cause)}`,
                  cause,
                }),
            ),
          );
          if (!written.ok) {
            yield* this.notifications.showErrorMessage(written.message);
            return;
          }

          yield* this.directory.openPath(written.filePath).pipe(
            Effect.mapError(
              (cause) =>
                new ExternalOpenFailed({
                  kind: 'path',
                  target: written.filePath,
                  message: `The new agent definition could not be opened: ${toErrorMessage(cause)}`,
                  cause,
                }),
            ),
          );
          yield* this.notifications.showInfoMessage(
            `Created custom agent: ${path.basename(written.filePath)}`,
          );
          yield* this.refreshAfterAgentMutation().pipe(
            Effect.mapError(
              (cause) =>
                new AgentSettingsActionFailed({
                  member: 'refreshAfterMutation',
                  message: `The agent catalog could not be reloaded: ${toErrorMessage(cause)}`,
                  cause,
                }),
            ),
          );
        }),
      );
    });
  }

  /**
   * Show a hosted agent's prompt YAML. The extension opens an untitled editor;
   * the desktop has no editor surface, so the config is written to a temporary
   * file and opened with the OS handler.
   */
  private viewRemoteAgentPrompt(
    data: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT>,
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* this.runReported(
        'Failed to view remote agent prompt',
        Effect.gen({ self: this }, function* () {
          const config = yield* fetchRemoteAgentPromptYaml(data.agentName).pipe(
            Effect.mapError(
              (cause) =>
                new AgentSettingsActionFailed({
                  member: 'getRemoteAgentPrompt',
                  message: `The hosted agent prompt could not be fetched: ${toErrorMessage(cause)}`,
                  cause,
                }),
            ),
          );
          if (config == null) {
            yield* this.notifications.showErrorMessage(
              'Authentication required. Sign in using "TeXRA: Sign In".',
            );
            return;
          }

          const target = path.join(
            yield* FileSystem.FileSystem.use((fs) =>
              fs.makeTempDirectory({ prefix: 'texra-agent-prompt-' }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new AgentSettingsActionFailed({
                    member: 'createTempDir',
                    message: `A temporary directory could not be created: ${toErrorMessage(cause)}`,
                    cause,
                  }),
              ),
            ),
            `${data.agentName}.yaml`,
          );
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(target, config);
          yield* this.directory.openPath(target).pipe(
            Effect.mapError(
              (cause) =>
                new ExternalOpenFailed({
                  kind: 'path',
                  target,
                  message: `The hosted agent prompt could not be opened: ${toErrorMessage(cause)}`,
                  cause,
                }),
            ),
          );
        }),
      );
    });
  }

  private applyAgentModePreset(
    message: AgentMessage<
      typeof SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET
    >,
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* applySettingsTeamRoster(message.presetId, {
        catalog: this.catalogController,
        loadLocalCatalog: () =>
          this.registry.loadAgents({ includeRemote: false }),
        canAccessRemoteCatalog: this.remoteCatalog.canAccess,
        signIn: this.remoteCatalog.signIn,
        forceRefreshRemoteCatalog: () =>
          this.registry.refreshAgents({ includeRemote: true }),
        presentation: {
          chooseTeamAvailability: this.prompts.chooseTeamAvailability,
          showInfoMessage: this.notifications.showInfoMessage,
          showErrorMessage: this.notifications.showErrorMessage,
        },
        refreshAfterApply: (selectedToolUseAgent) =>
          Effect.gen({ self: this }, function* () {
            yield* this.postAgentModePresets();
            yield* Effect.all(
              [
                this.postAgentSelectionData(),
                this.catalogChanged(selectedToolUseAgent),
              ],
              { concurrency: 'unbounded' },
            );
          }),
      });
    });
  }

  private saveAgentModePreset() {
    return Effect.gen({ self: this }, function* () {
      const name = yield* this.prompts.promptText({
        title: 'Save agent team',
        prompt: 'Name for the new team',
      });
      if (!name?.trim()) return;
      yield* this.registry.loadAgents();
      const preset = yield* this.catalogController.saveCurrentPreset(name);
      yield* this.postAgentModePresets();
      yield* this.onCatalogChanged();
      yield* this.notifications.showInfoMessage(`Saved team "${preset.name}"`);
    });
  }

  private deleteAgentModePreset(
    message: AgentMessage<
      typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET
    >,
  ) {
    return Effect.gen({ self: this }, function* () {
      const { presetId } = message;
      const target = yield* this.catalogController.getCustomPreset(presetId);
      if (!target) {
        yield* this.notifications.showErrorMessage(
          `Unknown custom team: ${presetId}`,
        );
        return;
      }

      const confirmed = yield* this.prompts.confirm({
        title: 'Delete team?',
        message: `Delete team "${target.name}"?`,
      });
      if (!confirmed) return;

      yield* this.catalogController.deleteCustomPreset(presetId);
      yield* this.postAgentModePresets();
      yield* this.onCatalogChanged();
    });
  }
}
