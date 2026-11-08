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
  [`openNodeWorkspaceRoots`](#opennodeworkspaceroots),
  [`canonicalizeWorkspaceRoot`](#canonicalizeworkspacepath),
  [`workspaceRelativePath`](#workspacerelativepath),
  [`resolveGlobalStoragePath`](#resolveglobalstoragepath), and
  [`resolveWorkspaceStoragePath`](#resolveworkspacestoragepath).
- **SQLite stores & process identity**: [`GlobalDatabase`](#globaldatabase),
  [`ProjectDatabases`](#projectdatabases), and
  [`ProcessIdentity`](#processidentity).
- **Commands & atomic file I/O**:
  [`executeCommand`](#executecommand),
  [`writeFileAtomic`](#writefileatomic), and
  [`readNormalizedFile`](#readnormalizedfile).
- **Diagnostics**: [`setLogSink`](#setlogsink) and [`LogSink`](#logsink)
  name where the log entries go, and
  [`effectDiagnosticsLayer`](#effectdiagnosticslayer) at which level.

## absentReason

Whether a failure means nothing is at the path: it is not there
(`ENOENT`), or a parent component is a file rather than a directory
(`ENOTDIR`), the two cases Node's own `statSync(path, { throwIfNoEntry:
false })` reads as no entry. It answers for the standard library's
`PlatformError`, which reports `ENOTDIR` as `BadResource`, and for a bare
Node error. Every other failure (`EACCES`, `ELOOP`, `EISDIR`, ...) is not
absence and propagates from a caller that recovers only this.

```ts
const absentReason: (error: unknown) => boolean
```

## canonicalizeWorkspaceRoot

Resolve one physical workspace identity for storage and host adapters.
Missing trailing segments keep their spelling (see `canonicalizePath`). A
permission error is tolerated on purpose: a workspace under an unreadable
ancestor still opens, keyed by its resolved spelling. Every other failure
propagates.

```ts
function canonicalizeWorkspaceRoot(workspaceRoot: string): string
```

## CommandDirs

The directories an app adds to the PATH a command runs and resolves on:
the package-manager and tool installs a GUI-launched process may lack.
Absent, none.

```ts
const CommandDirs: Reference<() => readonly string[]>
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
  get(key: string): unknown;
  set(key: string, value: unknown): Effect.Effect<void, Error>;
}
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

## entryChannel

Which channel an entry belongs to, or `undefined` when it names none. An
`Effect.log*` carries one only through `Effect.annotateLogs`; a tracer span
opened by `Effect.withSpan` does not supply it, because the entry's `spans`
field reads `CurrentLogSpans` (`Effect.withLogSpan`), a separate mechanism.
An unattributed entry lands on the host's shared surface, which is the right
home for it.

```ts
function entryChannel(entry: LogEntry): string | undefined
```

## entryMessage

Render an entry's message for a host that wants one line of text. Effect
hands `message` through as a single value or an array of them, so both
shapes fold here rather than at each host.

```ts
function entryMessage(entry: LogEntry): string
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

## envVar

One variable; unset and `''` both read as undefined.

```ts
const envVar: (name: string) => Effect<string | undefined, never, never>
```

## ExecResult

```ts
type ExecResult = typeof ExecResultSchema.Type;
```

## executeCommand

Execute an external command in `cwd` with the workspace env, over the
process's `ChildProcessSpawner`. Its lines take the caller's log channel.

Never fails: a spawn failure or missing cwd (127), a non-zero exit, a
timeout (`timedOut`) and a max-buffer trip (2,
`outputLimitExceeded`) are all reported in the {@link ExecResult}.

The process lives exactly as long as this call's scope. A deadline, an
output-limit trip or an interrupted fiber closes that scope, and
that is the whole teardown: SIGTERM to the process (its group when it has
one), SIGKILL after five seconds, and a join on its exit. A command that
ends by itself gets the same release, so jobs its shell backgrounded end
with it. The array form runs in our process group unless
`killProcessTree` asks for its own; on POSIX the string form runs its shell
in its own group, on a lifeline that ends the group if this process dies
without running the release.

```ts
const executeCommand: (command: string | string[], options: ExecuteCommandBaseOptions) => Effect<{ readonly success: boolean; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean; readonly exitCode: number; readonly outputLimitExceeded?: boolean | undefined; readonly noExitCode?: boolean | undefined; }, never, ChildProcessSpawner>
```

## ExecuteCommandBaseOptions

```ts
interface ExecuteCommandBaseOptions {
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
  /** Called with stdout chunks as they arrive, enabling live output streaming. */
  readonly onStdout?: (chunk: string) => void;
  /** Called with stderr chunks as they arrive, enabling live error streaming. */
  readonly onStderr?: (chunk: string) => void;
  /** Set to false to retain no output in memory (use with onStdout/onStderr). */
  readonly buffer?: boolean;
  /** Maximum decoded characters retained per output stream before the command is stopped. */
  readonly maxBuffer?: number;
  /** Skip wrapper logging (pre-platform CLI callers whose sink is the console). */
  readonly quiet?: boolean;
  /**
   * Terminate the whole process tree on interruption or timeout instead of only the
   * tracked process. Array form only: the shell form already signals its whole
   * group. Opt in for tools that hand the work to a delegate (ImageMagick and
   * GraphicsMagick rasterize PDF pages through Ghostscript) so the delegate is
   * signalled as part of the same teardown: a new process group on POSIX; on
   * Windows the spawner's `taskkill /T` already reaches the tree.
   */
  readonly killProcessTree?: boolean;
}
```

## existsAtAbsolute

An existence probe that asserts an absolute path and then asks `node:fs`.
A relative one is refused with a thrown `Path must be absolute`: some of
the roots searched come straight from the environment, so a probe that
quietly answered "absent" would drop those directories from PATH with
nothing to show for it.

```ts
function existsAtAbsolute(target: string): boolean
```

## FileSecrets

A host's handle on the credential directory. `onChanged` is told "re-read
this key" after every write of this handle: the process's store announces
it (`credentialChanged`, `Secrets.announcing`), as
{@link FileSecrets.watch} does every other process's.

```ts
class FileSecrets implements PlatformSecrets
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

## isNotADirectoryError

Check if an error represents "a parent path component is a file, not a directory".

```ts
function isNotADirectoryError(err: unknown): boolean
```

## JsonConfigProvider

Store-backed {@link ConfigProvider}. Keys are relative to the catalog's
namespace and stored flat under it (`<namespace>.<key>`). Workspace values
shadow global values on read and `update()` routes writes by {@link ConfigTarget}. The project file answers
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
`snapshot`, `keys`) follow the file: each compares its inode, mtime and
size with the version the view was read from (about a microsecond) and
re-reads it when they differ, so another process's or another instance's
write is served; a `set` still queued behind another one has changed
nothing yet. A changed file that cannot be read keeps the last view and
is logged once per version of the file.

`set` is the store's own write and is an `Effect`, requirement-free: it
provides the Node filesystem services its flush reads and writes through, so
a port that composes it (the config store) needs no filesystem in its own
type. Application state is owned by SQLite and secrets by `FileSecrets`;
this store serves deliberate configuration files.

```ts
class JsonStore
```

## LOG_CHANNEL

Annotation naming the logical channel an entry belongs to.

```ts
const LOG_CHANNEL: "channel"
```

## LogEntry

One diagnostic record, shaped by Effect's own structured formatter rather
than by a type of ours: `Logger.formatStructured` already carries level,
fiber, timestamp, message, cause, annotations, and spans. Its `level` is
typed `string`; here it is the call's severity, upper-cased, as the
formatter writes it, so a sink's switch over it is exhaustive.

```ts
type LogEntry = Omit<
  ReturnType<typeof Logger.formatStructured.log>,
  'level'
> & { readonly level: Uppercase<LogLevel.Severity> };
```

## LogSink

```ts
interface LogSink {
  write(entry: LogEntry): void;
  dispose?(): void;
}
```

## makeMachineGitEnv

Build an environment for a non-interactive git subprocess: the current
environment with the helper-invoking keys in {@link GIT_UNSAFE_ENV_KEYS}
removed, `GIT_TERMINAL_PROMPT=0` so git never blocks on a tty prompt, and
`PATH` extended via {@link withCommandDirs} so GUI-launched hosts (whose
minimal PATH may omit Homebrew / /usr/local/bin, or Windows' Git\cmd when
git was installed for Git Bash only) can still resolve the `git` binary.

This omits the unsafe keys rather than setting them to `undefined`, so it
only strips anything when it fully replaces the child environment. On a
ChildProcess command the env replaces the child environment unless
`extendEnv` is true; pass `extendEnv: false` explicitly so a later
`extendEnv: true` cannot merge the stripped keys back in.

```ts
const makeMachineGitEnv: Effect.Effect<NodeJS.ProcessEnv>
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
   * global state under, and reads the user's own files from: its
   * `mcp.json`, the `AGENTS.md` a workspace without one falls back to, and,
   * given skill sources, the skills under its `skills/`. Required: the
   * package never falls back to a per-user default directory.
   */
  readonly storageDir: string;
  /** The catalog the platform's config resolves against (`settingsCatalog`);
   *  absent, the harness's rows alone, under the `harness` namespace. */
  readonly settings?: SettingsCatalog;
}
```

## nodePlatformServices

```ts
const nodePlatformServices: Layer.Layer<
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
>
```

## NodeWorkspaceRootsInit

What a Node host names to open one workspace folder's roots.

```ts
interface NodeWorkspaceRootsInit {
  /** The canonical workspace root (`canonicalizeWorkspaceRoot`), decided by
   *  the host where it reads it; undefined when no folder is open. */
  readonly workspaceRoot: string | undefined;
  /** The storage root this process opened (`WorkspaceRoots.storageRoot`). */
  readonly storageRoot: string;
  /** The workspace, local and global config stores to build the file-backed
   *  provider from, or the provider a host already built from them (the
   *  CLI's, opened by its startup read). */
  readonly config: JsonConfigProviderOptions | ConfigProvider;
  /** The process's `StateStores`, which open the project's and the
   *  repository's stores under the workspace's storage path. */
  readonly stateStores: Context.Service.Shape<typeof StateStores>;
  /** The process's application state (`AppState`), shared by every root. */
  readonly globalState: StateStore;
  /** The project's state store when another process holds it (a background
   *  service the host is a client of); absent, the project's own store opens
   *  in the caller's scope. */
  readonly workspaceState?: StateStore;
}
```

## openNodeWorkspaceRoots

Open the `WorkspaceRoots` for one workspace folder: its pinned storage
path under the storage root, the file-backed config provider, the
project's state store (held for the caller's scope), the repository's
settings and the process's application state. Every host (and the
desktop, once per open project) opens its roots here.

```ts
const openNodeWorkspaceRoots: (
  init: NodeWorkspaceRootsInit,
) => Effect.Effect<WorkspaceRoots, DatabaseOpenFailed, Scope.Scope>
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

## ProcessIdentity

The canonical hostname, pid, and nullable process-start tuple: the
`origin` stamped on every event the process appends. Resolved once at each
process entry, where the start identity can be awaited, and provided to
the process layer.

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

Whether a project file's `value` for a key of catalog row `row` is ignored:
the one scope rule every read and the open-time warning share. A row the
catalog leaves at the workspace scope reads its project value; a `global` or
`local` row (the approval settings) does not, so a cloned repository cannot
set it, except that a `projectMayOptOut` row (telemetry) still takes
anything but `true`.

```ts
function projectValueIgnored(
  row: SettingRow | undefined,
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

It reads the dirents through Node's `readdir` directly, so its callers need
only `Path`; the strict form gets the same typed listing from
`FileSystem.readDirectoryEntries`.

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
  workspaceRoot: string | undefined,
): string
```

## RowOf

The row of kind `T`.

```ts
type RowOf<T extends SessionRow['type']> = Extract<
  SessionRow,
  { type: T }
>;
```

## RunRows

What a run's record rows say about it, each field from the rows its
comment names: what `SessionLog.facts` serves, read from the store's
`run_record` projection (`controllers/session/projections.ts`). The
session view keeps its own on `RunView`.

```ts
type RunRows = {
  /** Its `run.start`, and its parent edge: the start's, until a
   *  `run.detach` severs it. */
  readonly start: RowOf<'run.start'> | null;
  readonly parent: RowOf<'run.start'>['parent'];
  /** Its latest `run.activate`, and the `run.end` of the lifecycle that
   *  began (null until it ends): a resumed run never carries an old end. */
  readonly activation: RowOf<'run.activate'> | null;
  readonly end: RowOf<'run.end'> | null;
  /** The stop asked of this lifecycle (`run.stop`), null until one is:
   *  why the run stopped, or is stopping. */
  readonly stop: RowOf<'run.stop'> | null;
  /** Its input is closed: the latest of `run.activate`, `followup.closed`
   *  and `run.removed` is not an activation. */
  readonly inputClosed: boolean;
  /** Its latest `run.report`, `process.exit`, `run.config` and
   *  `run.position`. */
  readonly report: string | null;
  readonly exit: RowOf<'process.exit'> | null;
  readonly config: RowOf<'run.config'>['config'] | null;
  readonly position: RowOf<'run.position'> | null;
  /** Its title: the latest user `run.description`, else the latest one. */
  readonly title: RowOf<'run.description'> | null;
  /** Its latest model `run.description`, whose priced request (`usage`) is
   *  part of the run's spend whatever title stands. */
  readonly label: RowOf<'run.description'> | null;
  /** Its own grants: the latest `approval.policy`, else the snapshot its
   *  `run.start` carried. */
  readonly grants: ApprovalGrants | null;
  /** Each plugin row kind's latest row, by `plugin/kind` (`plugin.fact`):
   *  read through its plugin's own reader. */
  readonly facts: Readonly<Record<FactName, RowOf<'plugin.fact'>>>;
};
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

## setLogSink

Install the host sink, disposing whatever it replaces. Entries are redacted
unless the host identifies a local operator terminal as trusted. Passing
`null` restores the console fallback.

```ts
function setLogSink(
  next: LogSink | null,
  options: { readonly trusted?: boolean } = {},
): void
```

## whichOnExtendedPath

Resolve `name` on the process PATH extended with `appDirs` the way a shell
would, or null on a miss. In-process (npm `which`), and PATHEXT-aware on
Windows, so a bare `npm` resolves to its `npm.cmd` shim without spawning
`where`/`which`.

```ts
function whichOnExtendedPath(
  name: string,
  appDirs: readonly string[],
): string | null
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
function withExtendedPath<T extends NodeJS.ProcessEnv>(
  env: T,
  appDirs: readonly string[],
): T
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

## writeLogLine

One `WARN` channel line, for the few synchronous publication points with no
fiber to run `Effect.log*` on (the trace emitter, pre-runtime and shutdown
paths). The entry has the shape the logger layer writes.

```ts
function writeLogLine(channel: string, message: string): void
```
