import {
  isFileNotFoundError,
  isNotADirectoryError,
} from '@common/errors/errorPredicates';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import {
  AgentDirectoryService,
  type AgentDirectoryIssueReporter,
} from './AgentDirectoryService';
import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  type AgentDirectoryBundleSource,
  type AgentDirectoryVersionStore,
} from './AgentDirectorySync';

interface PlatformAgentDirectoryOptions {
  channel: string;
  customDirectoryStore: { get(): string | undefined };
  /** Defaults to logging the issue at `warn`; hosts with an interactive
   * notification surface (e.g. the VS Code extension) can override it. */
  issueReporter?: AgentDirectoryIssueReporter;
}

export interface PlatformAgentDirectoryBootstrapOptions {
  channel: string;
  bundleSource: AgentDirectoryBundleSource;
  currentVersion: string | undefined;
  versionStore: AgentDirectoryVersionStore;
}

export function createPlatformAgentDirectories(
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
          // Match AbsoluteFS/BaseFS.statIfExists: an ancestor path component
          // that turned out to be a file (ENOTDIR) means "does not exist"
          // here too, not an error to propagate.
          if (isFileNotFoundError(error) || isNotADirectoryError(error)) {
            return false;
          }
          throw error;
        }
      },
      ensureDir: (target) => platform().fs.createDirectory(target),
    },
    issueReporter: options.issueReporter ?? {
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
}
