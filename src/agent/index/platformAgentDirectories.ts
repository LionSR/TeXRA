// Local imports - agent index
import { platform } from '@platform/platform';
import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { AgentDirectoryService } from './AgentDirectoryService';
import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  PathAgentDirectoryBundleSource,
  type AgentDirectoryVersionStore,
} from './AgentDirectorySync';
import { setAgentDirectories } from './agentDirectoriesRegistry';

// Local imports - common

// Local imports - platform

interface PlatformAgentDirectoryOptions {
  channel: string;
  customDirectoryStore: { get(): string | undefined };
}

export interface PlatformAgentDirectoryBootstrapOptions extends PlatformAgentDirectoryOptions {
  resourcesPath: string;
  currentVersion: string | undefined;
  versionStore: AgentDirectoryVersionStore;
}

function createPlatformAgentDirectories(
  options: PlatformAgentDirectoryOptions,
): AgentDirectoryService {
  return new AgentDirectoryService({
    storage: new GlobalStorageAgentDirectoryStorage(),
    customDirectoryStore: options.customDirectoryStore,
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
          options.channel,
          `${message}. See documentation: ${docsId}`,
        ),
    },
    logger: {
      debug: (message) => platform().log.debug(options.channel, message),
      error: (message) => platform().log.error(options.channel, message),
    },
  });
}

export async function bootstrapPlatformAgentDirectories(
  options: PlatformAgentDirectoryBootstrapOptions,
): Promise<void> {
  const sync = new BundledAgentDirectorySync({
    bundleSource: new PathAgentDirectoryBundleSource(options.resourcesPath),
    storage: new GlobalStorageAgentDirectoryStorage(),
    versionStore: options.versionStore,
    logger: {
      info: (message) => platform().log.info(options.channel, message),
      warn: (message) => platform().log.warn(options.channel, message),
    },
  });

  await sync.reconcile(options.currentVersion);
  setAgentDirectories(createPlatformAgentDirectories(options));
}
