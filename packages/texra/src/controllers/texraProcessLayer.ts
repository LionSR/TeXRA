/**
 * The one process layer the three TeXRA hosts build their runtime over: the
 * harness's `processLayer` with TeXRA's policy fixed, so a host passes only
 * what it decides and hands the result to `ManagedRuntime.make`. TeXRA's
 * part is the settings catalog, the command directories, its plugins over
 * one editor registry the host's windows attach to (`HostWindows`), the one
 * credential store under the storage root, the agent directories with their
 * team membership, and the first-install tool switches.
 */

// Third-party imports
import { Effect, Layer, type LogLevel } from 'effect';

// Local imports
import {
  AgentDirectories,
  AgentDirectoryService,
  AppState,
  processLayer,
  type ProcessLayerOptions,
  type ProcessServices,
  Secrets,
  seedDisabledToolDefaults,
  type SkillSourceOptions,
  type StateStore,
} from '@texra-ai/harness/host';
import {
  FileSecrets,
  type GlobalDatabase,
  secretsDirectory,
} from '@texra-ai/harness/node';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import { commandDirs } from '@texra/platform/defaults/commandDirs';
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
   *  read from. Absent only for a CLI entry that loads neither. */
  readonly resourcesPath?: string;
  /** The flags every skill read uses (the CLI's `--source`). */
  readonly skillSourceOptions?: SkillSourceOptions;
  /** The host's usage log (`usageLogLayer`), stamped with its version and
   *  editor; the runtime's disposal drains its queue. */
  readonly usageLog: NonNullable<ProcessLayerOptions['usageLog']>;
  /** The runtime's floor for Effect diagnostics. */
  readonly minimumLogLevel: LogLevel.LogLevel;
  /** A single-project host's folder, whose `.env` its own reads see. */
  readonly workspace?: string;
  /** Where a custom agent directory's problem is shown, on the agent-load
   *  log channel it is given; absent, the problem is logged there. */
  readonly agentIssues?: (
    channel: string,
    message: string,
    docsId: 'custom-agents',
  ) => Effect.Effect<void>;
  /**
   * The global stores served in place of the storage root's own, for a
   * process that must create nothing under that root (the platform-less CLI
   * entries' refusals). Nothing is seeded into them.
   */
  readonly globalStores?: {
    readonly appState: StateStore;
    readonly globalDatabase: Layer.Layer<GlobalDatabase>;
  };
}

/** The log channel the agent directories report on. */
const AGENT_LOAD_CHANNEL = 'AgentLoad';

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
    commandDirs,
    plugins,
    ...(resourcesPath !== undefined && {
      skills: { resourcesPath, skillSourceOptions },
    }),
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
            channel: AGENT_LOAD_CHANNEL,
            resourcesPath: resourcesPath ?? '',
            state,
            teamMembers,
            ...(agentIssues && {
              issueReporter: {
                report: (message, docsId) =>
                  agentIssues(AGENT_LOAD_CHANNEL, message, docsId),
              },
            }),
          }),
      ),
    ),
    usageLog,
    minimumLogLevel,
    workspace,
    ...(globalStores && {
      appState: AppState.layer(globalStores.appState),
      globalDatabase: globalStores.globalDatabase,
    }),
  });
  // First install switches the opt-in plugins off, before anything reads the
  // switches; the seed is a no-op once the user's list exists. A global store
  // that cannot be read or written is a platform defect.
  const seeded = globalStores
    ? services
    : Layer.effectDiscard(
        Effect.flatMap(AppState, (state) =>
          seedDisabledToolDefaults(state, plugins),
        ).pipe(Effect.orDie),
      ).pipe(Layer.provideMerge(services));
  return Layer.merge(seeded, HostWindows.layer(editors));
};
