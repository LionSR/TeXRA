import {
  AgentDirectoryService,
  type AbsoluteDirectoryAccess,
  type AgentDirectoryDocsId,
  type AgentDirectoryIssueReporter,
  type AgentDirectoryPathStorage,
  type AgentDirectoryServiceLogger,
  type AgentDirectoryServiceOptions,
  type CustomAgentDirectoryStore,
} from '@agent/index/AgentDirectoryService';
import {
  BundledAgentDirectorySync,
  GlobalStorageAgentDirectoryStorage,
  PathAgentDirectoryBundleSource,
  type AgentDirectoryBundleSource,
  type AgentDirectoryStorage,
  type AgentDirectorySyncLogger,
  type AgentDirectoryVersionStore,
  type BundledAgentDirectorySyncOptions,
} from '@agent/index/AgentDirectorySync';
import {
  bootstrapPlatformAgentDirectories,
  type PlatformAgentDirectoryBootstrapOptions,
} from '@agent/index/platformAgentDirectories';
import {
  setAgentDirectories,
  type AgentDirectories,
} from '@agent/index/agentDirectoriesRegistry';
import type { AgentSource } from '@shared/schemas/agent';

export type RuntimeAgentSource = AgentSource;
export type RuntimeAgentDirectories = AgentDirectories;
export type RuntimeAgentDirectoryServiceInstance = AgentDirectoryService;
export type RuntimeAgentDirectoryServiceOptions = AgentDirectoryServiceOptions;
export type RuntimeAbsoluteDirectoryAccess = AbsoluteDirectoryAccess;
export type RuntimeAgentDirectoryDocsId = AgentDirectoryDocsId;
export type RuntimeAgentDirectoryIssueReporter = AgentDirectoryIssueReporter;
export type RuntimeAgentDirectoryPathStorage = AgentDirectoryPathStorage;
export type RuntimeAgentDirectoryServiceLogger = AgentDirectoryServiceLogger;
export type RuntimeCustomAgentDirectoryStore = CustomAgentDirectoryStore;
export type RuntimeAgentDirectoryBundleSource = AgentDirectoryBundleSource;
export type RuntimeAgentDirectoryStorage = AgentDirectoryStorage;
export type RuntimeAgentDirectorySyncLogger = AgentDirectorySyncLogger;
export type RuntimeAgentDirectoryVersionStore = AgentDirectoryVersionStore;
export type RuntimeBundledAgentDirectorySyncOptions =
  BundledAgentDirectorySyncOptions;
export type RuntimePlatformAgentDirectoryBootstrapOptions =
  PlatformAgentDirectoryBootstrapOptions;

export const RuntimeAgentDirectoryService = AgentDirectoryService;
export const RuntimeBundledAgentDirectorySync = BundledAgentDirectorySync;
export const RuntimeGlobalStorageAgentDirectoryStorage =
  GlobalStorageAgentDirectoryStorage;
export const RuntimePathAgentDirectoryBundleSource =
  PathAgentDirectoryBundleSource;

export function setRuntimeAgentDirectories(
  dirs: RuntimeAgentDirectories,
): void {
  setAgentDirectories(dirs);
}

export function bootstrapRuntimeAgentDirectories(
  options: RuntimePlatformAgentDirectoryBootstrapOptions,
): Promise<void> {
  return bootstrapPlatformAgentDirectories(options);
}
