/**
 * The settings-view commands both GUI hosts answer with the same body. The
 * extension and the desktop each built these arms themselves -- the same
 * controller call, the same repaint after it, three spellings of "open a URL"
 * -- so the body lives here once and a host binds only what it does its own
 * way: how the Models tab is re-posted, how the model catalog reloads, and
 * how a failed key write is presented.
 *
 * A host spreads these arms into its `SettingsViewInboundHandlerRegistry` and
 * keeps its own entries for every other command, so the registry's mapped
 * type still names a command neither side decided.
 */
import { Effect } from 'effect';

import type {
  ProviderKeyActionFailed,
  SettingsProfileKeyController,
} from '@controllers/settingsView/SettingsProfileKeyController';
import type { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import type { ExternalOpener } from '@hosts/uiHosts';
import type { ProcessServices } from '@platform/processRuntime';
import type { ToolProbeInputs } from '@tools/toolProbes';
import { GITHUB_TOKEN_CREATE_URL } from '@tools/github/githubAuth';
import { refreshToolAvailability } from '@tools/toolAvailability';

/** The commands {@link sharedSettingsCommands} answers. */
type SharedSettingsCommand =
  | 'setProviderKey'
  | 'removeProviderKey'
  | 'openProviderKeyUrl'
  | 'openExternalUrl'
  | 'openGitHubTokenUrl'
  | 'openToolInstallUrl'
  | 'setModelEnabled'
  | 'setModelReasoningLevel'
  | 'recheckToolStatus';

type HostEffect = Effect.Effect<void, Error, ProcessServices>;

/** What a host does its own way behind the shared arms. */
interface SharedSettingsCommandBindings {
  /** Re-post the Models tab through the host's view transport. */
  postModelSelection(): HostEffect;
  /** Reload the model catalog every open launcher shows. */
  refreshModelCatalog(): HostEffect;
  /** Present a failed key write, or a failed refresh after one, and repaint
   *  the profile it left stale. */
  reportProviderKeyFailure(error: ProviderKeyActionFailed): HostEffect;
}

/** The ports a host binds before these arms have anything left to decide. */
export interface SharedSettingsCommandPorts {
  readonly profileKeys: Pick<
    SettingsProfileKeyController<ProcessServices>,
    'setProviderKey' | 'removeProviderKey' | 'openProviderKeyUrl'
  >;
  readonly modelSelection: Pick<
    SettingsModelSelectionController,
    'setModelEnabled' | 'setReasoningLevel'
  >;
  readonly externalOpener: ExternalOpener;
  /** The session's workspace and config, which the tool probes ask about. */
  readonly toolProbes: ToolProbeInputs;
  readonly host: SharedSettingsCommandBindings;
}

/** The shared arms, for a host to spread into its settings registry. */
export function sharedSettingsCommands(
  ports: SharedSettingsCommandPorts,
): Pick<SettingsViewInboundHandlerRegistry, SharedSettingsCommand> {
  const { host } = ports;
  return {
    setProviderKey: (message) =>
      ports.profileKeys
        .setProviderKey(message.provider)
        .pipe(
          Effect.catchTag('ProviderKeyActionFailed', (error) =>
            host.reportProviderKeyFailure(error),
          ),
        ),
    removeProviderKey: (message) =>
      ports.profileKeys
        .removeProviderKey(message.provider)
        .pipe(
          Effect.catchTag('ProviderKeyActionFailed', (error) =>
            host.reportProviderKeyFailure(error),
          ),
        ),
    openProviderKeyUrl: (message) =>
      ports.profileKeys.openProviderKeyUrl(message.provider),
    openExternalUrl: (message) =>
      ports.externalOpener.openExternal(message.url),
    openGitHubTokenUrl: () =>
      ports.externalOpener.openExternal(GITHUB_TOKEN_CREATE_URL),
    openToolInstallUrl: (message) =>
      ports.externalOpener.openExternal(message.url),
    setModelEnabled: (message) =>
      ports.modelSelection
        .setModelEnabled({
          modelName: message.modelName,
          enabled: message.enabled,
        })
        .pipe(
          Effect.andThen(host.postModelSelection()),
          // The options cache is invalidated by the writer itself.
          Effect.andThen(host.refreshModelCatalog()),
        ),
    setModelReasoningLevel: (message) =>
      ports.modelSelection
        .setReasoningLevel({
          modelName: message.modelName,
          level: message.level,
        })
        .pipe(Effect.andThen(host.postModelSelection())),
    // The Tools tab repaints on the `toolAvailabilityChanged` signal this
    // re-probe emits, on both hosts.
    recheckToolStatus: () => refreshToolAvailability(ports.toolProbes),
  };
}
