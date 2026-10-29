/** What a program of the process requires from its process-lifetime
 *  services: a run or session all of them, an agent catalog load the part
 *  it reads before the catalog itself exists. */
import type { AgentCatalog } from '@agent/index/agentCatalog';
import type { RouteRetries } from '@agent/runtime/run/invocation';
import type { AppSignals } from '@platform/appSignals';
import type { AgentDirectories, AppState } from '@platform/interfaces';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { Secrets } from '@platform/secrets';
import type { GlobalValues, StateStores } from '@platform/stateStores';
import type {
  GlobalDatabase,
  ProjectDatabases,
} from '@shared/session/database';
import type { ProcessIdentity } from '@shared/session/sessionEvents';
import type { UsageLog } from '@shared/usageLog';
import type { ToolCatalog } from '@tools/liveTools';
import type { ToolAvailability } from '@tools/toolAvailabilityService';
import type { ToolRegistry } from '@tools/toolTable';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import type { HttpClient } from 'effect/http';
import type { FileSystem, Path } from 'effect';

/**
 * The services every run and session of the process is provided, merged
 * once by `processLayer`: the host ports and the HTTP client; the standard
 * library's `FileSystem`, `Path` and `ChildProcessSpawner`, so a program
 * takes them from context instead of building a Node layer; the
 * cross-workspace storage view and its one database (`GlobalDatabase`); the
 * project databases, whose borrows share each connection between application
 * state and a session graph; the plugin table (`ToolRegistry`); the catalog
 * each session's steps pin their tools in (`ToolCatalog`; its owner's view
 * stays inside the composition); each workspace's last dependency probe
 * (`ToolAvailability`); and the app-lifecycle signals. The `Sessions` above
 * them is the composition root's alone (`ProcessRuntime`).
 */
export type ProcessServices =
  | ProcessIdentity
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | GlobalStorageFs
  | GlobalDatabase
  | ProjectDatabases
  | HttpClient.HttpClient
  | Secrets
  | AppState
  | AgentDirectories
  | AgentCatalog
  | GlobalValues
  | StateStores
  | UsageLog
  | ToolRegistry
  | ToolCatalog
  | ToolAvailability
  | RouteRetries
  | AppSignals;

/**
 * The services an agent catalog load reads: the global and filesystem views
 * the local agent directories are scanned through, the app state the
 * disabled-plugin switch is read from, and the plugin table whose agent-file
 * blocks a scan admits.
 */
export type AgentCatalogServices =
  | GlobalStorageFs
  | FileSystem.FileSystem
  | AgentDirectories
  | AppState
  | ToolRegistry;
