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
import {
  createSettingsAgentActions,
  FAILURE_MESSAGES,
} from '@controllers/settingsView/backend/SettingsAgentActions';
import {
  templateAgentCategoryLabel,
  templateAgentNamePrompt,
  writeTemplateAgentFile,
} from '@controllers/settingsView/backend/templateAgentCreation';
import { createSettingsAgentControllers } from '@controllers/settingsView/SettingsAgentControllerFactory';
import { fetchRemoteAgentPromptYaml } from '@controllers/settingsView/remoteAgentPrompt';
import { applySettingsTeamRoster } from '@controllers/settingsView/SettingsTeamRosterController';
import { ExternalOpenFailed, type MessageHost } from '@hosts/uiHosts';
import type { AgentDirectoriesFailed } from '@platform/interfaces';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  agentKey,
  type AgentCategory,
  type AgentSource,
  type SettingsMessageFor,
  type SettingsViewInboundHandlerRegistry,
  type SettingsViewInboundMessage,
} from '@shared/schemas';
import {
  buildAgentModePresetsMessage,
  buildAgentSelectionMessage,
  buildCustomAgentDirMessage,
} from '@shared/settingsView/handlers/agentSelectionHandlers';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { createTexraTempDir } from '@utils/files/tempDir';
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
  /** The process runtime the composition root built; the registry and roster
   *  programs below run on it. */
  readonly runtime: ProcessRuntime;
  readonly registry: {
    readonly loadAgents: typeof loadAgents;
    readonly refreshAgents: typeof refresh;
    readonly getAgents: (category: AgentCategory) => AgentEntry[];
    readonly getVisibleAgents: (category: AgentCategory) => AgentEntry[];
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
  readonly onCatalogChanged: (selectedToolUseAgent?: string) => Promise<void>;
  readonly prompts: {
    readonly promptText: (input: {
      title: string;
      prompt: string;
    }) => Promise<string | undefined>;
    /**
     * Confirm a destructive or overwriting action. Used by the custom-agent
     * delete and overwrite paths and by team deletion, which the extension
     * guards with a modal.
     */
    readonly confirm: (input: {
      title: string;
      message: string;
    }) => Promise<boolean>;
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
  postStartupData(): Promise<void>;
  refreshCatalogData(): Effect.Effect<void, Error, ProcessServices>;
}

/** Owns the desktop settings agent catalog, directory, and roster behavior. */
export class DefaultDesktopAgentSettingsController implements DesktopAgentSettingsController {
  readonly handlers: DesktopAgentHandlers;

  private readonly catalogController;
  private readonly directoryController;
  private readonly roster: AgentRosterController;
  private readonly registry: DefaultDesktopAgentSettingsControllerOptions['registry'];
  private readonly directory: DefaultDesktopAgentSettingsControllerOptions['directory'];
  private readonly renderer: DefaultDesktopAgentSettingsControllerOptions['renderer'];
  private readonly onCatalogChanged: DefaultDesktopAgentSettingsControllerOptions['onCatalogChanged'];
  private readonly prompts: DefaultDesktopAgentSettingsControllerOptions['prompts'];
  private readonly remoteCatalog: DefaultDesktopAgentSettingsControllerOptions['remoteCatalog'];
  private readonly notifications: DefaultDesktopAgentSettingsControllerOptions['notifications'];
  private readonly resourcesPath: string;
  private readonly agentActions;
  private readonly runtime: ProcessRuntime;

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
    this.runtime = options.runtime;
    this.registry = registry;
    this.directory = directory;
    this.renderer = renderer;
    this.onCatalogChanged = onCatalogChanged;
    this.prompts = prompts;
    this.remoteCatalog = remoteCatalog;
    this.notifications = notifications;
    this.resourcesPath = resourcesPath;
    const controllers = createSettingsAgentControllers({
      workspaceState,
      globalState,
      getCustomAgentDirectory: directory.getCustomAgentDirectory,
      getSourceDirectory: directory.getSourceDirectory,
      getAgents: registry.getAgents,
      getVisibleAgents: registry.getVisibleAgents,
    });
    this.catalogController = controllers.catalog;
    this.directoryController = controllers.directory;
    this.roster = controllers.roster;
    this.agentActions = createSettingsAgentActions({
      directoryController: this.directoryController,
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
            yield* Effect.tryPromise({
              try: () => createTexraTempDir('texra-agent-yaml-'),
              catch: ensureError,
            }),
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
        Effect.tryPromise({
          try: () =>
            prompts.confirm({
              title:
                confirmLabel === 'Delete'
                  ? 'Delete custom agent?'
                  : 'Overwrite custom copy?',
              message,
            }),
          catch: ensureError,
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
      applyAgentModePreset: (message) => this.applyAgentModePreset(message),
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
  ): Promise<void> {
    return this.runtime.runPromise(
      action.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : this.notifications.showErrorMessage(
                `${failureMessage}: ${toErrorMessage(Cause.squash(cause))}`,
              ),
        ),
      ),
    );
  }

  postStartupData(): Promise<void> {
    this.postAgentModePresets();
    return this.runtime.runPromise(
      Effect.all([this.postAgentSelectionData(), this.postCustomAgentDir()], {
        concurrency: 'unbounded',
      }).pipe(Effect.asVoid),
    );
  }

  refreshCatalogData(): Effect.Effect<void, Error, ProcessServices> {
    return Effect.gen({ self: this }, function* () {
      // Presets ride along because every roster mutation can move the
      // effective team: enabling one agent rewrites the selection as
      // `custom`, which retires whatever team was applied.
      this.postAgentModePresets();
      yield* Effect.all(
        [this.postAgentSelectionData(), this.catalogChanged()],
        { concurrency: 'unbounded' },
      );
    });
  }

  /**
   * The window's composition root owns what a catalog change means for the
   * open papers, and answers with a promise; this is the one place that
   * crosses back into it.
   */
  private catalogChanged(
    selectedToolUseAgent?: string,
  ): Effect.Effect<void, Error> {
    return Effect.tryPromise({
      try: () => this.onCatalogChanged(selectedToolUseAgent),
      catch: ensureError,
    });
  }

  private postAgentSelectionData(): Effect.Effect<
    void,
    Error,
    ProcessServices
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.registry.loadAgents();
      this.renderer.postToRenderer(
        buildAgentSelectionMessage({
          buildSelectionItems: () =>
            this.catalogController.buildSelectionItems(),
          getCustomAgentScanIssues,
        }),
      );
    });
  }

  private postCustomAgentDir(): Effect.Effect<void, Error, ProcessServices> {
    return Effect.map(
      buildCustomAgentDirMessage({
        getCustomDirStatus: () => this.directoryController.getCustomDirStatus(),
      }),
      (message) => {
        this.renderer.postToRenderer(message);
      },
    );
  }

  private postAgentModePresets(): void {
    this.renderer.postToRenderer(
      buildAgentModePresetsMessage({
        getCustomPresets: () => this.catalogController.getCustomPresets(),
        getOrchestratorAgentNames: () =>
          this.catalogController.getOrchestratorAgentNames(),
        getActiveTeamId: () => this.roster.getActiveTeamId(),
      }),
    );
  }

  private updateAgentEnabled(
    message: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED>,
  ): Promise<void> {
    return this.runtime.runPromise(
      this.roster
        .setAgentEnabled({
          category: message.category,
          source: message.agentSource,
          name: message.agentName,
          enabled: message.enabled,
        })
        .pipe(Effect.andThen(this.refreshCatalogData())),
    );
  }

  private updateAllAgentsEnabled(
    message: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.SET_ALL_AGENTS_ENABLED>,
  ): Promise<void> {
    return this.runtime.runPromise(
      this.catalogController
        .setAllAgentsEnabled(message)
        .pipe(Effect.andThen(this.refreshCatalogData())),
    );
  }

  private async setCustomAgentDir(): Promise<void> {
    const selectedPath = await this.directory.selectCustomAgentDirectory();
    if (!selectedPath) return;

    await this.runtime.runPromise(
      this.directoryController.setCustomDir(selectedPath).pipe(
        Effect.andThen(
          Effect.all([this.postCustomAgentDir(), this.refreshCatalogData()], {
            concurrency: 'unbounded',
          }),
        ),
      ),
    );
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

  private resetCustomAgentDir(): Promise<void> {
    return this.runtime.runPromise(
      this.directoryController.resetCustomDir().pipe(
        Effect.andThen(
          Effect.all([this.postCustomAgentDir(), this.refreshCatalogData()], {
            concurrency: 'unbounded',
          }),
        ),
        Effect.asVoid,
      ),
    );
  }

  private async openAgentFolder(): Promise<void> {
    const result = await this.runtime.runPromise(
      this.directoryController.planOpenAgentFolder('custom'),
    );
    if (!result.ok) {
      await this.runtime.runPromise(
        this.notifications.showErrorMessage(
          'No custom agent directory is available',
        ),
      );
      return;
    }
    await this.runtime.runPromise(this.directory.openPath(result.path));
  }

  /**
   * Create a custom agent. Mirrors the extension's `handleCreateAgent`: the
   * template path writes a rendered bundled template, while the AI path is the
   * agent-creator flow. Only the template path is wired here; AI creation needs
   * the creator flow's own UI, which this host does not present yet.
   */
  private async createAgent(
    data: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.CREATE_AGENT>,
  ): Promise<void> {
    if (data.mode !== 'template') {
      await this.runtime.runPromise(
        this.notifications.showErrorMessage(
          'Creating an agent with AI is not available in the desktop app yet. Choose "From template" instead.',
        ),
      );
      return;
    }

    const name = await this.prompts.promptText({
      title: `New ${templateAgentCategoryLabel(data.category)} agent`,
      prompt: templateAgentNamePrompt(data.category),
    });
    if (!name) return;

    const invalid = this.directoryController.validateTemplateName(name);
    if (invalid) {
      await this.runtime.runPromise(
        this.notifications.showErrorMessage(invalid),
      );
      return;
    }

    // The custom agent directory is the user's choice, outside every root,
    // so it is created through the process filesystem.
    await this.runReported(
      'Failed to create custom agent',
      Effect.gen({ self: this }, function* () {
        const customDir = yield* this.directory.getCustomAgentDirectory();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(customDir, { recursive: true });

        const plan = this.directoryController.planTemplateAgent({
          category: data.category,
          name,
          customDir,
        });

        const written = yield* writeTemplateAgentFile(
          plan,
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

        yield* this.directory.openPath(plan.filePath).pipe(
          Effect.mapError(
            (cause) =>
              new ExternalOpenFailed({
                kind: 'path',
                target: plan.filePath,
                message: `The new agent definition could not be opened: ${toErrorMessage(cause)}`,
                cause,
              }),
          ),
        );
        yield* this.notifications.showInfoMessage(
          `Created custom agent: ${plan.fileName}`,
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
  }

  /**
   * Show a hosted agent's prompt YAML. The extension opens an untitled editor;
   * the desktop has no editor surface, so the config is written to a temporary
   * file and opened with the OS handler.
   */
  private async viewRemoteAgentPrompt(
    data: AgentMessage<typeof SETTINGS_VIEW_COMMANDS.VIEW_REMOTE_AGENT_PROMPT>,
  ): Promise<void> {
    await this.runReported(
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
          yield* Effect.tryPromise({
            try: () => createTexraTempDir('texra-agent-prompt-'),
            catch: (cause) =>
              new AgentSettingsActionFailed({
                member: 'createTempDir',
                message: `A temporary directory could not be created: ${toErrorMessage(cause)}`,
                cause,
              }),
          }),
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
  }

  private async applyAgentModePreset(
    message: AgentMessage<
      typeof SETTINGS_VIEW_COMMANDS.APPLY_AGENT_MODE_PRESET
    >,
  ): Promise<void> {
    await this.runtime.runPromise(
      applySettingsTeamRoster(message.presetId, {
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
            this.postAgentModePresets();
            yield* Effect.all(
              [
                this.postAgentSelectionData(),
                this.catalogChanged(selectedToolUseAgent),
              ],
              { concurrency: 'unbounded' },
            );
          }),
      }),
    );
  }

  private async saveAgentModePreset(): Promise<void> {
    const name = await this.prompts.promptText({
      title: 'Save agent team',
      prompt: 'Name for the new team',
    });
    if (!name?.trim()) return;
    await this.runtime.runPromise(this.registry.loadAgents());
    const preset = await this.runtime.runPromise(
      this.catalogController.saveCurrentPreset(name),
    );
    this.postAgentModePresets();
    await this.onCatalogChanged();
    await this.runtime.runPromise(
      this.notifications.showInfoMessage(`Saved team "${preset.name}"`),
    );
  }

  private async deleteAgentModePreset(
    message: AgentMessage<
      typeof SETTINGS_VIEW_COMMANDS.DELETE_AGENT_MODE_PRESET
    >,
  ): Promise<void> {
    const { presetId } = message;
    const target = this.catalogController.getCustomPreset(presetId);
    if (!target) {
      await this.runtime.runPromise(
        this.notifications.showErrorMessage(`Unknown custom team: ${presetId}`),
      );
      return;
    }

    const confirmed = await this.prompts.confirm({
      title: 'Delete team?',
      message: `Delete team "${target.name}"?`,
    });
    if (!confirmed) return;

    await this.runtime.runPromise(
      this.catalogController.deleteCustomPreset(presetId),
    );
    this.postAgentModePresets();
    await this.onCatalogChanged();
  }
}
