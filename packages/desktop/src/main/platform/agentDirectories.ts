import {
  bootstrapPlatformAgentDirectories,
  createPlatformAgentDirectories,
} from '@agent/index/platformAgentDirectories';
import { GlobalStateKey } from '@common/state/stateKeys';
import { platform } from '@platform/platform';

export function createElectronAgentDirectories() {
  return createPlatformAgentDirectories({
    channel: 'desktop',
    customDirectoryStore: {
      get: () =>
        platform().globalState.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR),
    },
  });
}

export async function bootstrapElectronAgentDirectories(
  resourcesPath: string,
  appVersion: string | undefined,
): Promise<void> {
  await bootstrapPlatformAgentDirectories({
    channel: 'desktop',
    resourcesPath,
    currentVersion: appVersion,
    customDirectoryStore: {
      get: () =>
        platform().globalState.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR),
    },
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
