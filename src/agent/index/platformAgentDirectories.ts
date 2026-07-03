import { platform } from '@platform/platform';
import { isFileNotFoundError } from '@common/errors/errorPredicates';
import * as logger from '@logger/logUtils';
import { AgentDirectoryService } from './AgentDirectoryService';
import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  type AgentDirectoryBundleSource,
  type AgentDirectoryVersionStore,
} from './AgentDirectorySync';
import { setAgentDirectories } from './agentDirectoriesRegistry';

interface PlatformAgentDirectoryOptions {
  channel: string;
  customDirectoryStore: { get(): string | undefined };
}

export interface PlatformAgentDirectoryBootstrapOptions extends PlatformAgentDirectoryOptions {
  bundleSource: AgentDirectoryBundleSource;
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
        logger.warn(
          options.channel,
          `${message}. See documentation: ${docsId}`,
        ),
    },
    logger: {
      debug: (message, data) =>
        logger.debug(options.channel, message, { data }),
      error: (message, data) =>
        logger.error(options.channel, message, { data }),
    },
  });
}

export async function bootstrapPlatformAgentDirectories(
  options: PlatformAgentDirectoryBootstrapOptions,
): Promise<void> {
  const sync = new BundledAgentDirectorySync({
    bundleSource: options.bundleSource,
    storage: new GlobalStorageAgentDirectoryStorage(),
    versionStore: options.versionStore,
    logger: {
      info: (message, data) => logger.info(options.channel, message, { data }),
      warn: (message, data) => logger.warn(options.channel, message, { data }),
    },
  });

  await sync.reconcile(options.currentVersion);
  setAgentDirectories(createPlatformAgentDirectories(options));
}
