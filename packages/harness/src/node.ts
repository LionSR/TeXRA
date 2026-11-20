/**
 * Node.js platform implementation and host building blocks for
 * `@texra-ai/harness`.
 *
 * > **Guide:** Read [Philosophy & Architecture](/api/) for a minimal Node.js
 * > embedding example using `nodePlatform` and `Sessions.layer`.
 *
 * ### Key exports by role
 *
 * - **Default SDK platform**: [`nodePlatform`](#nodeplatform) and
 *   [`NodePlatformOptions`](#nodeplatformoptions) build an `AgentPlatform` from
 *   `agentsDir`, `storageDir`, `workspaceDir`, and `settings`.
 * - **Workspace roots & paths**:
 *   [`openNodeWorkspaceRoots`](#opennodeworkspaceroots),
 *   [`canonicalizeWorkspaceRoot`](#canonicalizeworkspacepath),
 *   [`workspaceRelativePath`](#workspacerelativepath),
 *   [`resolveGlobalStoragePath`](#resolveglobalstoragepath), and
 *   [`resolveWorkspaceStoragePath`](#resolveworkspacestoragepath).
 * - **The global SQLite store**: [`GlobalDatabase`](#globaldatabase).
 * - **Commands & atomic file I/O**:
 *   [`executeCommand`](#executecommand),
 *   [`writeFileAtomic`](#writefileatomic), and
 *   [`readNormalizedFile`](#readnormalizedfile).
 * - **Diagnostics**: [`setLogSink`](#setlogsink) and [`LogSink`](#logsink)
 *   name where the log entries go, and
 *   [`effectDiagnosticsLayer`](#effectdiagnosticslayer) at which level.
 */
// The default platform of an SDK embedder.
export {
  nodePlatform,
  type NodePlatformOptions,
} from '@platform/defaults/nodePlatform';

// The Node building blocks `nodePlatform` is made of, for a host that
// composes its own platform: workspace roots over Node, the Node services a
// process serves (the file system, paths and a supervised child-process
// spawner), the canonical spelling of a workspace path, a path's
// workspace-relative form, and the storage layout under a root.
export {
  openNodeWorkspaceRoots,
  type NodeWorkspaceRootsInit,
} from '@platform/defaults/nodeHost';
export { nodePlatformServices } from '@platform/defaults/nodeServices';
// The global root's SQLite handle, and the bound its input history keeps. The project stores stay beneath the session composition.
export { GlobalDatabase, INPUT_HISTORY_LIMIT } from '@shared/session/database';
export {
  canonicalizeWorkspaceRoot,
  relativeToRoot,
} from '@utils/system/nodeWorkspace';
export { workspaceRelativePath } from '@utils/files/workspaceFS';
export {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
// Running a program on this machine: run it, and extend the PATH for any
// other child with the directories an app adds.
// The home directory, logged at warn where none resolves.
export {
  executeCommand,
  type ExecEnd,
  type ExecResult,
  type ExecuteCommandBaseOptions,
} from '@utils/system/execUtils';
export {
  CommandDirs,
  existsAtAbsolute,
  homeDirectory,
  whichOnExtendedPath,
  withCommandDirs,
  withExtendedPath,
} from '@utils/system/platformPaths';
export { runsInWsl } from '@utils/system/wslDetect';
// The process environment as the harness reads it: a flag (any value but
// unset, empty, `0`, `false`, `no` or `off` is on), and the environment a
// child agent CLI starts from (no provider key but the one it authenticates
// with).
export {
  APPROVAL_POLICY_ENV,
  envFlag,
  envVar,
  inheritedEnv,
} from '@utils/system/envFlags';
// git: the reads of a repository, under one timeout and never failing, and
// the one runner of a command that changes something, under the machine git
// environment (no helper-invoking key, no terminal prompt).
export {
  commitExists,
  currentBranch,
  isGitRepository,
  localBranchExists,
  machineGit,
  type MachineGitResult,
  originDefaultBranch,
  originUrl,
  recentCommitLabels,
  repositoryRoot,
} from '@utils/system/git';
// The file reads `FileSystem` has no form for: crash-safe replace, existence
// with a path under a file read as absent, text with a leading BOM kept and
// line endings normalized, a listing that types each entry from its dirent
// and drops one it cannot type, an entry's own (lstat) type, and the
// failures a probe reads as absent (`NotFound`, or a parent that is a file).
export {
  createSymlink,
  readDirectoryTypedTolerant,
  readNormalizedFile,
  writeFileAtomic,
} from '@utils/files/fsDurability';
export {
  meansAbsent,
  entryTypeIn,
  isNotADirectoryError,
  pathExists,
} from '@utils/files/fsEntryExists';
// The harness's log path as Effect diagnostics (its logger over the installed
// sink, the minimum level, a bounded tracer), for a host program that runs
// outside its process runtime: before it is built, or after it is gone.
export { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
// The harness's log output: where its entries go (the console until a sink
// is set) and a line written straight to the sink; how an entry reads as
// text is on `./schemas`.
export {
  setLogSink,
  writeLogLine,
  type LogEntry,
  type LogSink,
} from '@logger/logSink';
// The config provider over a host's stores (workspace, local, global), and
// whether it ignores a project file's value for a row.
export {
  JsonConfigProvider,
  projectValueIgnored,
  type ConfigStore,
  type JsonConfigProviderOptions,
} from '@platform/defaults/jsonConfigProvider';
// The credential store every host keeps under its storage root, and the
// file-backed JSON store a host's configuration files open as, with the
// Node file services both write through.
export { FileSecrets, secretsDirectory } from '@platform/defaults/fileSecrets';
export { JsonStore } from '@platform/defaults/jsonStore';
export { nodeFileServices } from '@utils/files/fsDurability';
