import { BUNDLED_AGENT_DIRECTORY_NAMES } from '@agent/index/BundledAgentDirectories';
import {
  AgentDirectoryService,
  type AbsoluteDirectoryAccess,
  type AgentDirectoryIssueReporter,
} from '@agent/index/AgentDirectoryService';
import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  PathAgentDirectoryBundleSource,
} from '@agent/index/AgentDirectorySync';
import { bootstrapPlatformAgentDirectories } from '@agent/index/platformAgentDirectories';
import {
  getAgentDirectories,
  setAgentDirectories,
  type AgentDirectories,
} from '@agent/index/agentDirectoriesRegistry';
import * as logger from '@logger/logUtils';
import { AGENT_SOURCE, type AgentSource } from '@shared/schemas/agent';

export type RuntimeAgentSource = AgentSource;
export type RuntimeLocalAgentSource = Exclude<
  RuntimeAgentSource,
  typeof AGENT_SOURCE.REMOTE
>;
export type RuntimeAgentDirectories = AgentDirectories;

export interface RuntimeAgentDirectoryProvider {
  builtIn(): Promise<string>;
  builtInToolUse(): Promise<string>;
  custom(): Promise<string>;
  getDirectory(source: RuntimeAgentSource): Promise<string | undefined>;
  getAllLocal(): Promise<
    Array<{ directory: string; source: RuntimeAgentSource }>
  >;
}

export interface RuntimeCustomAgentDirectoryStore {
  get(): string | undefined;
}

export interface RuntimeAgentDirectoryVersionStore {
  get(): string | undefined;
  update(version: string | undefined): PromiseLike<void>;
}

export interface RuntimeAgentDirectoryProviderRequest {
  readonly channel: string;
  readonly customDirectoryStore: RuntimeCustomAgentDirectoryStore;
  readonly absoluteDirectories: AbsoluteDirectoryAccess;
  readonly issueReporter: AgentDirectoryIssueReporter;
}

export interface RuntimeBundledAgentDirectorySyncRequest {
  readonly channel: string;
  readonly resourcesPath: string;
  readonly currentVersion: string | undefined;
  readonly versionStore: RuntimeAgentDirectoryVersionStore;
}

export interface RuntimePlatformAgentDirectoryBootstrapOptions extends RuntimeBundledAgentDirectorySyncRequest {
  readonly customDirectoryStore: RuntimeCustomAgentDirectoryStore;
}

export const RUNTIME_BUNDLED_AGENT_DIRECTORY_NAMES =
  BUNDLED_AGENT_DIRECTORY_NAMES;

export function setRuntimeAgentDirectories(
  dirs: RuntimeAgentDirectories,
): void {
  setAgentDirectories(dirs);
}

function isRuntimeLocalAgentSource(
  source: RuntimeAgentSource,
): source is RuntimeLocalAgentSource {
  return source !== AGENT_SOURCE.REMOTE;
}

export async function requireRuntimeAgentDirectory(
  source: RuntimeLocalAgentSource,
): Promise<string> {
  const dirs = getAgentDirectories();
  switch (source) {
    case AGENT_SOURCE.CUSTOM:
      return dirs.custom();
    case AGENT_SOURCE.BUILT_IN_WORKFLOW:
      return dirs.builtIn();
    case AGENT_SOURCE.BUILT_IN_TOOL_USE:
      return dirs.builtInToolUse();
  }

  const unreachable: never = source;
  throw new Error(`Unsupported local agent source: ${unreachable}`);
}

export async function resolveRuntimeAgentDirectory(
  source: RuntimeAgentSource,
): Promise<string | undefined> {
  if (!isRuntimeLocalAgentSource(source)) {
    return undefined;
  }
  return requireRuntimeAgentDirectory(source);
}

export function createRuntimeAgentDirectoryProvider({
  channel,
  customDirectoryStore,
  absoluteDirectories,
  issueReporter,
}: RuntimeAgentDirectoryProviderRequest): RuntimeAgentDirectoryProvider {
  return new AgentDirectoryService({
    storage: new GlobalStorageAgentDirectoryStorage(),
    customDirectoryStore,
    absoluteDirectories,
    issueReporter,
    logger: {
      debug: (message) => logger.debug(channel, message),
      error: (message) => logger.error(channel, message),
    },
  });
}

export async function syncRuntimeBundledAgentDirectories({
  channel,
  resourcesPath,
  currentVersion,
  versionStore,
}: RuntimeBundledAgentDirectorySyncRequest): Promise<void> {
  const sync = new BundledAgentDirectorySync({
    bundleSource: new PathAgentDirectoryBundleSource(resourcesPath),
    storage: new GlobalStorageAgentDirectoryStorage(),
    versionStore,
    logger: {
      info: (message) => logger.info(channel, message),
      warn: (message) => logger.warn(channel, message),
    },
  });

  await sync.reconcile(currentVersion);
}

export function bootstrapRuntimeAgentDirectories(
  options: RuntimePlatformAgentDirectoryBootstrapOptions,
): Promise<void> {
  const { resourcesPath, ...platformOptions } = options;
  return bootstrapPlatformAgentDirectories({
    ...platformOptions,
    bundleSource: new PathAgentDirectoryBundleSource(resourcesPath),
  });
}
