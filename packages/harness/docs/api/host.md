# `@texra-ai/harness/host`

<!-- Generated from `packages/harness/src/host.ts` by `npm run docgen`; do not edit. -->

`@texra-ai/harness/host`: what a full application host composes beyond
the root entry. TeXRA's editor extension, desktop app and terminal app
read it; an embedder that runs agents from a program needs none of it.

It holds the process layer a host builds once (`processLayer`), the
services a host serves its views from (agent catalog, settings, stores,
skills, installed plugins, model options, tool availability), the
presentation surface a host implements (`HostInteractions`), and the
helpers the hosts share for files, errors and logs.

No stability promise: names move here when they leave the root entry and
leave when the hosts stop needing them.

## AgentCatalog

The process's agent catalog (see {@link AgentCatalogShape}).

```ts
class AgentCatalog extends Context.Service<
  AgentCatalog,
  AgentCatalogShape
>()('@texra-ai/harness/AgentCatalog')
```

## AgentCatalogLoadError

Resolving an agent directory failed (I/O or a rejected configured path).

```ts
class AgentCatalogLoadError extends Schema.TaggedError<AgentCatalogLoadError>()(
  'AgentCatalogLoadError',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
)
```

## AgentCatalogServices

The services an agent catalog load reads: the global and filesystem views
the local agent directories are scanned through, the app state the
disabled-plugin switch is read from, and the plugin table whose agent-file
blocks a scan admits.

```ts
type AgentCatalogServices =
  | GlobalStorageFs
  | FileSystem.FileSystem
  | AgentDirectories
  | AppState
  | ToolRegistry;
```

## AgentCatalogShape

What the process's agent catalog serves (see {@link AgentCatalog}).

```ts
interface AgentCatalogShape {
  /** Every agent, one per name: a custom agent over a bundled one over a
   *  plugin's. */
  readonly list: () => readonly AgentEntry[];
  /** An agent by identifier, visibility ignored: a bare name takes the
   *  highest-priority source, a `source:name` key its exact entry, even one
   *  a higher-priority source shadows. */
  readonly get: (identifier: string) => AgentEntry | undefined;
  /** Custom-directory files the last load skipped, with the reason. */
  readonly scanIssues: () => readonly AgentScanIssue[];
  /** The bundled agent a custom copy was made from, when the bundled file
   *  changed since the copy was taken (it records `basedOn`). */
  readonly newerBuiltIn: (
    entry: Pick<AgentEntry, 'name' | 'source' | 'basedOn'>,
  ) => AgentEntry | undefined;
  /**
   * Rescan every source, after every older load has settled, and publish
   * the catalog rebuilt from empty. The last published catalog keeps
   * serving until then, including when the rescan fails.
   */
  readonly refresh: Effect.Effect<
    void,
    AgentCatalogLoadError | StateReadFailed
  >;
  /** A source changed and its reload waits out a debounce: the next
   *  `forLaunch` loads it first, so an agent saved a moment ago launches as
   *  saved. */
  readonly invalidate: Effect.Effect<void>;
  /**
   * A workspace's agents: the visible ones (its selection over the catalog),
   * or with a delegation `scope`, the scope's pinned agents. The one list
   * a delegating agent is told and its calls resolve against.
   */
  readonly visible: (
    stores: WorkspaceAgentsStores,
    scope?: AgentDelegationScope,
  ) => Effect.Effect<AgentEntry[], StateReadFailed>;
  /**
   * The agent a launch runs, over a settled catalog: the entry an explicit
   * `source` pins, else a visible one, else any. A miss reloads once, then
   * fails with what the load said.
   */
  readonly forLaunch: (
    stores: WorkspaceAgentsStores,
    identifier: string,
    source?: AgentSource | null,
  ) => Effect.Effect<
    AgentEntry,
    AgentNotFound | AgentCatalogLoadError | StateReadFailed
  >;
  /** The workspace's agent selection and team presets, over this catalog. */
  readonly workspaceAgents: (
    stores: WorkspaceAgentsStores,
  ) => WorkspaceAgentsController<AgentEntry>;
  /** Change a custom copy of `entry` (see {@link AgentCustomization});
   *  the copy's path. */
  readonly customize: (
    entry: AgentEntry,
    change: AgentCustomization,
  ) => Effect.Effect<
    string,
    | AgentCustomizeRefused
    | AgentDirectoriesFailed
    | StateReadFailed
    | PlatformError.PlatformError
  >;
}
```

## AgentCustomization

A change to a custom copy of a bundled agent: `copy` writes a new one
into the custom directory, stamped with the bundled file's digest
(`basedOn`), and is refused when one is there; `overwrite` replaces it;
`keep` re-stamps the user's copy with the changed bundled version, which
dismisses its newer-version notice and touches nothing else.

```ts
type AgentCustomization = 'copy' | 'overwrite' | 'keep';
```

## AgentCustomizeRefused

`customize` refused the change: the entry has no file of its own to copy
(`noFile`), its copy would land outside the custom directory (`escapes`),
a copy is already there (`exists`, at `path`), or a copy has no newer
bundled version to keep (`current`).

```ts
class AgentCustomizeRefused extends Schema.TaggedError<AgentCustomizeRefused>()(
  'AgentCustomizeRefused',
  {
    reason: Schema.Literals(['noFile', 'escapes', 'exists', 'current']),
    path: Schema.optional(Schema.String),
    message: Schema.String,
  },
)
```

## AgentDelegationScope

```ts
type AgentDelegationScope = typeof AgentDelegationScopeSchema.Type;
```

## AgentDirectories

The process's agent directories as an Effect service, provided once by the
composition root through `processLayer`. The shape is the port itself: a
program that resolves one of the three local agent directories yields the
port's own readers instead of reaching for the process platform's copy.

`layer` takes the port itself, for the same reason `Secrets.layer` does:
every root builds its agent directories before it installs the runtime that
serves them, so the service is the value the root already holds.

```ts
class AgentDirectories extends Context.Service<
  AgentDirectories,
  AgentDirectoriesPort
>()('@texra-ai/harness/platform/AgentDirectories')
```

## AgentDirectoriesFailed

A host could not resolve one of its agent directories: the configured
custom directory is not an absolute path, its parent is gone, it cannot be
created, or the platform refused the filesystem call behind either.

{@link AgentDirectoriesPort}'s readers raise it as the failure of the
read itself, for the same reason {@link StateWriteFailed} exists: the reads
travel with the agent-catalog load beside them, so a caller inside a program
composes the read rather than adopting a rejection it cannot type.

```ts
class AgentDirectoriesFailed extends Schema.TaggedError<AgentDirectoriesFailed>()(
  'AgentDirectoriesFailed',
  {
    /** Which of the port's readers failed. */
    source: AgentSourceSchema,
    message: Schema.String,
    cause: Schema.Defect(),
  },
)
```

## AgentDirectoriesPort

Host-provided agent directory paths. All are `Effect`s (not Promises)
so the readers that can fault — `custom`, which creates the directory it
resolves, and `customConfigured`, which validates the setting — carry their
failure into the program that asked instead of rejecting an await that
cannot name it.

`custom` takes the process's {@link GlobalStorageFs} and the process
`FileSystem` from context: the default custom-agents directory lives under
the cross-workspace storage root, and a configured one is an absolute path
outside every root, so the view that names each is the one the process
runtime provides.

```ts
interface AgentDirectoriesPort {
  custom(): Effect.Effect<
    string,
    AgentDirectoriesFailed,
    GlobalStorageFs | FileSystem.FileSystem
  >;
  /** Whether `custom` resolves to a directory the user configured, rather
   *  than falling back to the default one under global storage. */
  customConfigured(): Effect.Effect<
    boolean,
    AgentDirectoriesFailed,
    FileSystem.FileSystem
  >;
  builtIn(): Effect.Effect<string, AgentDirectoriesFailed>;
  /**
   * The packaged resources root a host ships its bundled agents under,
   * the tool plugins' agent directories among them. Absent where none ships:
   * an embedder's own directories, or the CLI entries that load no agents.
   */
  readonly resourcesRoot?: string;
}
```

## AgentDirectoryService

```ts
class AgentDirectoryService
```

## AgentDirectoryServiceOptions

What a host's agent directories are built from.

```ts
interface AgentDirectoryServiceOptions {
  channel: string;
  /**
   * Packaged resources root holding the bundled agent directories. Hosts read
   * their built-in agents straight out of the bundle they shipped with, so one
   * host's install can never overwrite another's built-ins.
   */
  resourcesPath: string;
  /** Where the configured custom agent directory is read from. */
  state: Pick<StateStore, 'get'>;
  /** Defaults to logging the issue at `warn`; hosts with an interactive
   * notification surface (e.g. the VS Code extension) can override it. */
  issueReporter?: {
    report(message: string, docsId: 'custom-agents'): Effect.Effect<void>;
  };
}
```

## AgentEntry

An agent as the catalog lists it, and as a launch runs it: the scan
validated the whole definition (defaults applied), so
an entry that exists can launch. Every entry is a persona; one holding a
plugin's block (`AgentBlock`) is also launchable as that plugin's task.

```ts
interface AgentEntry {
  name: string;
  source: AgentSource;
  path: string; // absolute path to the definition file
  description?: string;
  tools?: string[]; // tool names, for display
  /** Digest of the definition file; absent on a plugin agent. */
  digest?: string;
  /** A customized copy's `basedOn`: the bundled file's digest it began from. */
  basedOn?: string;
  /** The model agent the entry names. */
  persona: Persona;
  /** The plugins' blocks the file holds, by key, as their schemas parsed
   *  them (`agentBlockOf` reads one); empty for a chat agent. */
  blocks: Readonly<Record<string, unknown>>;
}
```

## AgentError

A runtime failure of the agent layer: a launch it refuses or a run that
ended failed.

Host-neutral, so any host can reference it.
A more specific error should be added only when a concrete thrower and
catcher exist for it — anything else duplicates the existing
`ProviderError` schema and `isUserAbort` machinery.

```ts
class AgentError extends Schema.TaggedError<AgentError>()('AgentError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
})
```

## AgentErrorKind

```ts
type AgentErrorKind = NonNullable<RunEnd['error']>['kind'];
```

## agentErrorPresentation

Map a classified error to host guidance, with no notification for aborts.

```ts
function agentErrorPresentation(error: {
  kind: AgentErrorKind;
  message?: string;
  /** Docs page of a refusing request (`Rejected.docsPage`), surfaced
   *  beside the error so the host's dialog keeps the guide affordance. */
  docsPage?: string;
}): AgentErrorPresentation | null
```

## AgentErrorPresentation

How a host presents an agent error: an instruction, or a plain error.

```ts
type AgentErrorPresentation =
  | {
      readonly type: 'instruction';
      readonly payload: RequestShowInstructionPayload;
    }
  | {
      readonly type: 'error';
      readonly payload: RequestShowErrorPayload;
    };
```

## AgentRuntimeEmitOptions

```ts
interface AgentRuntimeEmitOptions {
  /** Retain a presentation event until a temporarily detached UI returns. */
  readonly replayWhenAttached?: boolean;
  /**
   * Shown through `requestShowError` on the same host when presenting this
   * event throws, live or on replay: for a notice that is a failure's only
   * surface.
   */
  readonly fallbackMessage?: string;
}
```

## AggregateId

The key one lifecycle's events ride on in the event table.

```ts
type AggregateId = typeof AggregateIdSchema.Type;
```

## AppState

Global application state, provided by the process's composition layer.
SQLite hosts acquire their store in the runtime's scope over the global
database, whose change feed reaches every process sharing it. `layer`
serves a store a caller supplies, which has none: a reader of it sees a
change at its next read.

```ts
class AppState extends Context.Service<AppState, AppStateStore>()(
  '@texra-ai/harness/platform/AppState',
)
```

## AppStateStore

The global state store, and what changes in it.

```ts
interface AppStateStore extends StateStore {
  /**
   * Emits as subscribed, then whenever one of `keys` may have been written,
   * by this process or by another sharing the store: a reader re-reads the
   * keys on each. A store with no change feed emits only the first.
   */
  changes(keys: readonly string[]): Stream.Stream<void>;
}
```

## AssembleTraceResult

```ts
type AssembleTraceResult =
  | {
      readonly status: 'ok';
      readonly trace: TraceDocument;
      readonly record: RunRecord;
    }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };
```

## attachErrorPresentationClaimed

Marks that this failure was presented, so no later presenter (a generic
handler on the same call stack, a host's own fallback) shows it again.
Attached when a targeted notification owns its presentation (its emit
confirmed delivery, or no host was attached and it was retained for
replay), when the session's presenter showed a run's failure from its
`run.end` row (`presentRunFailure`, `receiveTerminalFailure`), and when
another process (a service) showed it to this window. Never for a
fire-and-forget or declined emit, so a host that could not render a
targeted notification leaves the generic surface free to fire.

```ts
const attachErrorPresentationClaimed: (err: unknown) => void
```

## AvailabilityResults

Each workspace root's last results (`undefined` = no folder open); a root
no probe has answered for yet is absent.

```ts
type AvailabilityResults = ReadonlyMap<
  string | undefined,
  readonly ExternalToolCheckResult[]
>;
```

## availableTeamMemberCount

Distinct member keys available to the run, excluding the root itself.

```ts
function availableTeamMemberCount(plan: TeamRunPlan): number
```

## buildDiffHunks

Unified-diff hunks between two texts — the one diff engine behind every
count, every rendered diff body, and every patch note in the product.

On timeout this reports a whole-file replacement rather than an empty diff:
"everything changed" is a true (if verbose) description of the edit, while
an empty hunk list would read as "nothing changed". The returned `timeout`
names the cause, and the caller that owns the edit reports it through
{@link reportDiffTimeout}, so a degraded diff is never silent.

```ts
function buildDiffHunks(oldText: string, newText: string): DiffHunks
```

## BUNDLED_AGENTS_DIRECTORY

The one bundled agent directory under a host's packaged resources.

```ts
const BUNDLED_AGENTS_DIRECTORY: "agents"
```

## CallFailure

Why a model call failed: the vendor's verdict, or no route to send it on.

```ts
type CallFailure = ModelError | RouteUnavailable;
```

## canLaunchTeam

```ts
function canLaunchTeam<T extends TeamCatalogAgent>(
  plan: TeamRunPlan<T>,
): plan is TeamRunPlan<T> & { readonly rootAgent: T }
```

## causeChain

`err` followed by its `cause` chain, outermost first; an
`AggregateError`'s `errors` follow it before its cause. Shared traversal
for messages and for predicates whose fact may sit at any depth of a
wrapped error.

```ts
function causeChain(err: unknown): unknown[]
```

## ConfigProvider

Platform configuration provider interface.

```ts
interface ConfigProvider {
  /**
   * Resolution order an implementation must honor: stored workspace value,
   * stored global value, the setting catalog's own default
   * (`catalog.configDefault`), and only then the caller's `defaultValue`.
   * Callers of a cataloged `texra.*` key therefore omit `defaultValue`; it is
   * for keys the catalog does not own.
   *
   * It is synchronous, and it casts: the value it returns is whatever the
   * store holds. A reader that needs the value checked reads through
   * `Settings.get`, which resolves the key's catalog row and safe-parses the
   * stored value against the row's schema; a hand-edited `"false"` in a
   * boolean row is a truthy string here and silently means the opposite.
   * Nothing may cache what either read returns: a setting the user changes
   * mid-process is read on the next call.
   *
   * Path conventions:
   * - Use dot notation with or without the canonical `texra.` prefix.
   * - Host settings such as `latex-workshop.*` must use the host adapter
   *   rather than this shared configuration path.
   */
  get<T>(key: string, defaultValue?: T): T;
  /**
   * Persist one value to the target's store. The write is an `Effect` so it
   * composes directly into the caller's program: the store's own write is an
   * Effect, and a Promise face here could only be an injected runner that
   * executes that Effect on the caller's behalf.
   */
  update<T>(
    key: string,
    value: T,
    target?: ConfigTarget,
  ): Effect.Effect<void, ConfigWriteFailed>;
  inspect<T = unknown>(key: string): ConfigInspection<T>;
  /** The setting rows this provider resolves against: the harness's and
   *  its host's, built once per composition and carried with the stores. */
  readonly catalog: SettingsCatalog;
}
```

## ConfiguredHook

One command hook the harness runs: its event, matcher and command as the
plugin wrote them, placeholders unexpanded.

```ts
interface ConfiguredHook {
  /** Its position in the plugin's configuration: `<source>/<event>/<group>/<handler>`. */
  readonly id: string;
  readonly event: HookEvent;
  readonly matcher: string | undefined;
  readonly command: string;
  /** Present: exec form, no shell. Absent: shell form (`sh -c`). */
  readonly args: readonly string[] | undefined;
  readonly timeoutSeconds: number;
}
```

## ConfigWriteFailed

A configuration write the store refused. Every implementation bottoms out in
the same `JsonStore` as the secret and state stores, so the reasons are that
store's: a filesystem error under the config path, or a config file whose
contents are no longer a JSON object.

{@link ConfigProvider.update} raises it as the failure of the write itself,
so a caller inside a program composes the write rather than adopting a
rejection it cannot type.

```ts
class ConfigWriteFailed extends Schema.TaggedError<ConfigWriteFailed>()(
  'ConfigWriteFailed',
  {
    key: Schema.String,
    target: Schema.Literals(['global', 'workspace', 'local']),
    message: Schema.String,
    cause: Schema.Defect(),
  },
)
```

## ConversationFormatOptions

```ts
interface ConversationFormatOptions {
  /** Truncate user/assistant text at this many chars. Omit for no limit. */
  readonly textLimit?: number;
  /** Truncate tool-call, tool-result, and thinking text at this many chars. Omit for no limit. */
  readonly toolBlockLimit?: number;
  /** Render a `[tool_use: ...]` marker for tool calls. Defaults to `true`. */
  readonly includeToolUseMarkers?: boolean;
  /** Include the call's input/args in the tool_use marker (`name(json)` vs bare `name`). Defaults to `true`. */
  readonly includeToolUseInput?: boolean;
  /** Replace thinking text with a fixed marker. Defaults to `false`. */
  readonly hideProviderReasoning?: boolean;
}
```

## createExternalLocation

```ts
function createExternalLocation(
  absolutePath: string,
): ExternalFileLocation
```

## createRunStorageLocation

```ts
function createRunStorageLocation(
  absolutePath: string,
  relativePath: string,
  runId: RunId,
): RunStorageFileLocation
```

## createWorkspaceLocation

```ts
function createWorkspaceLocation(
  absolutePath: string,
  relativePath: string,
): WorkspaceFileLocation
```

## CurrentValues

A root's current values (`current_value`): one row per family and key,
replaced in place, outside the event history, so an event-format bump
leaves them. Every write is one `BEGIN IMMEDIATE` with no aggregate claim;
a value decodes with its family's schema where it is read, and a row that
no longer decodes fails that read.

```ts
interface CurrentValues {
  readonly get: <T, D extends boolean>(
    family: ValueFamily<T, D>,
    key: string,
  ) => Effect.Effect<T | undefined, DatabaseReadFailed>;
  /**
   * Change one value from the one read under the write lock: `change`
   * answers with its result and the next value, with its result alone to
   * write nothing, or refuses and nothing is written. Only a deletable
   * family's change may answer `undefined`, which deletes the row.
   */
  readonly modify: <T, D extends boolean, A, E = never>(
    family: ValueFamily<T, D>,
    key: string,
    change: (
      current: T | undefined,
    ) => Result.Result<
      readonly [A] | readonly [A, D extends true ? T | undefined : T],
      E
    >,
  ) => Effect.Effect<A, E | DatabaseWriteFailed>;
  /** Every row of a family, latest write first. */
  readonly list: <T, D extends boolean>(
    family: ValueFamily<T, D>,
  ) => Effect.Effect<
    readonly { readonly key: string; readonly value: T }[],
    DatabaseReadFailed
  >;
  /**
   * Emits as subscribed, then after each commit, by this process or
   * another, that changed one of `keys`' values: the root's wake level
   * narrowed inside the store to those rows. A read that fails is logged and
   * retried, so no change is missed.
   */
  readonly changes: (
    family: Pick<ValueFamily<unknown, boolean>, 'name'>,
    keys: readonly string[],
  ) => Stream.Stream<void>;
}
```

## DatabaseWriteFailed

A batch was rejected whole: no member, sequence or wake level moved.

```ts
class DatabaseWriteFailed extends Schema.TaggedError<DatabaseWriteFailed>()(
  'DatabaseWriteFailed',
  storeFailure,
)
```

## decideRunModel

```ts
function decideRunModel(
  candidates: readonly RunModelCandidate[],
  isRunnable: (model: string) => boolean = () => true,
): RunModelDecision | null
```

## deleteStorageInventory

Delete what an inventory of `storageRoot` listed, each item on its own.
Only an item a fresh read of the inventory still lists is touched: a path
that is no longer an orphan or an aside copy under `storageRoot` (its root
came back, a drive was remounted, or it was never listed there) is
reported and left in place. An orphan store another process has open is
kept, and a failed deletion is reported while the rest still go. Each
item's outcome, in listing order.

```ts
const deleteStorageInventory: (storageRoot: string, inventory: Pick<StorageInventory, "orphans" | "asides">) => Effect<({ path: string; outcome: "failed"; message: string; } | { path: string; outcome: "kept"; message?: undefined; } | { path: string; outcome: "deleted"; message?: undefined; } | { path: string; outcome: "failed"; message: string; })[], DatabaseReadFailed | PlatformError, FileSystem | GlobalValues>
```

## describeFollowUpFailure

The one wording of each refusal, shared by every host and tool output.

```ts
function describeFollowUpFailure(reason: FollowUpFailureReason): string
```

## DiffHunks

One diff pass: its hunks, and — when the pass hit its bound — the warning
naming why the hunks are a whole-file replacement.

```ts
interface DiffHunks {
  readonly hunks: StructuredPatchHunk[];
  readonly timeout: string | undefined;
}
```

## DraftBlob

A string a draft stores with its row under its address (`blobAddress`):
a media part's or a captured attachment's base64, which the row names by
`digest`. One without `text` is already in the store and is linked to the
row, so collection keeps it while the row lives. Never part of a
committed row.

```ts
interface DraftBlob {
  readonly digest: string;
  readonly text?: string;
}
```

## EnabledSkill

One skill a person may activate: its display row, and the activation
block a message carries to select it.

```ts
interface EnabledSkill {
  readonly display: SkillDisplayItem;
  readonly activation: string;
}
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

## EventsRead

A read of committed events.

```ts
type EventsRead = Effect.Effect<
  readonly SessionEvent[],
  DatabaseReadFailed
>;
```

## ExportNode

```ts
type ExportNode = typeof ExportNodeSchema.Type;
```

## ExportNodeSchema

One node of a run's conversation as an export reads it.

```ts
const ExportNodeSchema: Union<readonly [Struct<{ readonly kind: Literal<"user-message">; readonly parts: $Array<Union<readonly [Struct<{ readonly type: Literal<"text">; readonly text: String; }>, Struct<{ readonly type: Literal<"attachment">; readonly attachmentType: Literals<readonly ["image", "document"]>; }>]>>; }>, Struct<{ readonly kind: Literal<"assistant-text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"thinking">; readonly text: String; }>, Struct<{ readonly kind: Literal<"tool-call">; readonly name: String; readonly input: Unknown; }>, Struct<{ readonly kind: Literal<"tool-result">; readonly text: String; }>, Struct<{ readonly kind: Literal<"web-search">; readonly query: String; }>]>
```

## ExternalToolCheckResult

Result of running a single external tool check.

```ts
interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly string[];
  readonly status: 'available' | 'not-found' | 'unknown';
  /** Short status label for the dashboard badge, when the default is too generic. */
  readonly statusLabel?: string;
  /** Human-readable status detail from the group's `detailCheck`, if any. */
  readonly statusDetail?: string;
}
```

## findTeamPreset

```ts
function findTeamPreset(
  presets: readonly TeamPreset[],
  query: string,
): TeamPreset | undefined
```

## formatConversationMessage

Render one conversation node as the role and text conversation views show.

```ts
function formatConversationMessage(
  node: ExportNode,
  options: ConversationFormatOptions = {},
): { role: 'user' | 'assistant'; content: string }
```

## formatFatalErrorDetail

Format an unowned failure for a fatal-error/startup dialog: full detail
(the stack when available) with any provider secret scrubbed. Every host's
"surface this to the user, then terminate" handler shares this formatting
so a crash dialog is never the one surface that shows a secret unredacted.

```ts
function formatFatalErrorDetail(error: unknown): string
```

## formatTeamLaunchBlockedMessage

```ts
function formatTeamLaunchBlockedMessage(
  teamId: string,
  reason: string,
): string
```

## formatUnknownTeamMessage

```ts
function formatUnknownTeamMessage(teamId: string): string
```

## getEnabledModels

The models the pickers show — the single reader of
`GlobalStateKey.MODEL_SELECTION` for every host.

```ts
function getEnabledModels(state: Pick<StateStore, 'get'>)
```

## getHelperModelName

The helper model a run, a merge, or the Models tab uses: the configured
choice while it is enabled, else the built-in default. The built-in default
is always accepted because it is used for internal auxiliary tasks, not
user-facing generation; never fall back to the first picker model, which is
a premium default. An empty enabled list falls through to the default too.

The one resolution of the chain: every surface that shows or uses the
helper model reads it here, from the setting slots the caller holds.

```ts
function getHelperModelName(stores: SettingsStores)
```

## getPathSegments

Get path segments as an array.
Only converts backslashes — does NOT resolve '..' so callers can detect
traversal attempts (e.g. AcceptRunFilesTool's `includes('..')` guard).

```ts
function getPathSegments(input: string): string[]
```

## getSdkErrorMessage

The user-facing message of any failure.

```ts
function getSdkErrorMessage(err: unknown): string
```

## GlobalStorageFs

The cross-workspace global storage root, shared by every session of the
process. Process-wide by construction — every host derives it from the one
storage root it opened — so it is provided once by the process runtime
({@link globalStorageFsLayer}) rather than per session.

```ts
class GlobalStorageFs extends Context.Service<
  GlobalStorageFs,
  RootedFileSystem
>()('@texra-ai/harness/platform/GlobalStorageFs')
```

## GlobalValues

The global root's current values: one row per family and key, replaced in
place by each write. A host or plugin keeps its own application state here
under a family it declares (`ValueFamily`).

```ts
class GlobalValues extends Context.Service<
  GlobalValues,
  CurrentValues
>()('@texra-ai/harness/GlobalValues')
```

## hasErrorPresentationClaimed

Whether the claim is on `err` or anywhere in its rethrow chain, so a
wrapper that preserves `{ cause }` stays classifiable.

```ts
const hasErrorPresentationClaimed: (err: unknown) => boolean
```

## hasExtension

Check if a file path has a specific extension (case-insensitive).
Consolidates scattered `.toLowerCase().endsWith('.ext')` patterns.

- `@example` hasExtension('notes.md', '.md') // true
  hasExtension('Notes.MD', '.md') // true
  hasExtension('notes.pdf', '.md') // false

```ts
function hasExtension(filePath: string, extension: string): boolean
```

## heldElsewhereBy

The owner a claim refusal or a `DatabaseNotOwner` of an open aggregate
names (not proven alive); null for a closed or ownerless one.

```ts
const heldElsewhereBy: (error: unknown) => string | null
```

## helperCall

One helper call: bind the configured helper model for this call alone and
run one completion through the one retry loop (`run/invocation.ts`),
gated on the process's retry gate, priced and reported to the usage log as
`attribution`. No row is written. Returns the turn's assistant text.
`stores` are the asking session's setting slots and the process secret
store: the binding, the retry limit and the usage consent read them.

```ts
const helperCall: (stores: ModelOptionStores, args_1: HelperPrompt, attribution: UsageAttribution, retries?: number | undefined) => Effect<string, Error | CallFailure, HttpClient | UsageLog | RouteRetries>
```

## HelperPrompt

A single non-streaming helper-model text completion.

```ts
interface HelperPrompt {
  /** User message content. */
  readonly userPrompt: string;
  /** Optional system prompt. */
  readonly systemPrompt?: string;
}
```

## HostInteractions

The host's presentation surface for a session: what a host
can show or do on the runtime's behalf. It answers nothing. Every request a
run makes of a person is a `request.opened` row the fold lists and a
`request.decide` command a surface sends, so
there is no queue behind this port and no method returns a decision.

```ts
interface HostInteractions {
  /**
   * Present a runtime event through the active host attachment. Presentation
   * is fire-and-forget: a host that cannot render an event logs the cause. A
   * host may answer with the program that puts the event on screen; nothing
   * waits on it, and its failure is reported rather than dropped (see
   * `presentOn`).
   */
  emit?<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ): HostPresentation;
  /**
   * This host has no channel that can answer an approval prompt (a headless
   * run, an embedder with no surface): a fact about the host alone. The
   * session applies its approval policy to it, both when it decides a request
   * and when it withholds approval-gated tools from a run.
   */
  readonly approvalPromptsUnavailable?: boolean;
  /**
   * The session's approval policy closed a gate on `runId` (a command, edit,
   * plan, delegation, retry or question) or withheld tools from it. Told
   * after the fact, so a host can say why nothing was asked; it answers
   * nothing.
   */
  approvalDenied?(denial: ApprovalPolicyDenial, runId: RunId): void;
  /**
   * Stage a tool edit's preview (its original and proposed content, which
   * the durable request payload does not carry) for the request the fold
   * lists under `request.permission.requestId`. The decision comes back as
   * that request's `request.decide`; a host that stages nothing leaves the
   * request answerable from its payload alone.
   *
   * The session's own {@link SessionHostInteractions.presentToolEdit} hands
   * its caller the release for what this staged; a host implements the
   * staging alone.
   */
  presentToolEdit?(request: ToolEditApprovalRequest): void;
  /**
   * Drop what {@link presentToolEdit} staged for one request, for the single
   * case no `request.decided` ever reaches: a request whose `request.opened`
   * never committed. Every host that stages implements both. An `Effect`:
   * the cleanup (a diff view to close, temp files to delete) is a program the
   * session composes into its own. Built when staged, run only then.
   */
  releaseToolEdit?(requestId: string): Effect.Effect<void>;
  /**
   * Approve a request {@link presentToolEdit} staged, with the content the
   * user edited in the host's view. `false` when nothing is staged, which
   * the caller then approves from the payload; `true` when the host took
   * the decision (a failed read of the edit included, left pending).
   */
  approveToolEdit?(requestId: string): Effect.Effect<boolean>;
  /** What {@link presentToolEdit} staged for a pending request, or null:
   *  the answer to a `request.preview`. */
  preview?(requestId: string): Effect.Effect<ToolEditContent | null>;
  dispose?(): void;
}
```

## HostPresentation

What a host answers an `emit` with: the program that presents the notice,
or nothing when the host already presented it. Presentation is
fire-and-forget, so the runtime forks that program and reports its
failure — which is why a host hands it over rather than running a fiber
of its own.

```ts
type HostPresentation = Effect.Effect<void, Error> | void;
```

## InstalledPlugin

```ts
type InstalledPlugin = typeof InstalledPluginSchema.Type;
```

## InstalledPlugins

The Claude Code and Codex plugins installed for every host: the one
install record in a session's global state, the trust given to each, and
the managed plugins under its global storage, which the storage root the
host opened derives. Each operation takes those roots (`PluginEnv`; a
session's `WorkspaceRoots` is one), so a host acts on the record its
process opened.

```ts
const InstalledPlugins: Readonly<{ readonly unloadedComponents: readonly ("LSP servers" | "output styles" | "apps")[]; readonly origin: (input: string, cwd: string, ref: string | undefined) => Result<PluginOrigin, PluginRequestError>; readonly install: (origin: PluginOrigin, only: readonly string[], env: PluginEnv) => Effect<{ readonly name: string; readonly path: string; readonly source: string; readonly skills: readonly string[]; readonly enabled: boolean; readonly description?: string | undefined; readonly version?: string | undefined; readonly ref?: string | undefined; readonly commit?: string | undefined; readonly trust?: { readonly version: string | null; readonly digest: string; } | undefined; }[], Error, FileSystem | ChildProcessSpawner>; readonly update: (names: readonly string[], env: PluginEnv) => Effect<PluginUpdate[], PluginRequestError | PluginError, FileSystem | ChildProcessSpawner>; readonly remove: (name: string, env: PluginEnv) => Effect<{ name: string; path: string; local: boolean; leftover: boolean; }, PluginRequestError | PluginError, FileSystem>; readonly list: (env: PluginEnv) => Effect<PluginListing[], PluginError, FileSystem>; readonly enable: <E, R>(name: string, env: PluginEnv, confirm: (review: PluginReview) => Effect<boolean, E, R>) => Effect<"enabled" | "declined", E | PluginRequestError | PluginError, FileSystem | R>; readonly disable: (name: string, env: PluginEnv) => Effect<undefined, PluginRequestError | PluginError, never>; readonly loaded: (env: Pick<PluginEnv, "globalState">) => Effect<{ readonly name: string; readonly path: string; readonly source: string; readonly skills: readonly string[]; readonly enabled: boolean; readonly description?: string | undefined; readonly version?: string | undefined; readonly ref?: string | undefined; readonly commit?: string | undefined; readonly trust?: { readonly version: string | null; readonly digest: string; } | undefined; }[], never, FileSystem>; readonly describeHook: (hook: ConfiguredHook) => string; }>
```

## InvalidAgentTeamError

```ts
class InvalidAgentTeamError extends Schema.TaggedError<InvalidAgentTeamError>()(
  'InvalidAgentTeamError',
  { message: Schema.String },
)
```

## isFileNotFoundError

Check if an error represents a file-not-found condition.

```ts
function isFileNotFoundError(err: unknown): boolean
```

## isModuleNotFoundError

Check if an error is "dynamic import couldn't find the module" (Node + ESM variants).

```ts
function isModuleNotFoundError(err: unknown): boolean
```

## isNotADirectoryError

Check if an error represents "a parent path component is a file, not a directory".

```ts
function isNotADirectoryError(err: unknown): boolean
```

## isPathWithin

True if `target` is `base` itself or a descendant of it.
Computed via path.relative — works for both absolute and relative inputs
as long as both are resolved the same way by the caller.

```ts
function isPathWithin(base: string, target: string): boolean
```

## isStrictlyWithin

True if `target` is a strict descendant of `base` (excludes `target === base`).

```ts
function isStrictlyWithin(base: string, target: string): boolean
```

## isUserAbort

True if `err` is an `AbortController` abort (a DOM `AbortError`).

```ts
function isUserAbort(err: unknown): boolean
```

## launchableTeamPresets

The catalog's launchable teams: every preset but the setup starter.

```ts
function launchableTeamPresets(customRaw: unknown): TeamPreset[]
```

## listRunGeneratedFiles

List the generated (non-KV) files under a run's storage directory, sorted by
path. Returns `[]` when the run has no storage directory at all.

`storage` is the session's storage directory (`WorkspaceRoots.storage`),
taken as data rather than from an ambient session scope a fiber's
continuation may not carry, so a host holding one session per open project
walks the storage of the session it names.

```ts
const listRunGeneratedFiles: (runId: string & Brand<"RunId">, storage: string) => Effect<RunGeneratedFile[], PlatformError, FileSystem>
```

## loadTeamOptions

```ts
function loadTeamOptions<T extends TeamCatalogAgent>(
  ports: Omit<TeamRunOptions<T>, 'agentOverride'> & {
    customPresetsRaw: unknown;
  },
): TeamOptionData[]
```

## LOG_CHANNEL

Annotation naming the logical channel an entry belongs to.

```ts
const LOG_CHANNEL: "channel"
```

## LogEntry

One diagnostic record, shaped by Effect's own structured formatter rather
than by a type of ours: `Logger.formatStructured` already carries level,
fiber, timestamp, message, cause, annotations, and spans, so the logger
layer maps straight onto this with no adaptation.

```ts
type LogEntry = ReturnType<typeof Logger.formatStructured.log>;
```

## LogSink

```ts
interface LogSink {
  write(entry: LogEntry): void;
  dispose?(): void;
}
```

## mcpConfigPathOf

The user's MCP config file: `mcp.json` at a storage root.

```ts
function mcpConfigPathOf(storageRoot: string): string
```

## McpServerConfig

One configured stdio server, as the MCP plugin spawns it.

```ts
interface McpServerConfig {
  /** The `<server>` in its tools' `mcp__<server>__<tool>` names. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The directory it runs in: an installed plugin's root. */
  readonly cwd?: string;
}
```

## mcpServerOfToolName

The server an MCP tool name (or `mcp__<server>__*` wildcard) names, or
`undefined` for any other tool name.

```ts
function mcpServerOfToolName(name: string): string | undefined
```

## ModelHostFactUnreadable

A host fact (a preference, a config switch, a stored state entry) could not
be read because the host's store threw. Environmental, so it is a typed
failure a caller recovers from like an unreadable secret store. The module's
own invariant ({@link resolveModelAvailability}) stays a defect.

```ts
class ModelHostFactUnreadable extends Schema.TaggedError<ModelHostFactUnreadable>()(
  'ModelHostFactUnreadable',
  {
    fact: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
)
```

## ModelOption

One visible model's option: whether it can run now, the route that decided
it, and what that route means for the next request. The registry does not
describe an `unknown-model`. Each host words a row from it (the app's
`modelOptionsFrom`).

```ts
type ModelOption =
  | {
      readonly model: string;
      readonly availability: 'unknown-model';
      readonly unavailableReason: string;
      readonly usageRoute?: undefined;
    }
  | {
      readonly model: string;
      readonly availability: ModelAvailabilityKind;
      /** Why it cannot run now, worded as a run would fail; absent when it can. */
      readonly unavailableReason?: string;
      /** The subscription paying for the next request; absent means own keys. */
      readonly usageRoute?: UsageRoute;
      /** The registry config as published: what the model is. */
      readonly published: ModelConfig;
      /** The config it runs with on its route. */
      readonly config: ModelConfig;
      readonly route: ModelRoute;
      /** The key its route bills, or the model's own source. */
      readonly source: string;
      /** The user's saved reasoning effort for it. */
      readonly savedEffort: ReasoningEffort | undefined;
      /**
       * What a run on the route sends for reasoning; absent when the model
       * does not reason there, or no backend serves the route (a model
       * with no route, whose row is unavailable).
       */
      readonly reasoning: RouteReasoning | undefined;
    };
```

## ModelOptionStores

Every store an availability answer here reads: the secret store behind the
provider-key checks, and the three setting slots behind the picker's
persisted choices and the routing switches (the two "prefer my
subscription" preferences, the Kimi Code preference). Callers
hold them (a session's `roots`, the `Secrets` service, the stores a host
root threaded down) and pass them in, so this module never looks a host up
and never needs the caller's workspace-roots frame to answer for the
caller's workspace.

```ts
interface ModelOptionStores extends SettingsStores {
  readonly secrets: PlatformSecrets;
  readonly globalState: StateStore;
}
```

## OFFICE_EXTENSIONS

File extensions for binary office document formats (case-insensitive, with leading dot).

```ts
const OFFICE_EXTENSIONS: readonly string[]
```

## ownKeyCredential

The user's own `provider` key and the endpoint they set for it, for a
request llm does not model (audio transcription): the route a model of
`config` takes with every preference off.

```ts
const ownKeyCredential: (stores: ModelOptionStores, config: ModelConfig, provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode") => Effect<RouteCredential, RouteUnavailable, never>
```

## pathToLocationIn

Convert a string path to a FileLocation against the workspace root its
caller holds as data: `undefined` with no folder open, which resolves every
path as external.

NOT run-storage aware — it can only create workspace or external locations.
For run-storage awareness, use RunFileService.createLocation() instead.

Path normalization is handled internally - you can pass paths with either
forward slashes or backslashes. It's safe to pass already-normalized paths
(path.normalize() is idempotent).

- `@param` workspaceRoot - The session's workspace root
- `@param` target - Absolute or workspace-relative path
- `@returns` FileLocation (workspace or external, never runStorage)

```ts
function pathToLocationIn(
  workspaceRoot: string | undefined,
  target: string,
): FileLocation
```

## PerKeyLane

One in-process exclusive lane per key for Effect programs: the `Deferred`
the most recent entrant completes when it leaves, plus the number of
fibers holding or waiting on the lane. The count is what lets the entry
leave its map once the last fiber settles.

```ts
interface PerKeyLane {
  tail: Deferred.Deferred<void>;
  fibers: number;
}
```

## PerKeyLanes

Where the lanes live. A `Map` is the usual choice; a `WeakMap` keyed by an
owning object works too and does not need the idle cleanup (its entries'
lifetime is the key's own), which is why only these three methods are
required.

```ts
interface PerKeyLanes<Key> {
  get(key: Key): PerKeyLane | undefined;
  set(key: Key, lane: PerKeyLane): unknown;
  delete(key: Key): unknown;
}
```

## planTeamRun

```ts
function planTeamRun<T extends TeamCatalogAgent>(
  preset: TeamPreset,
  options: TeamRunOptions<T>,
): TeamRunPlan<T>
```

## planTeamRuns

```ts
function planTeamRuns<T extends TeamCatalogAgent>(
  presets: readonly TeamPreset[],
  options: TeamRunOptions<T>,
): TeamRunPlan<T>[]
```

## PlatformSecrets

Provider for secure secret storage (API keys, tokens).

Every member is an `Effect`, so a caller inside a program gets
the failure typed as {@link SecretsFailed} instead of `unknown`, and a
credential read is interruptible like the program around it.
{@link PlatformSecrets.set} and {@link PlatformSecrets.delete}
carry one extra rule: a credential
commit survives cancellation. The uninterruptible region is the commit
itself and nothing before it — for the file-backed store it begins once
the write lane has been entered, inside `FileSecrets`, so a write still
queued behind another one can be cancelled. Everything that
prepares a write — the lane wait, opening the store — stays interruptible, because interruption there means
nothing was written. A post-commit step cannot run as a step after the
write: a commit the store landed still exits as interrupted when its caller
was cancelled during it, so the step would be skipped over a credential
that is now on disk. The host stores therefore own the post-commit facts
themselves, in an `Effect.ensuring` finalizer that runs on every exit: they
publish the `credentialChanged` app signal (the VS Code store publishes it
from `SecretStorage.onDidChange` instead). A writer does not by hand.

```ts
interface PlatformSecrets extends CredentialStore {
  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed>;
}
```

## PluginContext

The services a step pinned from its plugins' layers (a plugin's
`processLayer` and `sessionLayer`), erased: the harness names no plugin's
service. A plugin's own code requires them by name, which `definePlugin`
checks against what its layers serve, and reaches them
only through the step that pinned the plugin, which provides this context
to the call.

```ts
type PluginContext = Context.Context<never>;
```

## PluginEnv

The roots every host's plugin actions run over: the global state the
record lives in, and the global storage the managed plugins live under,
the same two for the CLI, the extension and the desktop.

```ts
type PluginEnv = Pick<SettingsStores, 'globalState'> & {
  readonly globalStorage: string;
};
```

## PluginError

A plugin that cannot be read or installed; the message is for the user.

```ts
class PluginError extends Schema.TaggedError<PluginError>()(
  'PluginError',
  {
    message: Schema.String,
  },
)
```

## PluginListing

One installed plugin as a listing reports it.

```ts
interface PluginListing extends InstalledPlugin {
  readonly skillCount: number;
  readonly commandCount: number;
  readonly agentCount: number;
  /** Its MCP servers' names, as its tools carry them. */
  readonly mcpServers: readonly string[];
  /** Whether the user trusts it as it is now. */
  readonly trusted: boolean;
  /** Its command hooks, and the configured ones the harness does not run. */
  readonly hooks: readonly ConfiguredHook[];
  readonly unsupportedHooks: readonly string[];
  /** Code components, which keep it from being enabled (LSP servers). */
  readonly code: readonly string[];
  readonly ignored: readonly string[];
  /** Why the plugin cannot be read now, when it cannot. */
  readonly problem?: string;
}
```

## PluginOrigin

Where a plugin comes from, as the user named it.

```ts
type PluginOrigin =
  | { readonly kind: 'git'; readonly url: string; readonly ref?: string }
  | { readonly kind: 'local'; readonly path: string };
```

## PluginRequestError

What the user asked for cannot be done as asked: an unknown or taken
name, or a marketplace that needs the plugin named.

```ts
class PluginRequestError extends Schema.TaggedError<PluginRequestError>()(
  'PluginRequestError',
  {
    message: Schema.String,
  },
)
```

## PluginReview

What enabling a plugin asks the user to trust.

```ts
interface PluginReview {
  readonly name: string;
  readonly version: string | null;
  /** What the plugin declares, one line each, for the prompt. */
  readonly lines: readonly string[];
}
```

## PluginUpdate

One plugin's update: the commit it moved from and to, when fetched.

```ts
interface PluginUpdate {
  readonly name: string;
  readonly from?: string;
  readonly to?: string;
}
```

## PresentationEventHandlers

One handler per {@link RuntimePresentationEventPayloads} key, each typed to
that event's own payload. A host builds this as an object literal and
dispatches with `handlers[event](payload)` from a generic
`emit<K extends RuntimePresentationEvent>`: the mapped type correlates the
handler to the key, so no per-event `payload as Payloads['x']` cast is
needed, and omitting a key is a compile error rather than a dropped event.
`Result` is what the host's own dispatch answers with — {@link * HostPresentation} for a host behind `HostInteractions.emit`.

```ts
type PresentationEventHandlers<
  Payloads = RuntimePresentationEventPayloads,
  Result = unknown,
> = {
  [K in keyof Payloads]: (payload: Payloads[K]) => Result;
};
```

## presentFollowUpResult

```ts
function presentFollowUpResult(
  result: SubmitFollowUpResult,
): { severity: 'none' } | { severity: 'info' | 'warning'; message: string }
```

## presentRunFailure

Present a failed run from its raw error: the primary failure, classified,
worded as `prefix` plus its text (a `Rejected` request's reason), and
replayed to a surface that attaches later, then marked presented. A
failure already presented (here, by the terminal-result presenter, or
through a targeted notice) presents nothing. A `Session` start's
`RunFailure` is presented as the failure it carries.

```ts
function presentRunFailure(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  error: unknown,
  prefix = '',
): Effect.Effect<void>
```

## processLayer

The process services a composition root runs on and the {@link Sessions}
opening, listing and closing its sessions (one per storage root), for a
`ManagedRuntime` the host disposes on shutdown. Disposal closes every open
session, plugins drained first; a host whose resources must outlive them
runs `Sessions.closeAll` first.

The host owns its process, so the model transport's dispatcher also
becomes the process's global one, and the rest of its HTTP traffic follows
the same proxy policy. An embedder's process (`Sessions.layer`) keeps its
own global dispatcher: its model traffic carries the transport anyway.

```ts
function processLayer(
  options: ProcessLayerOptions,
): Layer.Layer<ProcessServices | Sessions>
```

## ProcessLayerOptions

What a composition root composes its process from: the app's plugins and
setting rows and the host's own ports. What every host builds the same
way (the process identity, the global root's database) has a default.

```ts
interface ProcessLayerOptions {
  /** The process-start read the process identity is derived from, once per
   *  process: absent, this Node process's own (`nodeProcesses.selfIdentity`). */
  readonly processStart?: Effect.Effect<
    string | undefined,
    never,
    ProcessProbe
  >;
  /** The storage root this process opened (`WorkspaceRoots.storageRoot`). */
  readonly storageRoot: string;
  /**
   * The app's plugins, in order, the harness's built-ins among them: the
   * process serves them as `ToolRegistry` and the tool catalog over it
   * (`ToolCatalog`). The harness names no plugin of its own: an app passes
   * its list, `harnessBuiltins` among it.
   */
  readonly plugins: readonly Plugin[];
  readonly secrets: PlatformSecrets;
  /** The host's agent-directory layer: it may capture AppState as it is
   *  built, which its readers never see. */
  readonly agentDirectories: Layer.Layer<AgentDirectories, never, AppState>;
  /** The host's tool-missing reporter, served as `ToolMissingReporter`;
   *  absent (no UI for it), a probe still answers, without surfacing. */
  readonly toolMissingReporter?: ToolMissingHandler;
  /**
   * The host's global application-state layer, acquired in this runtime's
   * scope. Absent, the global root's values (`globalAppStateLayer`); the
   * SDK's embedder store, or a platform-less CLI entry's refusing one.
   */
  readonly appState?: Layer.Layer<
    AppState,
    DatabaseOpenFailed,
    GlobalDatabase | ProcessIdentity | ProcessProbe
  >;
  /** The dependency probes every tool gate and Tools dashboard read: absent,
   *  every host's; a test harness passes one that starts no probe. */
  readonly toolAvailability?: typeof toolAvailabilityLayer;
  /** The host's usage layer owns its version-stamped sender and final drain,
   *  so this composition does not reach into telemetry. Absent,
   *  `UsageLog.disabled`: no usage is reported, as for an embedder, which
   *  has no version or editor of its own to stamp entries with. */
  readonly usageLog?: Layer.Layer<
    UsageLog,
    never,
    HttpClient.HttpClient | AppState
  >;
  /** The process's handle on the global storage root, built and closed with
   *  this runtime. Absent, the root's own database, whose open creates its
   *  SQLite file and forks a change poll, so the CLI entry that runs before
   *  any platform, on a possibly read-only root, passes a refusal. */
  readonly globalDatabase?: Layer.Layer<
    GlobalDatabase,
    DatabaseOpenFailed,
    ProcessIdentity | ProcessProbe
  >;
  /** The runtime's emission threshold for Effect diagnostics, from facts that
   *  cannot change mid-process: the surface (the extension's channel filters
   *  itself: `'Trace'`; the desktop's log file: `'Debug'`) or the CLI's
   *  `--quiet` / `--verbose`. It is read before any logger runs, so a live
   *  user setting arrives by another road (the fold's `debug` flag). */
  readonly minimumLogLevel: LogLevel.LogLevel;
  /** A single-project host's folder, whose `.env` its own reads see. */
  readonly workspace?: string;
}
```

## ProcessRuntime

The runtime a composition root makes over `processLayer`: the process
services, and the `Sessions` that open and close its sessions.

```ts
type ProcessRuntime = ManagedRuntime.ManagedRuntime<
  ProcessServices | Sessions,
  never
>;
```

## ProcessServices

The runtime over the process-lifetime services every entry provides: the
cohort-A tags, the language-model bridge and the HTTP client, merged once in
`processLayer`'s `services` layer, plus the standard library's
`FileSystem`, `Path` and `ChildProcessSpawner`, which the same install
provides from `@effect/platform-node` so a program that reads a file or
starts a child process takes them from context instead of building a Node
layer of its own, and
`GlobalStorageFs`, the cross-workspace storage view every session of the
process shares, `GlobalDatabase`, that same root's one database handle,
which the app's records and the CLI's input history read through,
`ProjectDatabases`, whose project-scoped borrows share each persistent
connection between application state and a session graph, `ToolRegistry`,
the plugin table every run's offered tools are rebuilt from,
`ToolCatalog`, the tool catalog each session's steps pin their tools in
(its owner's view, `ToolCatalogOwner`, stays inside the composition), and
`ToolAvailability`, each workspace's last dependency probe. Every run
and session of the process is provided these; the `Sessions` above them
is the composition root's alone ({@link ProcessRuntime}).

```ts
type ProcessServices =
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
  | RouteRetries;
```

## quotaFallbackRouteFor

The catalog entry of a declinable route. Every declinable route has one.

```ts
function quotaFallbackRouteFor(
  usageRoute: DeclinableUsageRoute,
): QuotaFallbackRoute
```

## readCustomAgentDir

The custom agent directory the user configured, trimmed; empty when none is
(the host then uses its default directory).

```ts
const readCustomAgentDir: (state: Pick<StateStore, "get">) => Effect<string, StateReadFailed, never>
```

## readMcpConfig

The config file's servers and the warnings its invalid entries raise, or
`null` when the file does not exist. An unreadable file, invalid JSON or a
wrong shape is one warning and no servers. The Plugins page lists them
read-only from here, and the CLI warns of a broken file at startup.

```ts
const readMcpConfig: (fs: FileSystem, file: string) => Effect<{ servers: McpServerConfig[]; warnings: string[]; } | null, never, never>
```

## readModelOptions

Every visible model's option, in the order they are shown — the one read
behind every model picker, run-model check and prospective route. The
facts every model shares are read once, each model is routed once, then
one key status is read per provider the routes consult; each option is
finished purely over them, so the ~157-model settings pass costs no
per-model awaits. Every host read fails in its typed channel
({@link ModelHostFactUnreadable}). `models`, when given, is honored
verbatim, one option each, in order. Nothing is cached here: the sign-in
state is read live by design.

```ts
const readModelOptions: (stores: ModelOptionStores, models?: readonly string[] | undefined) => Effect<ModelOption[], ModelHostFactUnreadable, never>
```

## readSessionView

The view of the session stored at `storage`, built from its listing, with
its probed owners' deaths applied beside it; none when no store is there.
A connection this process already holds (`ProjectDatabases`) is shared;
otherwise the read opens the store for itself without ever creating one,
so a store a prune just removed is read as gone, never made again.

```ts
const readSessionView: (storage: string) => Effect<Option<{ readonly key: string; readonly runs: ReadonlyMap<string & Brand<"RunId">, { readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cacheReadInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheCreationInputTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly parentCard: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly description: string | null; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly status: "completed" | "cancelled" | "failed" | "waiting" | "running" | "ready"; readonly recipe: string | null; readonly plan: { readonly objective: string; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly phaseCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly mediaFiles?: readonly string[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | "userRetryable" | TypeOptionalKeys<{ readonly message: String; readonly statusCode: optional<Int>; readonly statusText: optional<String>; readonly provider: optional<String>; readonly classification: optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>; readonly requestId: optional<String>; readonly partialText: optional<String>; readonly userRetryable: Boolean; readonly rawMessage: optional<String>; readonly operation: optional<String>; readonly model: optional<String>; }>; readonly value: string; }[]; readonly detailText: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: string; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: string; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "completed" | "failed" | "in_progress" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly exitCode?: number | undefined; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; readonly phase?: string | undefined; readonly attempt?: number | undefined; } | { readonly kind: "webSearch"; readonly label: string; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly source?: string | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly detail?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly groupId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly taskGroups: readonly { readonly id: string; readonly name: string; readonly status: "completed" | "cancelled" | "failed" | "running"; readonly startTime: number; readonly kind?: "script" | "run" | "session" | undefined; readonly endTime?: number | undefined; readonly parentGroupId?: string | undefined; }[]; readonly settledRows: number; }; readonly parentId: (string & Brand<"RunId">) | null; readonly facts: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly ownerId: string | null; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly substate: "paused" | "starting" | "resuming" | "resultWaiting" | null; readonly durableOutcome: "completed" | "cancelled" | "failed" | null; readonly statusNotice: { readonly kind: "damaged" | "earlierBuild"; } | { readonly kind: "resumeBlocked"; readonly reason: { readonly kind: "agentMissing" | "pluginOff" | "pluginUntrusted"; readonly name: string; }; readonly retry: boolean; } | { readonly kind: "interrupted"; } | { readonly kind: "held"; readonly pid: number; } | { readonly kind: "lost"; readonly message: string; } | null; readonly resumeBlocked: { readonly kind: "agentMissing" | "pluginOff" | "pluginUntrusted"; readonly name: string; } | null; readonly lost: string | null; readonly statusKey: "completed" | "cancelled" | "failed" | "paused" | "waiting" | "running" | "ready" | "starting" | "resuming" | "resultWaiting" | "interrupted" | "waitingOnUser"; readonly tone: "success" | "running" | "danger" | "neutral" | "warning"; readonly runStartedAt: number | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly approval: "own" | "descendant" | "none"; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export" | "copy")[]; readonly latestLine: string | null; readonly ownedHere: boolean; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly conversationProgress: { readonly toolCallCount: number; }; readonly followUpSupport: "unsupported" | "nativeInteractive" | "terminalBacked"; readonly readOnly: boolean; readonly forceExpanded: boolean; readonly group: "waiting" | "running" | "interrupted" | "recent"; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cacheReadInputTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly cacheCreationInputTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly agentScope?: readonly string[] | null | undefined; }>; readonly order: readonly (string & Brand<"RunId">)[]; readonly cursor: number; readonly debug: boolean; readonly transcriptSeq: ReadonlyMap<string & Brand<"AggregateId">, number>; readonly rollup: { readonly running: number; readonly waiting: number; readonly interrupted: number; }; readonly requests: readonly { readonly runId: string & Brand<"RunId">; readonly requestId: string; readonly payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly allowBypass: boolean; readonly runId: "" | (string & Brand<"RunId">); readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: "" | (string & Brand<"RunId">); readonly allowBypass: boolean; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly operation: string; readonly model?: string | undefined; readonly errorMessage?: string | undefined; readonly errorDetails?: { readonly message?: string | undefined; readonly statusCode?: number | undefined; readonly statusText?: string | undefined; readonly provider?: string | undefined; readonly classification?: { readonly kind: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "missing-api-key" | "context-window" | "upstream-credit" | "glm-coding-plan"; } | undefined; readonly requestId?: string | undefined; readonly partialText?: string | undefined; readonly userRetryable?: boolean | undefined; } | undefined; readonly credentialSwitch?: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; readonly automatic: boolean; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly options?: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "externalInquiry"; readonly data: { readonly requestId: string; readonly runId: "" | (string & Brand<"RunId">); readonly allowBypass: boolean; readonly question: string; readonly threadId: string; readonly context?: string | null | undefined; readonly suggestSearch?: boolean | null | undefined; readonly attachFiles?: readonly string[] | null | undefined; readonly sessionLinks?: readonly string[] | null | undefined; readonly transcript?: readonly ({ readonly kind: "answered"; readonly question: string; readonly turnIndex: number; readonly timestamp: string; readonly answer: string; readonly answeredAt: string; readonly context?: string | null | undefined; readonly suggestSearch?: boolean | null | undefined; readonly attachFiles?: readonly string[] | null | undefined; readonly sessionLinks?: readonly string[] | null | undefined; } | { readonly kind: "open"; readonly question: string; readonly turnIndex: number; readonly timestamp: string; readonly context?: string | null | undefined; readonly suggestSearch?: boolean | null | undefined; readonly attachFiles?: readonly string[] | null | undefined; })[] | null | undefined; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: "" | (string & Brand<"RunId">); readonly allowBypass: boolean; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; }; }[]; readonly policy: ReadonlyMap<string & Brand<"RunId">, { readonly own: { readonly bash?: "parent" | "on" | "off" | undefined; readonly toolEdit?: "parent" | "on" | "off" | undefined; readonly superYolo?: "parent" | "on" | "off" | undefined; }; readonly goal: readonly ("bash" | "toolEdit" | "superYolo")[]; readonly limit?: "never" | "ask" | undefined; }>; readonly pluginFacts: readonly { readonly kind: string; readonly parent: (string & Brand<"RunId">) | null; readonly plugin: string; readonly type: "plugin.fact"; readonly aggregateId: string & Brand<"AggregateId">; readonly value: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; readonly version: number; readonly stageId?: string | undefined; }[]; readonly queuedFollowUps: ReadonlyMap<string & Brand<"RunId">, readonly { readonly followUpId: string; readonly text: string; }[]>; }>, DatabaseOpenFailed, ProcessIdentity | ProjectDatabases | ToolRegistry | ProcessProbe>
```

## readStorageInventory

The orphaned stores and aside copies under `storageRoot`.

```ts
const readStorageInventory: (storageRoot: string) => Effect<{ orphans: { readonly directory: string; readonly bytes: number; readonly why: string; }[]; asides: { readonly path: string; readonly bytes: number; }[]; skipped: { readonly path: string; readonly message: string; }[]; }, DatabaseReadFailed | PlatformError, FileSystem | GlobalValues>
```

## redactSecrets

```ts
function redactSecrets(text: string): string
```

## registerCustomAgentRoot

Register the custom agents directory the setting names now, writable.
Registering the same kind replaces its slot, so a changed setting needs no
unregister step. The settings view runs it in the same step that writes
the setting, so a run launched right after sees the new directory; the
follower runs it for a change written anywhere else.

```ts
const registerCustomAgentRoot: Effect<void, never, FileSystem | GlobalStorageFs | AgentDirectories>
```

## resolveTeamLaunch

```ts
function resolveTeamLaunch<T extends TeamCatalogAgent>(
  args: Omit<TeamRunOptions<T>, 'agentOverride'> & {
    teamId: string;
    customPresetsRaw: unknown;
  },
): TeamLaunchResolution
```

## RootedFileSystem

A `FileSystem` whose paths are resolved against — and confined to — one
root, plus the durability primitives of {@link './fsDurability'} bound to
that same root.

```ts
interface RootedFileSystem extends FileSystem.FileSystem {
  /**
   * The absolute root every relative path resolves against.
   *
   * `undefined` only for the workspace view of a session with no folder
   * open, where every operation fails with `BadArgument` — the typed form of
   * the "Workspace path is not available." throw. A consumer
   * that needs the root as a value (a glob's `cwd`) checks it and does
   * nothing.
   */
  readonly root: string | undefined;
  /** The confined absolute path of `target`, for the rare operation that
   *  spans two roots and needs each side vouched for by its own view. */
  readonly resolve: (
    target: string,
  ) => Effect.Effect<string, PlatformError.PlatformError>;
  /**
   * Crash-safe replace: stage, fsync, rename over the target. The target's
   * real path is resolved first, as `write-file-atomic` does, so a symlink
   * inside the root that points outside it is written through — the reach
   * this operation has always had, and the reason it is documented as
   * storage-only, never for workspace files.
   */
  readonly writeFileAtomic: (
    target: string,
    data: Uint8Array,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  /** Directory entries with the type of each, one `stat` per entry. */
  readonly readDirectoryTyped: (
    target: string,
  ) => Effect.Effect<
    ReadonlyArray<readonly [string, FileSystem.File.Type]>,
    PlatformError.PlatformError
  >;
}
```

## RouteCredential

The credential and endpoint of one route, resolved together.

```ts
type RouteCredential = {
  readonly provider: ApiKeyProviderId;
  readonly endpoint: string;
  /** The secret the transport sends as its bearer. */
  readonly bearer: string;
} & (
  | { readonly route: 'api-key' | 'xai-subscription' }
  | {
      readonly route: 'chatgpt-subscription';
      readonly accountId: string | null;
      /** The ChatGPT plan the session's token names; display-only. */
      readonly plan: string | undefined;
    }
);
```

## RouteReasoning

A model's reasoning on its decided route, as data: what the bind's own
policy ({@link decideReasoning}, over the inputs the bind gives it) sends,
so no surface words a level a run does not send.

```ts
interface RouteReasoning {
  /** The levels a run on the route can carry: those a saved level may take. */
  readonly efforts: readonly ReasoningEffort[];
  /** What a run sends under the user's saved level. */
  readonly sent: SentReasoning;
  /** What a run sends with no saved level: the route's default. */
  readonly fallback: SentReasoning;
}
```

## RouteRetries

The process's one retry gate, served by `processLayer`: a 429 cools a
credential for every run of every project.

```ts
class RouteRetries extends Context.Service<
  RouteRetries,
  ModelRetryGate
>()('@texra-ai/harness/RouteRetries')
```

## RouteUnavailable

No route can carry a model call now: its credential is missing or cannot
be read, the subscription session needs a sign-in, or the model is unknown
or unavailable. A failure of the
harness's own model access, never a vendor's (that is llm's `ModelError`).
`missing-api-key` is the one reason a host acts on (it offers the key
setting); every other reason is read as its message.

```ts
class RouteUnavailable extends Schema.TaggedError<RouteUnavailable>()(
  'RouteUnavailable',
  {
    reason: Schema.Literals(['missing-api-key', 'unavailable']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
```

## RunGeneratedFile

```ts
interface RunGeneratedFile {
  /** Path relative to the run storage directory, POSIX-separated. */
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}
```

## RunModelCandidate

```ts
interface RunModelCandidate {
  readonly model?: string | null;
  readonly reason: RunModelDecisionReason;
  readonly fallbackMode?: RunModelFallbackMode;
}
```

## RunModelDecision

The model a run takes, why, and the candidate it fell back from.

```ts
interface RunModelDecision {
  readonly model: string;
  readonly reason: RunModelDecisionReason;
  readonly unavailable?: true;
  readonly fallbackFrom?: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
    readonly mode: RunModelFallbackMode;
  };
}
```

## RunModelDecisionReason

```ts
type RunModelDecisionReason = keyof typeof RUN_MODEL_PRECEDENCE;
```

## RunModelFallbackMode

What happens when a candidate's model cannot run: refuse, run the next
one with a notice, or run it silently.

```ts
type RunModelFallbackMode = 'reject' | 'notice' | 'silent';
```

## RunRejection

Why this process cannot resume a run (see the module note).

```ts
type RunRejection =
  | { readonly kind: 'owned_elsewhere'; readonly owner: OwnerId }
  | { readonly kind: 'finished' }
  | { readonly kind: 'earlier_build' };
```

## RuntimePresentationEvent

```ts
type RuntimePresentationEvent = keyof RuntimePresentationEventPayloads;
```

## RuntimePresentationEventPayloads

Host-presentation requests emitted by agent/runtime code.

These are not progress facts and do not belong to the frozen host progress
compatibility vocabulary. Hosts may render them, ignore them, or route them
to their own presentation channel without changing the agent loop.
Presentation is fire-and-forget: a host that cannot render an event logs
the cause itself.

```ts
interface RuntimePresentationEventPayloads {
  requestOpenFile: RequestOpenFilePayload;
  requestShowInstruction: RequestShowInstructionPayload;
  showAgentConfigBanner: ShowAgentConfigBannerPayload;
  requestShowError: RequestShowErrorPayload;
  requestEnsureProgressView: RequestEnsureProgressViewPayload;
}
```

## RunWorkspaceFile

A workspace file a run edited, as it stands now.

```ts
interface RunWorkspaceFile {
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}
```

## Secrets

The process's secret store as an Effect service, provided once by the composition root through
`processLayer`. The shape is the port itself: a program that reads
or writes a credential yields the store's own Effect and matches
{@link SecretsFailed}.

`layer` takes the store itself. Every root builds its stores before it
installs the runtime that serves them, so there is nothing left to defer:
the service is the value the root already holds, not a thunk resolved per
member call.

```ts
class Secrets extends Context.Service<Secrets, PlatformSecrets>()(
  '@texra-ai/harness/platform/Secrets',
)
```

## seedDisabledToolDefaults

Seed the disabled-tool list for first-time users only, on every host and
in the agent package: every plugin of `plugins` whose switch starts `off`.
DISABLED_TOOLS is its own fresh-install signal: only this seed writes it
before the user does, so an absent value means the list was never set, and
a present one (an empty list included) holds the user's choices, which a
re-seed would silently undo. The read and the seed are one `modify`, so a
switch another process records between them is kept. A recorded id that
names no plugin of `plugins` is kept: one composition's list is not every
list that shares the store, and an id no plugin has switches nothing.

```ts
const seedDisabledToolDefaults: (state: StateStore, plugins: readonly Plugin[]) => Effect<void, StateReadFailed | StateWriteFailed, never>
```

## SentReasoning

What a run sends for reasoning, or why its bind refuses the request.

```ts
type SentReasoning =
  | {
      /** The effort sent: `none` with thinking off, absent when the model thinks without levels. */
      readonly effort: ReasoningEffort | undefined;
      /** Why it is not the level asked for, when the policy substituted one. */
      readonly note?: string;
    }
  | { readonly refused: string };
```

## SESSION_CLOSE_DEADLINE_MS

The budget one session close spends waiting for its runs to end before it
ends the ones still live itself (`SessionOwner.close`). A hung run must
not wedge desktop quit, eat the extension's ~5s deactivate budget, or
stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
together, so they finish under one deadline for the process, not one each.

```ts
const SESSION_CLOSE_DEADLINE_MS: 5000
```

## SessionCloseReport

```ts
type SessionCloseReport = typeof SessionCloseReportSchema.Type;
```

## sessionFsLayer

The per-session rooted filesystems, for the host boundaries that hold a
session's roots and run a program over its files. `roots.workspace` is
`undefined` for the session with no folder open: the view still exists, and
every operation on it fails with `BadArgument` instead of resolving against
some other root. `FileSystem` and `Path` stay requirements: they are
process services the runtime already provides, and building a second
filesystem here would be a second base.

```ts
function sessionFsLayer(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
): Layer.Layer<
  WorkspaceFs | StorageFs,
  never,
  FileSystem.FileSystem | Path.Path
>
```

## SessionHostInteractions

Stable per-session presentation owner. The `SessionHandle` exposes this
object once, while hosts may attach and detach presentation adapters; the
newest attachment presents, and notices raised while none is attached are
replayed to the next one.

```ts
class SessionHostInteractions implements HostInteractions
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

## setModelEnabled

Enable or disable one model — the only writer of
`GlobalStateKey.MODEL_SELECTION`.

Two invariants: at least one model stays enabled, and an unserved model is
never enabled. Either violation fails with `StateWriteFailed`.

```ts
function setModelEnabled(input: {
  readonly model: string;
  readonly enabled: boolean;
  readonly state: StateStore;
})
```

## SettingHost

The product hosts, spelled once: for settings and `unavailableHosts`.
`sdk` is the agent package embedded in someone else's process.

```ts
type SettingHost = 'vscode' | 'cli' | 'desktop' | 'sdk';
```

## Settings

Every read and write of a setting; see the module comment.

```ts
const Settings: Readonly<{ readonly get: <T>(stores: SettingsStores, key: string) => Effect<T, StateReadFailed, never>; readonly inspect: <T>(stores: SettingsStores, key: string) => Effect<StoredSetting<T>, StateReadFailed, never>; readonly getConfig: <T>(config: ConfigProvider, key: string) => T; readonly set: (stores: SettingsStores, key: string, value: unknown, target?: ConfigTarget | undefined) => Effect<void, Error | ConfigWriteFailed, never>; readonly reset: (stores: SettingsStores, key: string, target?: ConfigTarget | undefined) => Effect<void, Error | ConfigWriteFailed, never>; readonly state: <S extends Schema.Codec<unknown, unknown>>(store: Pick<StateStore, "get">, key: string, schema: S) => Effect<S["Type"], StateReadFailed, never>; }>
```

## SettingsStores

The setting slots a caller holds: a `WorkspaceRoots` is one.

```ts
interface SettingsStores {
  /** The host these stores belong to (`WorkspaceRoots.host`). */
  readonly host: SettingHost;
  readonly config: ConfigProvider;
  readonly workspaceState: StateStore;
  readonly repoState: StateStore;
  readonly globalState: StateStore;
}
```

## SkillIssueCode

```ts
type SkillIssueCode =
  | 'duplicate_name'
  | 'duplicate_realpath'
  | 'invalid_frontmatter'
  | 'invalid_name'
  | 'invalid_source'
  | 'missing_source'
  | 'missing_description'
  | 'name_mismatch'
  | 'read_error'
  | 'source_read_error';
```

## SkillIssueSeverity

```ts
type SkillIssueSeverity = 'error' | 'warning';
```

## SkillLoadIssue

```ts
interface SkillLoadIssue {
  severity: SkillIssueSeverity;
  code: SkillIssueCode;
  message: string;
  path?: string;
  name?: string;
}
```

## SkillRoots

The roots one skill read answers for: the workspace whose project skills
it finds (the home folder without one), the storage root whose `skills/`
holds the user's own, and the setting slots that switch skills, sources
and plugins off. A session's `WorkspaceRoots` is one.

```ts
type SkillRoots = SettingsStores & {
  readonly workspace: string | undefined;
  readonly storageRoot: string;
};
```

## Skills

The skills the hosts list and activate, read for one session's roots:
project skills under its workspace, the user's under its storage root,
installed plugins' as they load now, and the bundled ones the host
installed. Every read answers with the discovery issues beside the skills.

```ts
const Skills: Readonly<{ readonly interopDirs: readonly [".agents", ".claude", ".codex", ".gemini"]; readonly display: (roots: SkillRoots) => Effect<{ skills: { readonly name: string; readonly description: string; readonly scope: "custom" | "user" | "bundled" | "project" | "interop"; readonly label: string; readonly path: string; readonly sourcePath: string; readonly enabled: boolean; }[]; issues: { readonly message: string; readonly path?: string | undefined; }[]; }, StateReadFailed, FileSystem>; readonly enabled: (roots: SkillRoots, options?: SkillSourceOptions | undefined) => Effect<{ skills: EnabledSkill[]; issues: SkillLoadIssue[]; }, StateReadFailed, FileSystem>; }>
```

## SkillSourceOptions

```ts
interface SkillSourceOptions {
  readonly includeInterop?: boolean;
  readonly additionalPaths?: readonly string[];
}
```

## StateReadFailed

An authoritative state read failed; absence is a successful read.

```ts
class StateReadFailed extends Schema.TaggedError<StateReadFailed>()(
  'StateReadFailed',
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
)
```

## StateStore

Application state read from its authority when the Effect executes. A read
answers the stored JSON as `unknown`: the caller decodes it with its key's
schema (`readState`), which also owns the default of an absent key. Updates
finish after commit. A change
that depends on the current value goes through `modify`, never a `get`
then an `update`: the settings surfaces do not serialize their messages,
and hosts in separate processes share one store.

```ts
interface StateStore {
  get(key: string): Effect.Effect<unknown, StateReadFailed>;
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed>;
  /**
   * Read-modify-write of one key as one step at the store's authority:
   * `change` sees the stored value (`undefined` when absent) and returns the
   * next one, or refuses with its own error and nothing is written.
   */
  modify<T, E = never>(
    key: string,
    change: (current: unknown) => Result.Result<T, E>,
  ): Effect.Effect<T, E | StateWriteFailed>;
}
```

## StateStores

The settings stores a host opens for each project it shows.

```ts
class StateStores extends Context.Service<
  StateStores,
  {
    /** The project's own settings, in its store at `storage`, held for the
     *  caller's scope; it records which root the store serves. */
    readonly project: (
      storage: string,
      workspaceRoot: string | undefined,
    ) => Effect.Effect<AppStateStore, DatabaseOpenFailed, Scope.Scope>;
    /** The settings every checkout of `workspaceRoot`'s repository shares. */
    readonly repo: (
      storage: string,
      workspaceRoot: string | undefined,
    ) => Effect.Effect<AppStateStore>;
  }
>()('@texra-ai/harness/StateStores')
```

## StateWriteFailed

A host or database refused an application-state write.

```ts
class StateWriteFailed extends Schema.TaggedError<StateWriteFailed>()(
  'StateWriteFailed',
  {
    key: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
)
```

## StorageFs

The session's own storage root (under the process's storage directory).

```ts
class StorageFs extends Context.Service<StorageFs, RootedFileSystem>()(
  '@texra-ai/harness/platform/StorageFs',
)
```

## StorageInventory

What storage maintenance found under a storage root: the workspace stores whose `workspace-store` record names a root that
is gone, and the `.pre1`/`.corrupt-` aside copies beside the stores that
remain. The store of no workspace has no root and is never an orphan.
Nothing goes without the caller's word: an unmounted
drive looks exactly like a deleted root.

```ts
interface StorageInventory {
  readonly orphans: readonly {
    readonly directory: string;
    readonly bytes: number;
    readonly why: string;
  }[];
  readonly asides: readonly { readonly path: string; readonly bytes: number }[];
  /** The directories that could not be read, and why. */
  readonly skipped: readonly {
    readonly path: string;
    readonly message: string;
  }[];
}
```

## StoredSetting

A stored value classified against its row's schema. `value` is always
schema-parsed: the stored value when it validates, the row's default when
the key is absent. A present value that no longer validates is `invalid`
and carries only the parse failure, never a substitute value, so a caller
that must not read corruption as the default cannot pick one up by accident.

```ts
type StoredSetting<T = unknown> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'invalid'; readonly cause: string };
```

## SubscriptionPreference

Each subscription's "prefer my subscription" switch: its read (`get`) and
its write in the scope that controls it (`set`).

```ts
const SubscriptionPreference: Readonly<{ get: (provider: "chatgpt" | "grok", stores: SettingsStores) => boolean; set: (provider: "chatgpt" | "grok", stores: SettingsStores, enabled: boolean) => Effect<void, Error | ConfigWriteFailed, never>; }>
```

## TEAM_SELECTION_REQUIRED_MESSAGE

```ts
const TEAM_SELECTION_REQUIRED_MESSAGE: "Team selection required."
```

## TeamAgentAvailability

```ts
interface TeamAgentAvailability {
  readonly available: number;
  readonly total: number;
  readonly missing: readonly string[];
  readonly label: string;
}
```

## TeamAgentResolver

The workspace agents' member identity rule (`AgentCatalog.get` in
production): a bare name matches by name, a `source:name` key exactly.

```ts
type TeamAgentResolver<T> = (identifier: string) => T | undefined;
```

## teamAvailability

```ts
function teamAvailability(plan: TeamRunPlan): TeamAvailability
```

## TeamAvailability

```ts
interface TeamAvailability {
  readonly status: TeamPlanStatus;
  readonly agents: TeamAgentAvailability;
  readonly rootAgent?: {
    readonly key: string;
    readonly name: string;
    readonly source: AgentSource;
  };
  readonly missingAgentOverride?: string;
}
```

## TeamCatalogAgent

```ts
interface TeamCatalogAgent {
  readonly name: string;
  readonly source: AgentSource;
  readonly tools?: string[];
}
```

## teamLaunchBlockReason

```ts
function teamLaunchBlockReason(plan: TeamRunPlan): string | undefined
```

## TeamLaunchResolution

```ts
type TeamLaunchResolution =
  | {
      readonly status: 'ready';
      readonly fields: ReturnType<typeof teamExecutionFields>;
      readonly missingNames: readonly string[];
    }
  | { readonly status: 'unknown-team' }
  | { readonly status: 'blocked'; readonly reason: string };
```

## teamPlanStatus

```ts
function teamPlanStatus(plan: TeamRunPlan): TeamPlanStatus
```

## TeamPlanStatus

```ts
type TeamPlanStatus = 'available' | 'degraded' | 'unavailable';
```

## TeamPreset

A team preset as the catalog lists it, with where it came from.

```ts
interface TeamPreset extends AgentModePreset {
  readonly source: 'built-in' | 'custom';
  /** The setup starter: an agent list a workspace can select, never a launch. */
  readonly setupOnly?: true;
}
```

## teamPresets

The one team preset catalog, in display order: the setup starter (tagged
`setupOnly`), the built-in teams, then the workspace's custom presets.
Built-in ids are reserved: a custom preset with the same id is dropped so
the built-in always wins.

```ts
function teamPresets(customRaw: unknown): TeamPreset[]
```

## TeamRunOptions

```ts
interface TeamRunOptions<T extends TeamCatalogAgent> {
  readonly resolveAgent: TeamAgentResolver<T>;
  /**
   * The agents a built-in team runs as its root, in preference order: the
   * first one among the team's delegating members leads it, and a built-in
   * team with none of them has no root. A custom team is led by its first
   * delegating member. The app owns these names.
   */
  readonly rootAgentNames: readonly string[];
  readonly agentOverride?: string;
}
```

## TeamRunPlan

```ts
interface TeamRunPlan<T extends TeamCatalogAgent = TeamCatalogAgent> {
  readonly preset: TeamPreset;
  readonly rootAgent?: T;
  readonly missingAgentOverride?: string;
  readonly agentKeys: readonly string[];
  /** Members that did not resolve, in preset-declaration order. */
  readonly missingAgents: readonly string[];
}
```

## ToolAvailability

```ts
class ToolAvailability extends Context.Service<
  ToolAvailability,
  {
    /** Each workspace root's last results; a dashboard follows its changes. */
    readonly results: SubscriptionRef.SubscriptionRef<AvailabilityResults>;
    /**
     * Probe every plugin for `inputs`' workspace now and publish the
     * results, joining the probe in flight for that root. Tools recently
     * found missing are looked up again, so one installed since shows up.
     * Each plugin's
     * probe has its own deadline and reports a failure as `unknown`, so this
     * never fails.
     */
    readonly refresh: (
      inputs: ToolProbeInputs,
    ) => Effect.Effect<readonly ExternalToolCheckResult[]>;
    /**
     * Keep `roots`' results for the caller's scope and probe them now,
     * without waiting: a session holds its roots for its life. Only a held
     * root's results are kept, and a root's are dropped when its last holder
     * closes, so the map is bounded by the open sessions.
     */
    readonly hold: (
      roots: ToolProbeInputs,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()('@texra-ai/harness/tools/ToolAvailability')
```

## ToolCatalog

The process's tool catalog's identifier: what a program that reads the
catalog requires.
The process's tool catalog.

```ts
interface ToolCatalog {
  readonly _: unique symbol;
}
```

## ToolCatalogShape

The process's tool catalog as a host, or a plugin's process layer,
reads it.

```ts
interface ToolCatalogShape {
  /** Borrow a plugin's process services for the caller's scope without
   *  starting them; none while its layer is down. */
  readonly processServices: (
    plugin: string,
  ) => Effect.Effect<Option.Option<PluginContext>, never, Scope.Scope>;
  /** Switch a plugin that has a switch (`toggle`) on or off in the global
   *  state store, which every process follows (`AppState.changes`); any
   *  other id is refused loudly, and an invalid record refuses the write. */
  readonly setEnabled: (
    plugin: string,
    enabled: boolean,
  ) => Effect.Effect<void, StateReadFailed | StateWriteFailed>;
  /** The plugin ids switched off in the global state store now; none while
   *  no switch was written. */
  readonly disabled: Effect.Effect<ReadonlySet<string>, StateReadFailed>;
}
```

## ToolEditApprovalRequest

Tool-edit approval request / result shapes.

The request reaches a host through `SessionHandle.interactions.presentToolEdit`
(the preview the durable payload cannot carry); the decision comes back as
the request's `request.decide`. Its content carries the diff a host shows
(hunks, the first changed line), computed here once; the line counts are
the permission's.

```ts
interface ToolEditApprovalRequest extends ToolEditContent {
  readonly path: string;
  readonly sourceTool: string;
  readonly runId?: RunId | null;
  /**
   * The session's workspace roots, as data: a host's preview of this request
   * writes its temp files under the workspace and reads the diff's settings
   * from these slots, and that preview program runs on the host's own runner
   * rather than inside the tool call that raised the request, so the roots
   * have to travel with the request instead of being read from an ambient
   * workspace scope. {@link requestToolEditApproval} — the one producer of a
   * request — fills them from the run's session.
   */
  readonly roots: WorkspaceRoots;
  /**
   * What the UI shows for this request, prepared once at the tool boundary
   * (`prepareToolEditApprovalPrompt`): the payload of the `request.opened`
   * fact the session publishes, and what every host surface renders.
   */
  readonly permission: ToolEditPermission;
}
```

## ToolMissingHandler

The host's optional "tool is missing" reporter. The VS Code host is the only
one with a UI for it; every other host omits it, and callers treat an absent
reporter as silence. It settles its own presentation failures, so the probe
that reports a missing tool still gets its answer.

```ts
type ToolMissingHandler = (
  message: string,
  /** The guide page that covers installing the tool, when one is known. */
  docsPage?: string,
) => Effect.Effect<void>;
```

## ToolMissingReporter

The process's tool-missing reporter as an Effect service, provided once
by the composition root through `processLayer`. A program that needs to surface a
missing tool yields it via `Effect.serviceOption`, so an absent reporter is
silence rather than a missing requirement.

`layer` takes the reporter the root already holds; a host without a
tool-missing UI omits the service, exactly as it omitted the platform port.

```ts
class ToolMissingReporter extends Context.Service<
  ToolMissingReporter,
  ToolMissingHandler
>()('@texra-ai/harness/platform/ToolMissingReporter')
```

## toPosixPath

Convert a path to POSIX style (forward slashes, collapsed separators, resolved `.` and `..`).

```ts
function toPosixPath(relativePath: string): string
```

## TraceArm

One session arm as the trace carries it, distributive over `T`: an
{@link AgentEvent} arm, or the `run.end` a {@link ResultEvent} names. A
row the run's state is folded from is never one: the trace is the
display door, and those rows commit through the run's cell
(`runEventDraft`, typed to an unfolded draft, refuses any other).

```ts
type TraceArm<
  T extends Exclude<AgentEvent, StreamChunkEvent>['type'] | 'run.end',
> = T extends unknown
  ? Omit<Extract<SessionEventDraft, { type: T }>, 'aggregateId'>
  : never;
```

## UsageAttribution

Who a call's usage is billed to, as the usage log's wire names them. Every
field is stated: a call that serves no run (a draft polish) says so.

```ts
interface UsageAttribution {
  readonly agentName: string;
  readonly runId: RunId | null;
}
```

## UsageLog

The process-owned producer; telemetry supplies its scoped sender implementation.

```ts
class UsageLog extends Context.Service<
  UsageLog,
  {
    readonly log: (
      entry: Omit<
        UsageLogEntry,
        'timestamp' | 'extensionVersion' | 'editorType'
      >,
      config: ConfigProvider,
      /** The environment the recording run saw (its project's `.env`
       *  over the process's), whose opt-out variables also gate it;
       *  absent, the process's own. */
      env?: Readonly<Record<string, string | undefined>>,
    ) => Effect.Effect<void>;
  }
>()('@texra-ai/harness/UsageLog')
```

## UsageLogEntry

```ts
type UsageLogEntry = typeof UsageLogEntrySchema.Type;
```

## ValueFamily

One family of current values: its stored name, the schema its value
decodes with, and whether a write may delete its row (`Deletable`), in
which case a change may answer `undefined`.

```ts
interface ValueFamily<T, Deletable extends boolean = false> {
  readonly name: string;
  readonly schema: Schema.Codec<T, unknown>;
  readonly deletable: Deletable;
}
```

## WithBlobs

A draft with the blobs it stores or links.

```ts
type WithBlobs<Draft> = Draft & {
  readonly blobs?: readonly DraftBlob[];
};
```

## withLogChannel

Name the channel every `Effect.log*` inside `self` belongs to. Annotations
nest, so a callee that names its own channel keeps it: this sets the channel
for the entries that don't.

```ts
const withLogChannel: (channel: string) => <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
```

## withPerKeyLane

Run `self` on `key`'s lane, FIFO: each entrant claims the lane
synchronously when its effect starts by swapping its own `Deferred` in as
the tail, waits for its predecessor's, and hands off in `ensuring` once
`self` succeeds, fails, or is interrupted. The wait itself is
interruptible; a waiter interrupted before entering hands its successor
the wait for its own predecessor, so the successor still waits for whoever
actually holds the lane. A hand-off through a `Deferred` resumes the next
fiber directly, so fibers started in sequence enter in that order — a
`Semaphore` barges: its release wakes waiters in a scheduled task, and a
fiber started in between takes the free permit ahead of them. The lane is
created on first use and deleted from `lanes` once the last fiber holding
or waiting on it settles.

A `Queue` of tickets served by one detached worker fiber (the shape
`sessionFrames.ts` uses) was prototyped against this chain in review and
not taken. FIFO came for free, but `Queue.make` is `withFiber`, so the
queue cannot be created in the synchronous claim step: the create path
had to re-check the map after `Queue.unbounded` and claim in the same
synchronous step as the insert, because a lane whose count drops to zero
ends its queue and a ticket offered to an ended queue waits forever. Its
interruption handling was the same single `ensuring` as here, with the
body still on the caller's fiber, and it measured 84 lines against these
65 while adding two lifecycle cases (raced creation, ended queue) that the
chain does not have.

`refuseClaim` makes the claim conditional: it reads the lane's current
occupant in the same synchronous step that would install the caller's own
tail, so nothing can claim the lane between the decision and the claim.
Returning a value refuses with it and leaves the lane exactly as it was
found; returning `undefined` claims as usual.

```ts
function withPerKeyLane<Key, RefusalE = never>(
  lanes: PerKeyLanes<Key>,
  key: Key,
  refuseClaim?: (occupant: PerKeyLane | undefined) => RefusalE | undefined,
): <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | RefusalE, R>
```

## withProcessServices

`effect` over this runtime's services (a {@link ProcessRuntime}'s, or a
host runtime's that serves more), as a program rather than a run: a
composition root hands the process services to a program it must give away
— a shutdown handler, a host callback typed as an Effect — without
stepping through a Promise to get them. The services are the runtime's own
context, built once and cached there, so this is the same provision
`runPromise` would have made, minus the boundary.

```ts
function withProcessServices<A, E, R = ProcessServices | Sessions>(
  // Not named `runtime`: the migration ratchet pins this file's one approved
  // `runtime` binding to `withForkFailureReporting`'s parameter.
  processRuntime: ManagedRuntime.ManagedRuntime<R, never>,
  effect: Effect.Effect<A, E, NoInfer<R>>,
): Effect.Effect<A, E>
```

## withSessionFs

Run `program` over the rooted filesystems of `roots` — the form a host
boundary uses, so a file that only settles a housekeeping program does not
have to name `Effect` as a value to provide a layer.

```ts
function withSessionFs<A, E, R>(
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  program: Effect.Effect<A, E, R | WorkspaceFs | StorageFs>,
): Effect.Effect<
  A,
  E,
  Exclude<R, WorkspaceFs | StorageFs> | FileSystem.FileSystem | Path.Path
>
```

## WorkspaceAgentsController

```ts
class WorkspaceAgentsController<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
>
```

## WorkspaceAgentsControllerDeps

```ts
interface WorkspaceAgentsControllerDeps<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  readonly repoState: StateStore;
  readonly globalState: StateStore;
  readonly getAgents: () => Entry[];
  /**
   * Resolve one stored identifier without collapsing exact source identity.
   * The controller applies no fallback around this, so an implementation owns
   * the whole contract: match a bare name against the deduplicated agents,
   * and a source-qualified key exactly. `AgentCatalog.get` is the production
   * implementation.
   */
  readonly resolveAgent: (identifier: string) => Entry | undefined;
}
```

## WorkspaceAgentsEntry

```ts
interface WorkspaceAgentsEntry {
  readonly name: string;
  readonly source: AgentSource;
}
```

## WorkspaceAgentsStores

The two state slots a workspace's agent list resolves against: the
repository's selection and the cross-workspace defaults. Every read is
answered for the workspace whose slots the caller hands over, so a process
holding several sessions never answers one paper's question with another's
agent list.

```ts
type WorkspaceAgentsStores = Pick<
  WorkspaceRoots,
  'repoState' | 'globalState'
>;
```

## workspaceEnvironmentLayer

A project's environment, read from `workspace`'s `.env` each time the
layer builds (as each run launches, so an edited or rotated key reaches
the next run) with Node's own reader, and served over this process's:
as Effect's `ConfigProvider` (credentials, flags) and as
`ProjectEnvironment` (what children start from). The project's file wins,
as the more specific scope. No `.env` reads as none; one that cannot be
read is a defect, so no work starts without the keys it would lack.

```ts
const workspaceEnvironmentLayer: (workspace: string | undefined) => Layer<never, never, never>
```

## WorkspaceFs

The workspace folder the session works on.

```ts
class WorkspaceFs extends Context.Service<
  WorkspaceFs,
  RootedFileSystem
>()('@texra-ai/harness/platform/WorkspaceFs')
```
