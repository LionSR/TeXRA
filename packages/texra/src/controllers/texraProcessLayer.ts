/**
 * The one process layer the three TeXRA hosts build their runtime over: the
 * harness's `processLayer` with TeXRA's policy fixed, so a host passes only
 * what it decides and hands the result to `ManagedRuntime.make`. TeXRA's
 * part is the settings catalog, the command directories, its plugins over
 * the window table whose attached windows their editor tools read
 * (`HostWindows`), the one credential store under the storage root, the
 * project folder its skills are read from, its resources root, and the
 * usage log.
 */

// Third-party imports
import { join } from 'node:path';

import { Effect, FileSystem, Layer, Schema, type LogLevel } from 'effect';

// Local imports
import { processLayer, type ProcessServices } from '@texra-ai/worldline/host';
import {
  emitAppSignal,
  Secrets,
  HostResources,
} from '@texra-ai/worldline/plugins';
import {
  CommandDirs,
  FileSecrets,
  meansAbsent,
  nodePlatformServices,
  secretsDirectory,
} from '@texra-ai/worldline/node';
import {
  usageLogLayer,
  type UsageLogOptions,
} from '@telemetry/UsageLogService';
import {
  HostWindows,
  makeWindowTable,
} from '@texra/controllers/server/hostWindows';
import { commandDirs } from '@texra/platform/defaults/commandDirs';
import { TEXRA_STORAGE_DIR_NAME } from '@texra/platform/defaults/nodeStorage';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';

import { texraPlugins } from '@texra/tools/registry';
import type { Sessions, SkillSourceOptions } from '@texra-ai/worldline';
import type { ClientIdentity } from '@texra-ai/llm/node';

/**
 * TeXRA as the model providers name it: the client a ChatGPT sign-in
 * registers, the referrer on a Grok sign-in, the namespace a ChatGPT
 * plan's tools sit in, and the client name an MCP server is told.
 */
export const TEXRA_CLIENT: ClientIdentity = Object.freeze({
  name: 'TeXRA',
  id: 'texra',
});

/** A host's resources directory holds no bundled plugin resources: a bundle
 *  copied without its `resources/`, or a broken checkout. */
class ResourcesNotFound extends Schema.TaggedError<ResourcesNotFound>()(
  'ResourcesNotFound',
  { message: Schema.String },
) {}

/** `resourcesPath`, failing by its path when it holds no bundled `plugins/`
 *  directory: what a host checks before it builds {@link texraProcessLayer}
 *  over that path. */
export const checkResourcesPath = Effect.fn('checkResourcesPath')(function* (
  resourcesPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const plugins = join(resourcesPath, 'plugins');
  const isDirectory = yield* fs.stat(plugins).pipe(
    Effect.map((info) => info.type === 'Directory'),
    Effect.catchIf(meansAbsent, () => Effect.succeed(false)),
  );
  if (!isDirectory)
    return yield* new ResourcesNotFound({
      message: `TeXRA resources not found: ${resourcesPath} holds no plugins/ directory`,
    });
  return resourcesPath;
});

/** What a host decides about its process: its name and host-only plugin
 *  inputs (as `texraPlugins` takes them), and the facts below. */
interface TexraProcessHost extends Omit<
  Parameters<typeof texraPlugins>[0],
  'editors'
> {
  /** The storage root the process opens: sessions, global state, secrets. */
  readonly storageRoot: string;
  /** The packaged resources root the bundled plugins' resources are read
   *  from. */
  readonly resourcesPath: string;
  /** The flags every skill read uses (the CLI's `--source`). */
  readonly skillSourceOptions?: SkillSourceOptions;
  /** What the usage log stamps on each entry; the runtime's disposal
   *  drains the log's queue. The host's own telemetry switch is
   *  `HostTelemetrySwitch`, provided by the host that has one. */
  readonly usageLog: UsageLogOptions;
  /** The runtime's floor for Effect diagnostics. */
  readonly minimumLogLevel: LogLevel.LogLevel;
  /** A single-project host's folder, whose `.env` its own reads see. */
  readonly workspace?: string;
}

/** The process services, sessions and windows of one TeXRA host process. */
export const texraProcessLayer = ({
  storageRoot,
  resourcesPath,
  skillSourceOptions,
  usageLog,
  minimumLogLevel,
  workspace,
  ...pluginHost
}: TexraProcessHost): Layer.Layer<ProcessServices | Sessions | HostWindows> => {
  const windows = makeWindowTable();
  const plugins = texraPlugins({ ...pluginHost, editors: windows.editors });
  const services = processLayer({
    storageRoot,
    settings: TEXRA_SETTINGS.catalog,
    plugins,
    skills: {
      resourcesPath,
      // A project's skills sit beside its `.texra/config.json`.
      projectDataDirName: TEXRA_STORAGE_DIR_NAME,
      skillSourceOptions,
    },
    // One credential store every host shares, announcing each key it writes.
    secrets: Secrets.announcing(
      (announce) => new FileSecrets(secretsDirectory(storageRoot), announce),
      TEXRA_CLIENT,
    ),
    // The templates and bundled plugin files ship in the host's bundle.
    hostResources: Layer.succeed(HostResources)({
      resourcesRoot: resourcesPath,
    }),
    usageLog: usageLogLayer(usageLog),
    minimumLogLevel,
    workspace,
    // TeXRA's plugin list is fixed in this build, so a list the harness
    // refuses is a defect of the build, not a failure a host can recover.
  }).pipe(
    Layer.orDie,
    // Beneath every session the process builds, so each command it runs
    // resolves on the app's directories too.
    Layer.provideMerge(
      Layer.sync(CommandDirs)(() => {
        const dirs = commandDirs();
        return () => dirs;
      }),
    ),
    // The Node filesystem, path and supervised spawner, once per process.
    Layer.provide(nodePlatformServices),
  );
  return Layer.merge(
    HostWindows.layer(windows),
    // Every process follows keys written by other hosts, even without a
    // window. The watch closes before the services that consume its signals.
    Layer.effectDiscard(
      Effect.forkScoped(
        FileSecrets.watch(secretsDirectory(storageRoot), (key) =>
          emitAppSignal('credentialChanged', { key }),
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(services));
};
