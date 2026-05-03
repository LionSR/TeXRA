import { AgentDirectoryService } from '@agent/index/AgentDirectoryService';
import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  PathAgentDirectoryBundleSource,
} from '@agent/index/AgentDirectorySync';
import { setAgentDirectories } from '@agent/index/agentDirectoriesRegistry';
import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { GlobalStateKey } from '@common/state/stateKeys';
import { platform } from '@platform/platform';

export function createElectronAgentDirectories(): AgentDirectoryService {
  return new AgentDirectoryService({
    storage: new GlobalStorageAgentDirectoryStorage(),
    customDirectoryStore: {
      get: () =>
        platform().globalState.get<string>(GlobalStateKey.CUSTOM_AGENT_DIR),
    },
    absoluteDirectories: {
      exists: async (target) => {
        try {
          await platform().fs.stat(target);
          return true;
        } catch (error) {
          if (isFileNotFoundError(error)) return false;
          throw error;
        }
      },
      ensureDir: (target) => platform().fs.createDirectory(target),
    },
    issueReporter: {
      report: async (message, docsId) =>
        platform().log.warn(
          'desktop',
          `${message}. See documentation: ${docsId}`,
        ),
    },
    logger: {
      debug: (message) => platform().log.debug('desktop', message),
      error: (message) => platform().log.error('desktop', message),
    },
  });
}

export async function bootstrapElectronAgentDirectories(
  resourcesPath: string,
  appVersion: string | undefined,
): Promise<void> {
  const sync = new BundledAgentDirectorySync({
    bundleSource: new PathAgentDirectoryBundleSource(resourcesPath),
    storage: new GlobalStorageAgentDirectoryStorage(),
    versionStore: {
      get: () =>
        platform().globalState.get<string>(GlobalStateKey.LAST_KNOWN_VERSION),
      update: (version) =>
        platform().globalState.update(
          GlobalStateKey.LAST_KNOWN_VERSION,
          version,
        ),
    },
    logger: {
      info: (message) => platform().log.info('desktop', message),
      warn: (message) => platform().log.warn('desktop', message),
    },
  });

  await sync.reconcile(appVersion);
  setAgentDirectories(createElectronAgentDirectories());
}
