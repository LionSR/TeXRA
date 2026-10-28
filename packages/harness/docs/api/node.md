# `@texra-ai/harness/node`

<!-- Generated from `packages/harness/src/node.ts` by `npm run docgen`; do not edit. -->

Node.js platform implementation and host building blocks for
`@texra-ai/harness`.

> **Guide:** Read [Philosophy & Architecture](/api/) for a minimal Node.js
> embedding example using `nodePlatform` and `Sessions.layer`.

### Key exports by role

- **Default SDK platform**: [`nodePlatform`](#nodeplatform) and
  [`NodePlatformOptions`](#nodeplatformoptions) build an `AgentPlatform` from
  `agentsDir`, `storageDir`, `workspaceDir`, and `settings`.
- **Workspace roots & paths**:
  [`createNodeWorkspaceRoots`](#createnodeworkspaceroots),
  [`canonicalizeWorkspacePath`](#canonicalizeworkspacepath),
  [`workspaceRelativePath`](#workspacerelativepath),
  [`resolveGlobalStoragePath`](#resolveglobalstoragepath), and
  [`resolveWorkspaceStoragePath`](#resolveworkspacestoragepath).
- **SQLite stores & process identity**: [`GlobalDatabase`](#globaldatabase),
  [`ProjectDatabases`](#projectdatabases), and
  [`ProcessIdentity`](#processidentity).
- **Commands, binary probes & atomic file I/O**:
  [`executeCommand`](#executecommand), [`findCommand`](#findcommand),
  [`probeTool`](#probetool), [`writeFileAtomic`](#writefileatomic), and
  [`readNormalizedFile`](#readnormalizedfile).

## absentReason

The failures an existence probe reads as absent: the path is not there
(`ENOENT`), or a parent component is a file rather than a directory
(`ENOTDIR`), which the platform reports as `BadResource`. Every other
failure propagates.

```ts
const absentReason: (error: PlatformError) => boolean
```

## canonicalizeWorkspacePath

Resolve one physical workspace identity for storage and host adapters.
Missing trailing segments keep their spelling (see `canonicalizePath`). A
permission error is tolerated on purpose: a workspace under an unreadable
ancestor still opens, keyed by its resolved spelling. Every other failure
propagates.

```ts
function canonicalizeWorkspacePath(workspacePath: string): string
```

## ConfigStore

The store surface one config target needs. `JsonStore` satisfies it; so does
the in-memory twin behind `MemoryConfigProvider`, which is why the
layered-resolution rule below has exactly one implementation.

`set` is the store's own Effect write, named as the secret and state stores
name theirs. It carries no requirements and no injected runner: a store that
needs host services (the JSON one wants the filesystem) provides them for
the effect itself, so this port's members compose into any caller's program.

```ts
interface ConfigStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): Effect.Effect<void, Error>;
}
```

## createNodeWorkspaceRoots

Build the `WorkspaceRoots` for one workspace folder: the canonical physical
root, the pinned storage path, and the config/state stores opened for it.
Every host (and the desktop, once per open paper) builds its roots here so
the config-provider choice cannot drift.

```ts
function createNodeWorkspaceRoots(
  init: NodeWorkspaceRootsInit,
): WorkspaceRoots
```

## effectDiagnosticsLayer

Local diagnostics for a process runtime, at the emission threshold the
composition root chose. No exporter or retained collection is installed;
callers can still provide their own Tracer on an individual Effect.

The threshold comes from facts that cannot change mid-process: the surface
kind (the extension's `LogOutputChannel` filters for itself, so it takes
`Trace`; the desktop's rotated log file takes `Debug`) or a CLI flag
(`--quiet` / `--verbose`). A live user setting must never be routed here:
the reference is fiberCached and read before any logger runs, so it would
freeze the setting for a whole session.

```ts
const effectDiagnosticsLayer: (minimumLogLevel: LogLevel) => Layer<never, never, never>
```

## entryTypeIn

The entry's own type at `target`, or `undefined` when nothing is there, with
lstat semantics: a link reports as itself rather than as what it points at,
and a dangling one still names an entry.

One `lstat`, so a dangling or circular link is still an entry. Only
absence ({@link absentReason}, `ENOTDIR` included) is recovered; every other
failure propagates, so an unreadable entry is never read as a missing one.

The caller passes the filesystem it probes with, so a rooted view answers
for the paths inside its root and the process filesystem answers for the
rest.

```ts
const entryTypeIn: (fs: FileSystem, target: string) => Effect<Type | undefined, PlatformError, never>
```

## envFlag

Whether `name` is set to something that means "on" (see
`isEnvFlagValueOn`): in the process environment, read through the ambient
`ConfigProvider`, or in `env` when the caller holds one (the environment a
run read).

```ts
const envFlag: (name: string, env?: Readonly<Record<string, string | undefined>> | undefined) => Effect<boolean, never, never>
```

## ExecResult

```ts
type ExecResult = typeof ExecResultSchema.Type;
```

## executeCommand

Execute an external command in `cwd` with the workspace env, over the
process's `ChildProcessSpawner`.

Never fails: a spawn failure or missing cwd (127), a non-zero exit, a
timeout (`timedOut`), an abort (130) and a max-buffer trip (2,
`outputLimitExceeded`) are all reported in the {@link ExecResult}.

The process lives exactly as long as this call's scope. A deadline, an
abort, an output-limit trip or an interrupted fiber closes that scope, and
that is the whole teardown: SIGTERM to the process (its group when it has
one), SIGKILL after five seconds, and a join on its exit. A command that
ends by itself gets the same release, so jobs its shell backgrounded end
with it. The array form runs in our process group unless
`killProcessTree` asks for its own; on POSIX the string form runs its shell
in its own group, on a lifeline that ends the group if this process dies
without running the release.

```ts
const executeCommand: (command: string | string[], options: ExecuteCommandBaseOptions) => Effect<{ readonly success: boolean; readonly exitCode: number; readonly timedOut: boolean; readonly stderr: string; readonly stdout: string; readonly outputLimitExceeded?: boolean | undefined; readonly noExitCode?: boolean | undefined; }, never, ChildProcessSpawner>
```

## ExecuteCommandBaseOptions

```ts
interface ExecuteCommandBaseOptions {
  readonly channel?: string;
  readonly env?: Record<string, string>;
  /** Milliseconds; undefined or `<= 0` sets no deadline. */
  readonly timeout?: number;
  /**
   * Working directory for the command, and the `PROJECT_DIR` the child sees.
   *
   * Required — not optional — so every caller names the root it holds (a run's
   * session roots, a tool call's `roots.workspace`, the host's roots at
   * command entry) instead of the command reaching for an ambient one.
   * `undefined` is the honest answer only where the caller itself
   * has no folder, and it fails the run the same way the ambient miss did.
   */
  readonly cwd: string | undefined;
  /**
   * The setting slots the command's git identity is read from: whether this
   * workspace marks agent commits, and the name and email it marks them with.
   *
   * Required — not optional — so every caller names the stores it holds (a
   * run's session roots, a tool call's `call.roots`, the host's roots at
   * command entry) instead of the command reaching for an ambient one.
   * `undefined` is the honest answer only where the caller itself has no
   * workspace, and it then carries no agent-commit identity, exactly as an
   * uninitialised ambient read did.
   */
  readonly settings: SettingsStores | undefined;
  /** Called with stdout chunks as they arrive, enabling live output streaming. */
  readonly onStdout?: (chunk: string) => void;
  /** Called with stderr chunks as they arrive, enabling live error streaming. */
  readonly onStderr?: (chunk: string) => void;
  /** Set to false to retain no output in memory (use with onStdout/onStderr). */
  readonly buffer?: boolean;
  /** Maximum decoded characters retained per output stream before the command is stopped. */
  readonly maxBuffer?: number;
  /**
   * A caller-owned cancellation channel, for the one case fiber interruption
   * cannot express: a command whose **result still has to be delivered** after
   * it is stopped (the background bash child run, whose strategy sets
   * `deliverAfterInterrupt`). Aborting it terminates the subprocess and any
   * shell children, and the call still resolves with exit code 130.
   *
   * Every other caller stops the command by interrupting the fiber: teardown
   * is identical and the abandoned result is exactly what interruption means.
   */
  readonly signal?: AbortSignal;
  /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
  readonly quiet?: boolean;
  /**
   * Terminate the whole process tree on abort or timeout instead of only the
   * tracked process. Array form only: the shell form already signals its whole
   * group. Opt in for tools that hand the work to a delegate (ImageMagick and
   * GraphicsMagick rasterize PDF pages through Ghostscript) so the delegate is
   * signalled as part of the same teardown: a new process group on POSIX; on
   * Windows the spawner's `taskkill /T` already reaches the tree.
   */
  readonly killProcessTree?: boolean;
}
```

## FileSecrets

A host's handle on the credential directory. `onChanged` is told "re-read
this key" after every write of this handle: the process's store announces
it (`credentialChanged`, `Secrets.announcing`), as
{@link FileSecrets.watch} does every other process's.

```ts
class FileSecrets implements PlatformSecrets
```

## findCommand

Find `name` on this machine (the common tool directories, the TeX
database for TeX Live scripts, then the extended PATH) and say how to
launch it: a Perl script runs through `perl`. Null when the tool is not
there now. A miss is remembered for a minute unless `fresh` asks again.

```ts
const findCommand: (name: string, options?: { readonly path?: string | undefined; readonly fresh?: boolean | undefined; } | undefined) => Effect<FoundCommand | null, never, ChildProcessSpawner>
```

## FoundCommand

A command found on this machine, and how to launch it.

```ts
interface FoundCommand {
  /** The program to spawn: the tool itself, or `perl` for a Perl script. */
  readonly command: string;
  /** The arguments that come before the caller's own (the script's path). */
  readonly args: readonly string[];
  /** The absolute path the lookup found. */
  readonly resolvedPath: string;
}
```

## GlobalDatabase

The process's one handle on the global storage root, held for the process
runtime's life: every application record of that root (settings, inquiry
threads, the update check, input history, remembered projects) goes through
it, so its `data_version` poll is forked once and no single-row read opens
a connection. Current values and input history only: no event rows.

```ts
class GlobalDatabase extends Context.Service<
  GlobalDatabase,
  Pick<Context.Service.Shape<typeof Database>, 'values' | 'inputHistory'>
>()('@texra-ai/harness/session/GlobalDatabase')
```

## homeDirectory

The user's home directory, or `undefined` where none resolves.
`os.homedir()` throws a SystemError (UV_ENOENT) where it cannot be
determined (a uid with no passwd entry and no `HOME`: containers, CI, some
remote setups), and can return an empty string. Every file the caller would
read under the home directory is then skipped, so the failure is logged at
warn rather than read as "no such file".

```ts
const homeDirectory: Effect.Effect<string | undefined>
```

## inheritedEnv

The environment a child process the harness spawns starts from: this
process's with its project's `.env` variables over it (`environment`),
minus every provider API-key variable the harness reads as its own credential
({@link API_KEY_ENV_NAMES}) and the requested approval policy
(`TEXRA_APPROVAL_POLICY`). What a child prints lands in tool results and
the transcript, so the key is never there to print. `keep` names the one
provider whose key a child agent CLI authenticates with itself. Windows
matches variable names case-insensitively, as its environment does.

```ts
const inheritedEnv: (keep?: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode" | undefined) => Effect<Record<string, string>, never, never>
```

## INPUT_HISTORY_LIMIT

```ts
const INPUT_HISTORY_LIMIT: 1000
```

## JsonConfigProvider

Store-backed {@link ConfigProvider}. Keys are stored flat with the canonical
`texra.*` prefix. Workspace values shadow global values on read and
`update()` routes writes by {@link ConfigTarget}. The project file answers
only where {@link projectValueIgnored} lets it; past it, `local` shadows
`global` for `local` rows, and `global` alone answers for the others.

```ts
class JsonConfigProvider implements ConfigProvider
```

## JsonConfigProviderOptions

```ts
interface JsonConfigProviderOptions {
  workspace: ConfigStore;
  global: ConfigStore;
  /** This user's private store for the workspace; see {@link ConfigTarget}. */
  local: ConfigStore;
  /** The rows the stores' keys resolve against (`ConfigProvider.catalog`). */
  catalog: SettingsCatalog;
}
```

## JsonStore

File-backed key-value store, persisted as a flat JSON object.

Shared building block for non-VS-Code platform implementations (Electron,
CLI). Writes go through `write-file-atomic`, which stages to a sibling temp
path, `fsync`s, then renames — so a crash mid-flush leaves the previous file
intact rather than corrupting the snapshot.

Each `set()` flushes as a read-modify-write against the file rather than a
dump of this instance's in-memory snapshot: the flush re-reads the file and
applies only that one mutation, so an instance held open across an awaited
operation (e.g. a network fetch) can't clobber keys a concurrent writer —
another process, or another instance on the same file — persisted in the
meantime. Flushes for a given file path are serialized through
{@link writeLanes}, which orders this process's writers; across processes
the atomic rename is the only guarantee, so two hosts flushing the same file
in the same instant can still lose one of the two mutations. Reads (`get`,
`snapshot`, `keys`) still serve this instance's view: open-time
contents plus its own committed mutations — a `set` still queued behind
another one has changed nothing yet; they don't observe other writers'
changes.

`set` is the store's own write and is an `Effect`, requirement-free: it
provides the Node filesystem services its flush reads and writes through, so
a port that composes it (the config store) needs no filesystem in its own
type. Application state is owned by SQLite and secrets by `FileSecrets`;
this store serves deliberate configuration files.

```ts
class JsonStore
```

## JsonStoreOptions

How {@link JsonStore.open} treats a file it cannot read, and whether the
store follows other writers.

```ts
interface JsonStoreOptions {
  /**
   * When set, a file that exists but cannot be read as a JSON object opens as
   * an empty view and reports the cause here instead of failing the open.
   * Writes still re-read the file in {@link flush}, so they fail rather than
   * overwrite what the reader could not parse.
   */
  onUnreadable?: (error: Error) => void;
  /**
   * Serve other writers' changes: every read first compares the file's
   * inode, mtime and size with the version it holds (about a microsecond)
   * and re-reads the file when they differ. A long-lived process that other
   * processes configure (a background service) opens its stores this way. A
   * changed file it cannot read keeps the last view and is logged as a
   * warning, once per version of the file.
   */
  follow?: boolean;
}
```

## makeMachineGitEnv

Build an environment for a non-interactive git subprocess: the current
environment with the helper-invoking keys in {@link GIT_UNSAFE_ENV_KEYS}
removed, `GIT_TERMINAL_PROMPT=0` so git never blocks on a tty prompt, and
`PATH` extended via {@link withExtendedPath} so GUI-launched hosts (whose
minimal PATH may omit Homebrew / /usr/local/bin, or Windows' Git\cmd when
git was installed for Git Bash only) can still resolve the `git` binary.

This omits the unsafe keys rather than setting them to `undefined`, so it
only strips anything when it fully replaces the child environment. On a
ChildProcess command the env replaces the child environment unless
`extendEnv` is true; pass `extendEnv: false` explicitly so a later
`extendEnv: true` cannot merge the stripped keys back in.

```ts
function makeMachineGitEnv(): NodeJS.ProcessEnv
```

## nodeFileServices

Node's file services: `FileSystem` (with the one-call native `realPath`)
and `Path`. The process platform, the JSON and credential stores and the
hosts' own reads all provide this one layer.

```ts
const nodeFileServices: Layer.Layer<FileSystem.FileSystem | Path.Path>
```

## nodePlatform

Construct the Node services required by the agent package: the process
platform plus the workspace roots of `workspaceDir`.

Agent definitions are read from `agentsDir`; configuration and state are
process-local, while run artifacts use the ordinary Node storage layout.

```ts
function nodePlatform(options: NodePlatformOptions): AgentPlatform
```

## NodePlatformOptions

Filesystem locations used by the default Node platform.

```ts
interface NodePlatformOptions {
  readonly agentsDir: string;
  readonly workspaceDir?: string;
  /**
   * The directory this platform stores run history, checkpoints and its
   * global state under, and reads its `mcp.json` from. Required: the package
   * never falls back to a per-user default directory.
   */
  readonly storageDir: string;
  /** The setting rows the embedder's plugins read, resolved beside the
   *  harness's own by the platform's config. */
  readonly settings?: readonly StateSettingEntry[];
}
```

## nodePlatformServices

```ts
const nodePlatformServices: Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
>
```

## NodeWorkspaceRootsInit

The per-workspace services a Node host opens for one workspace folder.

```ts
interface NodeWorkspaceRootsInit {
  /** The product host opening these roots (`WorkspaceRoots.host`). */
  readonly host: SettingHost;
  /** The canonical workspace root (`canonicalizeWorkspacePath`), decided by the host where it reads it. */
  readonly workspacePath: string | undefined;
  /** The storage root this process opened (`WorkspaceRoots.storageRoot`). */
  readonly storageRoot: string;
  /** The storage root opened for this workspace (`resolveWorkspaceStoragePath`). */
  readonly storage: string;
  /**
   * Config source: the workspace + global stores to build the file-backed
   * provider from, or an already-constructed provider for hosts that resolve
   * configuration some other way (the SDK's process-local
   * `MemoryConfigProvider`).
   */
  readonly config: JsonConfigProviderOptions | ConfigProvider;
  readonly workspaceState: StateStore;
  /** The repository settings (`WorkspaceRoots.repoState`). */
  readonly repoState: StateStore;
  /** The process's application state store (`WorkspaceRoots.globalState`). */
  readonly globalState: StateStore;
}
```

## pathExists

`FileSystem.exists` with a path whose parent is not a directory (`ENOTDIR`)
counted as absent alongside `ENOENT`; the standard library reports that
case as `BadResource`. {@link absentReason} names ENOTDIR specifically, so
an operational failure (`ELOOP`, `EACCES`) still propagates instead of
reading as "absent".

This probe follows links, so a dangling symlink reads as absent (ENOENT)
while a circular one raises ELOOP and propagates, unlike the lstat-backed
{@link entryExists}. A
caller asking whether a dependency, figure, bibliography or input *file* is
unusable wants the follow; a caller asking whether the path names an entry
wants `entryExists`.

The caller passes the filesystem it probes with, so a rooted view answers
for the paths inside its root and the process filesystem answers for the
rest.

```ts
const pathExists: (fs: FileSystem, target: string) => Effect<boolean, PlatformError, never>
```

## probeTool

Probe `toolName` with `command` (by default `<toolName> --version`), or
with each of several commands in turn until one answers.

The spawned probes are cancelled by the fiber's own interruption, so no
caller threads an `AbortSignal` in. The probe's own failure is answered,
not raised: the cause is logged and the tool reads as absent with
`probeFailed` set, which leaves no error channel for callers to handle.

```ts
const probeTool: (toolName: string, command?: string | readonly string[] | undefined) => Effect<ToolProbe, never, ChildProcessSpawner>
```

## ProcessIdentity

The canonical hostname, pid, and nullable process-start tuple: the
`ownerId` stamped on every event the process appends and the `self` entry
of its local runtime snapshot. Resolved once at each process entry, where
the start identity can be awaited, and provided to the process layer.

```ts
class ProcessIdentity extends Context.Service<
  ProcessIdentity,
  { readonly ownerId: OwnerId }
>()('@texra-ai/harness/session/ProcessIdentity')
```

## ProcessProbe

What reading a start identity takes: `/proc` on Linux, `ps` or PowerShell
elsewhere.

```ts
type ProcessProbe = FileSystem.FileSystem | ChildProcessSpawner;
```

## ProjectDatabases

Persistent project connections, retained by project and session scopes
until the last borrower releases one (never an ephemeral in-memory one).

```ts
class ProjectDatabases extends Context.Service<
  ProjectDatabases,
  RcMap.RcMap<string, Database['Service'], DatabaseOpenFailed>
>()('@texra-ai/harness/session/ProjectDatabases')
```

## projectValueIgnored

Whether a project file's `value` for `key` is ignored: the one scope rule
every read and the open-time warning share. A row the catalog leaves at the
workspace scope reads its project value; a `global` or `local` row (the
approval settings) does not, so a cloned repository cannot set it, except
that a `projectMayOptOut` row (telemetry) still takes anything but `true`.

```ts
function projectValueIgnored(
  catalog: SettingsCatalog,
  key: string,
  value: unknown,
): boolean
```

## readDirectoryTypedTolerant

`readDirectoryTyped` for listings that must survive one bad entry: an entry
whose type cannot be read is dropped with a warning naming it and the
reason, instead of failing the whole directory.

The listing comes from `readdir(..., { withFileTypes: true })`, so each
entry brings its own type and needs no second syscall. That is also what
keeps a directory that is readable but not searchable (`r--` on Unix)
listed: a probe would fail `EACCES` on every entry, and the tree would
render empty where the pre-migration listing showed it. Only an entry whose
dirent type the platform left `Unknown` is probed, and only that probe's
failure costs a row. The strict form stays with the containment and
deletion walkers, where a refused answer is the safe one.

The Node call is the one `FileSystem` cannot make: `readDirectory` returns
names alone, and the pre-`readdir` answer is what carries the types.

```ts
const readDirectoryTypedTolerant: (target: string) => Effect<(readonly [string, Type])[], PlatformError, Path>
```

## readNormalizedFile

The file's bytes decoded as UTF-8, with line endings normalized and a
leading BOM kept. `FileSystem.readFileString` is not this -- it decodes
through a `TextDecoder`, which drops a leading UTF-8 BOM, and the editor
then writes its buffer back without it.

The caller passes the filesystem it reads from, so a rooted view answers for
the paths inside its root and the process filesystem answers for the rest.

```ts
const readNormalizedFile: (fs: FileSystem, target: string) => Effect<string, PlatformError, never>
```

## relativeToRoot

Symlink-aware workspace-relative path: a fast `resolve`-then-compare pass,
then a canonicalize-then-compare fallback for paths that resolve through a
symlink (e.g. a symlinked folder inside the workspace). Shared by
`workspaceRelativePath` and the desktop native-picker path so the two
stay in sync. Returns `undefined` when `filePath` resolves outside `root`;
the caller owns its outside-root fallback (identity vs normalized absolute).

```ts
function relativeToRoot(
  root: string,
  filePath: string,
): string | undefined
```

## resolveGlobalStoragePath

The process-wide storage directory under a storage root.

```ts
function resolveGlobalStoragePath(storageRoot: string): string
```

## resolveWorkspaceStoragePath

One workspace's storage directory under a storage root, keyed by the
workspace's identity (`no-workspace` for none).

```ts
function resolveWorkspaceStoragePath(
  storageRoot: string,
  workspacePath: string | undefined,
): string
```

## runsInWsl

Whether this process runs inside Windows Subsystem for Linux (WSL), where
a tool installed on the Windows side is not on this side's PATH. `is-wsl`
computes the answer once, at import.

```ts
function runsInWsl(): boolean
```

## secretsDirectory

The credential directory under a storage root (`~/.texra` in
production).

```ts
function secretsDirectory(storageRoot: string): string
```

## ToolProbe

What a probe found: whether the tool answered, and whether the probe
itself failed rather than finding nothing.

```ts
interface ToolProbe {
  readonly installed: boolean;
  readonly probeFailed: boolean;
}
```

## whichOnExtendedPath

Resolve `name` on the extended PATH the way a shell would, or null on a
miss. In-process (npm `which`), and PATHEXT-aware on Windows, so a bare
`npm` resolves to its `npm.cmd` shim without spawning `where`/`which`.

```ts
function whichOnExtendedPath(name: string): string | null
```

## withExtendedPath

Return a copy of `env` whose PATH is {@link extendEnvPath}'s, written under
the key the environment already uses.

Windows spells the variable `Path`, and a plain object copied out of
`process.env` keeps that spelling: `process.env` itself is case-insensitive
there, but an ordinary object is not. Assigning `.PATH` on the copy
therefore leaves the original `Path` beside it and hands the child both
spellings of one variable, with no defined rule for which survives — so on
Windows the extension silently applied or did not, per spawn. Writing the
key that is already present is the whole fix.

```ts
function withExtendedPath<T extends NodeJS.ProcessEnv>(env: T): T
```

## WORKSPACE_STORES

The global root's record of a workspace store, keyed by its storage
directory id: the root it serves, so a storage prune can tell a store
whose root is gone.

```ts
const WORKSPACE_STORES: ValueFamily<{ readonly root: string }>
```

## workspaceRelativePath

The workspace-relative form of `filePath`, symlink-aware. A path outside
the workspace (or with no workspace open) comes back as the caller's own
path, normalized.

```ts
function workspaceRelativePath(
  root: string | undefined,
  filePath: string,
): string
```

## writeFileAtomic

Crash-safe replace, delegated to `write-file-atomic` rather than
re-derived: it stages under a name
unique across processes and threads, fsyncs, preserves an existing
target's mode and ownership, and resolves the target's real path so a
symlinked target is replaced where it points. For durable state a torn
file would make unreadable on resume; not for workspace files.

```ts
const writeFileAtomic: (target: string, data: Uint8Array<ArrayBufferLike>) => Effect<void, PlatformError, never>
```
