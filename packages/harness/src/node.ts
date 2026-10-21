// The default platform of an SDK embedder.
export {
  nodePlatform,
  type NodePlatformOptions,
} from '@platform/defaults/sdkPlatform';

// The Node building blocks `nodePlatform` is made of, for a host that
// composes its own platform: workspace roots over Node, the canonical
// spelling of a workspace path, a path's workspace-relative form, and the
// storage layout under a root.
export {
  createNodeWorkspaceRoots,
  type NodeWorkspaceRootsInit,
} from '@platform/defaults/nodeHost';
// The process's SQLite stores (the global root's handle, which
// `ProcessLayerOptions.globalDatabase` may replace, and the bound its input
// history keeps; the project connections every session borrows), the
// identity stamped on every row the process appends, and what reading a
// process's start identity takes.
export {
  GlobalDatabase,
  INPUT_HISTORY_LIMIT,
  type ProjectDatabases,
} from '@shared/session/database';
export type { ProcessIdentity } from '@shared/session/sessionEvents';
export type { ProcessProbe } from '@platform/defaults/nodeProcesses';
export {
  canonicalizeWorkspacePath,
  relativeToRoot,
} from '@utils/system/nodeWorkspace';
export { workspaceRelativePath } from '@utils/files/workspaceFS';
export {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
// The global root's record of each workspace store under a storage root,
// keyed by its storage directory's name: the root it serves.
export { WORKSPACE_STORES } from '@shared/session/valueFamily';
// Running a program on this machine: find it, run it, and give any other
// child the PATH the harness resolves tools on.
export {
  executeCommand,
  type ExecuteCommandBaseOptions,
} from '@utils/system/execUtils';
export { findCommand, type FoundCommand } from '@utils/system/binaryResolver';
export { withExtendedPath } from '@utils/system/platformPaths';
// The process environment as the harness reads it: a flag (any value but
// unset, empty, `0`, `false`, `no` or `off` is on), and the environment a
// child agent CLI starts from (no provider key but the one it authenticates
// with).
export { envFlag, inheritedEnv } from '@utils/system/envFlags';
// The file reads `FileSystem` has no form for: crash-safe replace, existence
// with a path under a file read as absent, text with a leading BOM kept and
// line endings normalized, a listing that types each entry from its dirent
// and drops one it cannot type, an entry's own (lstat) type, and the
// failures a probe reads as absent (`NotFound`, or a parent that is a file).
export {
  readDirectoryTypedTolerant,
  readNormalizedFile,
  writeFileAtomic,
} from '@utils/files/fsDurability';
export {
  absentReason,
  entryTypeIn,
  pathExists,
} from '@utils/files/fsEntryExists';
// The setting rows a `ConfigProvider` resolves against (its `catalog`): an
// embedder with its own provider builds one from its rows, which
// `settingsCatalog` puts after the harness's own.
export {
  settingsCatalog,
  type SettingsCatalog,
  type StateSettingEntry,
} from '@shared/state/stateSettings';
// The config provider over a host's stores (workspace, local, global), and
// whether it ignores a project file's value for a row.
export {
  JsonConfigProvider,
  projectValueIgnored,
  type ConfigStore,
  type JsonConfigProviderOptions,
} from '@platform/defaults/jsonConfigProvider';
