/**
 * What a CLI command runs over. Every command builds its own runtime from
 * the layer its program needs, and disposes it when the command ends
 * (`defineCliCommand`): the process services over `texraProcessLayer`, with
 * the command's {@link CliPlatform} for a command over the `--cwd` project;
 * the process services alone for the background service, which serves many
 * projects; and only the Node services and the credential store for the two
 * commands that must create nothing under the storage root.
 */
import { Layer, ManagedRuntime } from 'effect';

import type { Sessions } from '@texra-ai/harness';
import { Secrets, type ProcessServices } from '@texra-ai/harness/host';
import { withForkFailureReporting } from '@texra-ai/harness/transcript';
import {
  effectDiagnosticsLayer,
  FileSecrets,
  nodePlatformServices,
  secretsDirectory,
} from '@texra-ai/harness/node';
import type { HostWindows } from '@texra/controllers/server/hostWindows';
import { texraProcessLayer } from '@texra/controllers/texraProcessLayer';

import { readCliVersion, type CliContext } from './cliContext';
import { CliPlatform, type CliPlatformOptions } from './initPlatform';
import { validationModelLayer } from './validationModel';

/** What a CLI command's program runs over: the process services, its
 *  sessions, and the windows attached to it (`texra serve`'s). */
export type CliServices = ProcessServices | Sessions | HostWindows;

/** The runtime of a command over the `--cwd` project: {@link CliServices}
 *  and its {@link CliPlatform}. */
export type CliProcessRuntime = ManagedRuntime.ManagedRuntime<
  CliServices | CliPlatform,
  never
>;

/** The context fields a command's runtime is built from. */
type CliRuntimeContext = Pick<
  CliContext,
  | 'config'
  | 'cwd'
  | 'minimumLogLevel'
  | 'quietLogs'
  | 'resourcesPath'
  | 'skillSourceOptions'
  | 'storageRoot'
>;

/**
 * The process services of a command: its resources root, its `--source`
 * flags and its diagnostics floor, and `workspace`, the project whose `.env`
 * its model availability and runs read (absent for the background service,
 * which serves many projects, so a project's broken `.env` never blocks a
 * stop).
 */
export function cliProcessLayer(
  context: CliRuntimeContext,
  workspace?: string,
): Layer.Layer<CliServices> {
  return texraProcessLayer({
    name: 'cli',
    storageRoot: context.storageRoot,
    resourcesPath: context.resourcesPath,
    skillSourceOptions: context.skillSourceOptions,
    workspace,
    usageLog: { version: readCliVersion(), editorType: 'cli' },
    minimumLogLevel: context.minimumLogLevel,
  }).pipe(Layer.provide(validationModelLayer));
}

/** The runtime of a command over the `--cwd` project, with its platform. */
export function makeCliProcessRuntime(
  context: CliRuntimeContext,
  platform: CliPlatformOptions = {},
): CliProcessRuntime {
  // The platform hands its own runtime to the modules that run programs at
  // a Promise edge and disposes it when the process leaves, so it is given
  // the one being made here; it reads it only once the runtime runs.
  const runtime: CliProcessRuntime = withForkFailureReporting(
    ManagedRuntime.make(
      CliPlatform.layer(context, platform, () => runtime).pipe(
        Layer.provideMerge(cliProcessLayer(context, context.cwd)),
      ),
    ),
  );
  return runtime;
}

/**
 * What `clone` and `install-github-action` run over: the Node file and
 * process services, the credential store and the diagnostics floor. Neither
 * serves application state or reads a global record, and opening either
 * store would create the global storage directory and its database, which an
 * env-token clone on a read-only storage root must not require. Nothing in
 * such a process listens for a credential change, so the store announces
 * none.
 */
export const cliSecretsLayer = (
  context: Pick<CliContext, 'minimumLogLevel' | 'storageRoot'>,
) =>
  Layer.mergeAll(
    nodePlatformServices,
    Secrets.layer(
      new FileSecrets(secretsDirectory(context.storageRoot), () => {}),
    ),
    effectDiagnosticsLayer(context.minimumLogLevel),
  );
