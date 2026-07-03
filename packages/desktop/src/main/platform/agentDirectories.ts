import { platform } from '@platform/platform';
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import { PathAgentDirectoryBundleSource } from '@agent/index/AgentDirectorySync';
import { GlobalStateKey } from '@shared/state/stateKeys';

export async function bootstrapElectronAgentDirectories(
  resourcesPath: string,
  appVersion: string | undefined,
): Promise<void> {
  await bootstrapPlatformAgentDirectories({
    channel: 'desktop',
    bundleSource: new PathAgentDirectoryBundleSource(resourcesPath),
    currentVersion: appVersion,
    versionStore: {
      get: () =>
        platform().globalState.get<string>(GlobalStateKey.LAST_KNOWN_VERSION),
      update: (version) =>
        platform().globalState.update(
          GlobalStateKey.LAST_KNOWN_VERSION,
          version,
        ),
    },
  });
}
