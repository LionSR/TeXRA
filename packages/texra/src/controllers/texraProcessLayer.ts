/**
 * The one process layer the three TeXRA hosts build their runtime over: the
 * harness's `processLayer` with TeXRA's policy fixed, so a host passes only
 * what it decides and hands the result to `ManagedRuntime.make`. TeXRA's
 * part is the settings catalog, the command directories, its plugins over
 * one editor registry the host's windows attach to (`HostWindows`), the one
 * credential store under the storage root, the project folder its skills
 * are read from, the agent directories with their team membership, and the
 * usage log.
 */

// Third-party imports
import { Effect, Layer, type LogLevel } from 'effect';

// Local imports
import {
  AgentDirectories,
  AgentDirectoryService,
  AppState,
  processLayer,
  type ProcessServices,
  Secrets,
  type SkillSourceOptions,
  type StateStore,
} from '@texra-ai/harness/host';
import {
  CommandDirs,
  FileSecrets,
  type GlobalDatabase,
  secretsDirectory,
} from '@texra-ai/harness/node';
import {
  usageLogLayer,
  type UsageLogOptions,
} from '@telemetry/UsageLogService';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import { commandDirs } from '@texra/platform/defaults/commandDirs';
import { TEXRA_STORAGE_DIR_NAME } from '@texra/platform/defaults/nodeStorage';
import { teamMembers } from '@texra/shared/agentTeams';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { makeEditorHost } from '@texra/tools/editorHost';
import { texraPlugins } from '@texra/tools/registry';
import type { Sessions } from '@texra-ai/harness';

/** What a host decides about its process: its name and host-only plugin
 *  inputs (as `texraPlugins` takes them), and the facts below. */
export interface TexraProcessHost extends Omit<
  Parameters<typeof texraPlugins>[0],
  'editors'
> {
  /** The storage root the process opens: sessions, global state, secrets. */
  readonly storageRoot: string;
  /** The packaged resources root the built-in agents and bundled skills are
   *  read from. */
  readonly resourcesPath: string;
  /** The flags every skill read uses (the CLI's `--source`). */
  readonly skillSourceOptions?: SkillSourceOptions;
  /** What the usage log stamps on each entry, and the host's own live
   *  telemetry switch; the runtime's disposal drains the log's queue. */
  readonly usageLog: UsageLogOptions;
  /** The runtime's floor for Effect diagnostics. */
  readonly minimumLogLevel: LogLevel.LogLevel;
  /** A single-project host's folder, whose `.env` its own reads see. */
  readonly workspace?: string;
  /** Where a custom agent directory's problem is shown (on the agent
   *  directories' log channel); absent, the problem is logged there. */
  readonly agentIssues?: (
    message: string,
    docsId: 'custom-agents',
  ) => Effect.Effect<void>;
  /**
   * The global stores served in place of the storage root's own, for a
   * process that must create nothing under that root (the platform-less CLI
   * entries' refusals). The first-install tool switches are not seeded
   * into them.
   */
  readonly globalStores?: {
    readonly appState: StateStore;
    readonly globalDatabase: Layer.Layer<GlobalDatabase>;
  };
}

/** The process services, sessions and windows of one TeXRA host process. */
export const texraProcessLayer = ({
  storageRoot,
  resourcesPath,
  skillSourceOptions,
  usageLog,
  minimumLogLevel,
  workspace,
  agentIssues,
  globalStores,
  ...pluginHost
}: TexraProcessHost): Layer.Layer<ProcessServices | Sessions | HostWindows> => {
  const editors = makeEditorHost();
  const plugins = texraPlugins({ ...pluginHost, editors });
  const services = processLayer({
    storageRoot,
    settings: TEXRA_SETTINGS.catalog,
    plugins,
    skills: {
      resourcesPath,
      // A project's skills sit beside its `.texra/config.json`.
      projectFolder: TEXRA_STORAGE_DIR_NAME,
      skillSourceOptions,
    },
    // One credential store every host shares, announcing each key it writes.
    secrets: Secrets.announcing(
      (announce) => new FileSecrets(secretsDirectory(storageRoot), announce),
    ),
    // Built-in agents are read straight out of the host's own bundle; the
    // custom directory is the one the shared application state names.
    agentDirectories: Layer.effect(
      AgentDirectories,
      Effect.map(
        AppState,
        (state) =>
          new AgentDirectoryService({
            resourcesPath,
            state,
            teamMembers,
            ...(agentIssues && { issueReporter: { report: agentIssues } }),
          }),
      ),
    ),
    usageLog: usageLogLayer(usageLog),
    minimumLogLevel,
    workspace,
    ...(globalStores && {
      appState: AppState.layer(globalStores.appState),
      globalDatabase: globalStores.globalDatabase,
    }),
    // TeXRA's plugin list is fixed in this build, so a list the harness
    // refuses is a defect of the build, not a failure a host can recover.
  }).pipe(
    Layer.orDie,
    // Beneath every session the process builds, so each command it runs
    // resolves on the app's directories too.
    Layer.provideMerge(Layer.succeed(CommandDirs)(commandDirs)),
  );
  return Layer.merge(services, HostWindows.layer(editors));
};
