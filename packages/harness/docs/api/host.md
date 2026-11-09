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

## activationView

`Run.view` of `runId`'s activation at `activation`, for every reader of
it: the levels from the first that holds the activation, the run and its
transcript, to the first that holds the activation's durable outcome, or
shows the run gone. The transcript tier folds only for subscribed
aggregates: while the view is read, on a subscription of its own, the run and its
descendants are subscribed, taken before the first level is, so even an
ended run's one level holds its transcript; descendants join as the view
gains them.

```ts
function activationView(
  source: ActivationViewSource,
  runId: RunId,
  activation: CommitOrdinal,
): Stream.Stream<SessionView>
```

## ActivationViewSource

What an activation's view is read over: a session view's levels, and
the subscription its reader keeps the run's transcripts on, for the
reader's scope. A session handle's own view, or a window's view of a
session elsewhere.

```ts
interface ActivationViewSource {
  readonly current: () => SessionView;
  readonly changes: Stream.Stream<SessionView>;
  readonly subscribe: (
    set: readonly TranscriptSubscription[],
  ) => Effect.Effect<TranscriptInterest, never, Scope.Scope>;
}
```

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
   *  `WorkspaceAgents.forLaunch` loads it first, so an agent saved a moment ago launches as
   *  saved. */
  readonly invalidate: Effect.Effect<void>;
  /**
   * A delegation scope's pinned agents, deduplicated by key: the list a
   * scoped delegating agent is told and its calls resolve against, in place
   * of its workspace's visible agents. Reads no store.
   */
  readonly pinned: (scope: AgentDelegationScope) => AgentEntry[];
  /** One workspace's agents over this catalog, its stores captured. */
  readonly workspaceAgents: (stores: WorkspaceAgentsStores) => WorkspaceAgents;
  /** Change a custom copy of `entry` (see {@link AgentCustomization}):
   *  the copy's path, and the files the agent binds that were already
   *  beside it and kept although they differ from the bundled ones. */
  readonly customize: (
    entry: AgentEntry,
    change: AgentCustomization,
  ) => Effect.Effect<
    { readonly path: string; readonly keptDiffering: readonly string[] },
    | AgentCustomizeRefused
    | AgentDirectoriesFailed
    | StateReadFailed
    | PlatformError.PlatformError
  >;
}
```

## AgentCustomization

A change to a custom copy of a bundled agent: `copy` writes a new one
into the custom directory, with the files its blocks bind beside it, stamped with the bundled file's digest
(`basedOn`), and is refused when one is there; `overwrite` replaces it;
`keep` re-stamps the user's copy with the changed bundled version, which
dismisses its newer-version notice and touches nothing else.

```ts
type AgentCustomization = 'copy' | 'overwrite' | 'keep';
```

## AgentCustomizeRefused

`customize` refused the change: the entry has no file of its own to copy
(`noFile`), its copy would land outside the custom directory or a file it
binds lies outside its own directory (`escapes`), a copy is already there (`exists`, at `path`), or a copy has no newer
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
A root holds its port before it installs the runtime that serves it, so the
layer is `Layer.succeed(AgentDirectories)(port)`.

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
read itself, for the same reason `StateWriteFailed` exists: the reads
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
   * The member names of the workspace's team `teamId`, read from its
   * repository state; `undefined` for a team the workspace has none of. The
   * app owns what a team is; the harness only stores a selection naming one
   * by id. Absent, the app has no teams.
   */
  readonly teamMembers?: (
    repoState: StateStore,
    teamId: string,
  ) => Effect.Effect<readonly string[] | undefined, StateReadFailed>;
  /**
   * The packaged resources root a host ships its bundled agents under,
   * the tool plugins' agent directories among them. Absent where none ships:
   * an embedder's own directories.
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
  /**
   * Packaged resources root holding the bundled agent directories. Hosts read
   * their built-in agents straight out of the bundle they shipped with, so one
   * host's install can never overwrite another's built-ins.
   */
  resourcesPath: string;
  /** Where the configured custom agent directory is read from. */
  state: Pick<StateStore, 'get'>;
  /** The app's team membership read (`AgentDirectoriesPort.teamMembers`). */
  teamMembers?: AgentDirectoriesPort['teamMembers'];
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
  /** Digest of the definition file and the files its blocks bind; absent
   *  on a plugin agent. */
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

A runtime failure of the agent layer: a run that ended failed, a launch
that could not be built, or a model call that failed as its rows record it.

Host-neutral, so any host can reference it.
A more specific error should be added only when a concrete thrower and
catcher exist for it — anything else duplicates the existing
`ModelFailure` verdict.

```ts
class AgentError extends Schema.TaggedError<AgentError>()('AgentError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
  /** A model failure as the run's rows record it (the run ended on it, or a
   *  helper call raised it), which a host reads in place of this message's
   *  words. */
  failure: Schema.optional(ModelFailureSchema),
})
```

## AgentNotFound

No agent answers to `agent` in the settled catalog, rescanned once:
the catalog's own answer, which a launch turns into its refusal
({@link missingAgentRefusal}) and every other reader reads as "not found".

```ts
class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  'AgentNotFound',
  { agent: Schema.String, message: Schema.String },
)
```

## AgentRuntimeEmitOptions

```ts
interface AgentRuntimeEmitOptions {
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

## AppSignal

The name of one app signal.

```ts
type AppSignal = keyof AppSignalPayloads;
```

## AppSignalEvent

One published signal. The key and its payload are correlated by `emit`
and the subscriptions below, which is where a caller proves the pair; on the
hub they travel as what every subscription reads, a key and one of the
declared payloads.

```ts
interface AppSignalEvent {
  readonly signal: AppSignal;
  readonly payload: AppSignalPayloads[AppSignal];
}
```

## AppSignalPayloads

Cross-cutting, process-scoped app-lifecycle signals (subscriptions,
credentials, workspace-file writes). Not for run/session progress
events — those extend `AgentEvent` (`agent/trace/`) or the `SessionRow`
schema (`shared/schemas/sessionEvent.ts`), per the event-channel rule in
the harness AGENTS.md.

Delivery and error order, which this module owns and no caller may vary:

- Publishing (`emit`, `emitAppSignal`) enqueues and returns. It never runs
  a subscriber, so a subscriber can neither block nor fail the code that
  emitted.
- Each subscriber drains its own `PubSub` subscription on its own fiber,
  forked at the host's run edge (the fork lives at the host entry, not
  in the bus, since only a host runs Effects). One subscriber sees the
  signals it subscribed to in publication order; there is no order *between* subscribers, and a slow
  one holds up neither the publisher nor another subscriber.
- A subscriber that throws is logged at `warn` by its own delivery fiber
  and keeps its subscription: one broken listener never truncates a
  delivery. This is the one contract the `PubSub` conversion changed — the
  `EventEmitter` this replaces ran every listener on the emitter's stack
  and then rethrew the first listener's error into `emit`, so a settings
  view that failed to repaint could fail the tool call that wrote the
  file. Nothing depended on that throw; every caller emitted as a
  statement.
- A subscriber is live once its forked fiber has reached the `subscribe`
  below, which is a later scheduler turn than the `runFork` at the host's
  run edge: `runFork` schedules the fiber and returns, it does not run it.
  So a signal published in the same synchronous turn that subscribed
  reaches nobody — the ordinary `PubSub` rule that a subscription only
  receives what is published after it exists, and the reason the suites
  here yield once before they publish. A caller that must be subscribed
  before it continues calls {@link subscribeAppSignal} in its own scope
  instead.

Every signal below records which hosts consume it and — where a host does
not — why not. A signal with no such note is the ambiguous middle this file
exists to prevent: a host that silently never reacts is indistinguishable
from a host that deliberately doesn't. Keep the note truthful when you add a
subscriber; "no equivalent surface" is a valid, and common, answer.

```ts
interface AppSignalPayloads {
  /**
   * GitHub rejected the configured token. Frontends can surface the failure
   * and direct the user to token settings.
   *
   * Consumed by: extension (modal error + jump to Git settings), desktop
   * (an error dialog). Not the CLI: a
   * poller rejection arrives with no chat turn to attach it to, and the TUI
   * has no out-of-band notice surface — the rejection is logged instead.
   */
  githubTokenInvalid: { message: string };

  /**
   * A write or removal of one secret-store entry settled. Emitted by the
   * store itself, so every writer is covered — the settings controllers, the
   * setup agent's `unset_api_key`, the GitHub token forms — without any of
   * them remembering to. The one file store emits from its own commit
   * finalizer, and the process's watch of the directory (`FileSecrets.watch`,
   * started once by the app's process layer) emits for writes from other
   * processes. The finalizer runs on every exit of the write, failure and
   * interruption included, because an interrupted commit may still have
   * landed; the signal means "re-read this key", never "the value changed".
   * The same stores hold OAuth tokens and other credentials, so a subscriber filters on `key` and ignores the rest: an
   * OAuth refresh must not repaint the profile tab.
   *
   * Consumed by: extension and desktop (an `apiKey.*` change repaints the
   * credential-dependent settings, launcher and model surfaces), the CLI chat
   * TUI (an `apiKey.*` change re-reads the model route and quota its status
   * bar shows), and the `ToolAvailability` process service on every
   * host and the agent package (a key a plugin lists in `reprobeOnSecrets`,
   * such as the GitHub token, re-probes each workspace it holds, which the
   * next step's tool list reads).
   */
  credentialChanged: { key: string };

  /**
   * A model-access preference was written in this process: a subscription's
   * preference, the access route picked for a provider, a subscription
   * sign-out, or a setting whose write re-routes models
   * (`onWrite.invalidatesModelOptions`). Keyless on purpose: a listener
   * re-reads the routes it shows.
   *
   * Emitted by the CLI's writers of those settings. Consumed by: the CLI chat
   * TUI's status bar, which re-reads the route and quota it shows. Not the
   * extension or desktop: their settings views repaint model options in the
   * write's own round-trip (`settingsViewBody.ts`).
   */
  modelAccessChanged: undefined;

  /**
   * The active GitHub subscriptions (PR, repo, or issue) or their stream owners
   * changed. Keyless on purpose: every listener re-reads the full subscription
   * list, so which kind changed carries no information.
   *
   * Consumed by: extension and desktop settings views, both re-reading the
   * full subscription list for their Git tab. Not the CLI: it lists
   * subscriptions on demand from a slash command and has no persistent panel
   * that could go stale.
   */
  githubSubscriptionsChanged: undefined;

  /**
   * The workspace agents changed outside a settings round-trip. Keyless
   * on purpose: every listener re-reads the agent list, so which team or agent
   * moved carries no information.
   *
   * Emitted, in every process sharing the global store, when the default
   * team changes (`apply_team`, which the setup agent runs mid-conversation,
   * even in a background service task), and when the agent catalog is
   * reloaded after a tool switch, a plugin install or an agent file's edit:
   * `agentCatalogFollower` emits both, in this process or another. A team
   * change from the settings view emits too, through the same follower.
   *
   * Consumed by: extension and desktop settings views, both re-reading the
   * agent list and team presets, and the extension's launcher. Not the CLI:
   * it reads the agent list per command
   * and has no persistent panel that could go stale.
   */
  workspaceAgentsChanged: undefined;

  /**
   * The approval policy was written from a settings view (the shared
   * settings commands' `updateStateSetting`).
   *
   * Consumed by: the extension's status-bar tooltip, painted outside the
   * settings webview's round-trip. The settings views repaint their own
   * approval snapshot inline, and the CLI repaints its session line from the
   * `/config` form and `/approval` directly. Enforcement reads the config
   * live, so this signal only repaints.
   */
  approvalPolicyChanged: undefined;

  /**
   * One or more files were written directly to the workspace. Frontends can
   * badge or refresh those files without routing through a run-scoped channel.
   * A run's accepted files arrive as its `documents/accepted` fact, announced
   * in every process that folds the run (the arm's `writes`); a host's own
   * write (an accepted diff, the progress view's Accept) emits here directly.
   *
   * Consumed by: extension (VS Code's `FileDecorationProvider` badges the
   * written Explorer entries) and desktop (its file tree caches a directory
   * listing and has no filesystem watcher, so this is the only notice it gets
   * that a write landed behind its back). Not the CLI: it has no file tree or
   * decoration surface — accepted paths are printed into the transcript by the
   * tool row, which is built from the tool result and cannot go stale.
   */
  workspaceFilesWritten: { absolutePaths: string[] };
}
```

## appSignalStream

`signal`'s payloads, as a stream for a host to run where it holds the
lifetime: each run subscribes when it starts and unsubscribes when it
ends, so it reads what is published after it starts. A caller that must
know the subscription is live before it reads the state the signal
announces subscribes in its own scope first ({@link subscribeAppSignal}).

```ts
function appSignalStream<K extends AppSignal>(
  signal: K,
): Stream.Stream<AppSignalPayloads[K], never, AppSignals>
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

## AvailabilityResults

Each workspace root's last results (`undefined` = no folder open); a root
no probe has answered for yet is absent.

```ts
type AvailabilityResults = ReadonlyMap<
  string | undefined,
  readonly ExternalToolCheckResult[]
>;
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

## ConfigProvider

Platform configuration provider interface.

```ts
interface ConfigProvider {
  /**
   * Resolution order an implementation must honor: stored workspace value,
   * stored global value, then the setting catalog's own default
   * (`catalog.configDefault`); a key no row owns reads as `undefined` when
   * absent.
   *
   * It is synchronous, and it casts: the value it returns is whatever the
   * store holds. A reader that needs the value checked reads through
   * `Settings.get`, which safe-parses the stored value against the row's
   * schema; a hand-edited `"false"` in a
   * boolean row is a truthy string here and silently means the opposite.
   * Nothing may cache what either read returns: a setting the user changes
   * mid-process is read on the next call.
   *
   * Keys are relative to `catalog.namespace` (`memory.enabled`), which the
   * provider adds to every key it stores.
   */
  get<T>(key: string): T;
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

## countLineChanges

Added/removed line counts folded over hunks a caller already holds.

```ts
function countLineChanges(hunks: readonly Hunk[]): {
  added: number;
  removed: number;
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
  readonly get: <T>(
    family: ValueFamily<T>,
    key: string,
  ) => Effect.Effect<T | undefined, DatabaseReadFailed>;
  /**
   * Change one value from the one read under the write lock: `change`
   * answers with its result and the next value, with its result alone to
   * write nothing, or refuses and nothing is written. A next value of
   * `undefined` deletes the row.
   */
  readonly modify: <T, A, E = never>(
    family: ValueFamily<T>,
    key: string,
    change: (
      current: T | undefined,
    ) => Result.Result<readonly [A] | readonly [A, T | undefined], E>,
  ) => Effect.Effect<A, E | DatabaseWriteFailed>;
  /** Every row of a family, latest write first. */
  readonly list: <T>(
    family: ValueFamily<T>,
  ) => Effect.Effect<
    readonly { readonly key: string; readonly value: T }[],
    DatabaseReadFailed
  >;
  /**
   * Emits as subscribed, then after each value write, by this process or
   * (on the global store) another, that changed one of `keys`' values. A
   * read that fails is logged and retried, so no change is missed.
   */
  readonly changes: (
    family: Pick<ValueFamily<unknown>, 'name'>,
    keys: readonly string[],
  ) => Stream.Stream<void>;
}
```

## CUSTOM_AGENT_DIR_KEY

The custom agent directory the user configured, trimmed; empty when none is
(the host then uses its default directory).

```ts
const CUSTOM_AGENT_DIR_KEY: { readonly key: "customAgentDir"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Trim, never>; }
```

## DatabaseWriteFailed

A batch was rejected whole: no member or sequence moved.

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

## EventsRead

A read of committed events.

```ts
type EventsRead = Effect.Effect<
  readonly SessionRow[],
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
const ExportNodeSchema: Union<readonly [Struct<{ readonly kind: Literal<"user-message">; readonly parts: $Array<Union<readonly [Struct<{ readonly type: Literal<"text">; readonly text: String; }>, Struct<{ readonly type: Literal<"attachment">; readonly attachmentType: Literals<readonly ["image", "document"]>; }>]>>; }>, Struct<{ readonly kind: Literal<"assistant-text">; readonly text: String; }>, Struct<{ readonly kind: Literal<"thinking">; readonly text: String; }>, Struct<{ readonly kind: Literal<"tool-call">; readonly name: String; readonly input: Unknown; }>, Struct<{ readonly kind: Literal<"tool-result">; readonly text: String; readonly value: optional<Codec<Json, Json, never, never>>; }>, Struct<{ readonly kind: Literal<"web-search">; readonly query: String; }>]>
```

## ExternalToolCheckResult

Result of running a single external tool check.

```ts
interface ExternalToolCheckResult {
  readonly id: string;
  readonly tools: readonly string[];
  readonly status: ToolDependencyStatus;
  /** Short status label for the dashboard badge, when the default is too generic. */
  readonly statusLabel?: string;
  /** Human-readable explanation from the plugin's check, if any. */
  readonly statusDetail?: string;
}
```

## followPendingRequests

Run `program` once for each request `select` picks from the session's
view, for as long as the view lists it. A program that returns runs again
on the next view that still lists its request; one that holds something
for its request (a decision on record, a preview, a staged card) ends with
`Effect.never` and releases it in a finalizer, which runs once the view
drops the request, however it was decided.

```ts
const followPendingRequests: <P extends PendingRequest, R>(view: { readonly changes: Stream<{ readonly key: string; readonly runs: ReadonlyMap<string & Brand<"RunId">, { readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly facts: { readonly [x: string & Brand<"FactName">]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly approval: "own" | "descendant" | "none"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "earlierBuild" | "damaged"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly parentId: (string & Brand<"RunId">) | null; readonly launch: { readonly id: string & Brand<"RunId">; readonly card: string | null; } | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly sectionCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | "model" | "requestId" | "provider" | "operation" | "statusCode" | "statusText" | "rawMessage"; readonly value: string; }[]; readonly failure?: { readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly message: string; readonly source: "model"; readonly status?: number | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; readonly provider?: string | undefined; } | { readonly message: string; readonly source: "route"; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; } | { readonly source: "interrupted"; readonly provider?: string | undefined; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: "in_progress" | "completed" | "failed"; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly section?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly source?: string | undefined; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly stages: readonly { readonly id: string; readonly name: string; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly seqNo: number; readonly startTime: number; readonly endTime?: number | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }>; readonly order: readonly (string & Brand<"RunId">)[]; readonly cursor: number; readonly debug: boolean; readonly transcriptSeq: ReadonlyMap<string & Brand<"AggregateId">, number>; readonly rollup: { readonly running: number; readonly waiting: number; readonly interrupted: number; }; readonly requests: readonly { readonly runId: string & Brand<"RunId">; readonly requestId: string; readonly payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly offersGrant: boolean; readonly runId: string & Brand<"RunId">; readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; readonly content: string; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly operation: string; readonly failure: { readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly message: string; readonly source: "model"; readonly status?: number | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; readonly provider?: string | undefined; } | { readonly message: string; readonly source: "route"; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; } | { readonly source: "interrupted"; readonly provider?: string | undefined; }; readonly runId: string & Brand<"RunId">; readonly model?: string | undefined; readonly credentialSwitch?: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; readonly automatic: boolean; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly options?: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; } | { readonly kind: "plugin"; readonly plugin: string; readonly blocksCaller: boolean; readonly answers: readonly ("retry" | "approve" | "approve_and_goal" | "submit" | "answer" | "skip")[]; readonly data: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; readonly requestId: string; readonly runId: string & Brand<"RunId">; }; }; }[]; readonly policy: ReadonlyMap<string & Brand<"RunId">, { readonly own: { readonly bash?: "parent" | "on" | "off" | undefined; readonly toolEdit?: "parent" | "on" | "off" | undefined; readonly superYolo?: "parent" | "on" | "off" | undefined; }; readonly goal: readonly ("bash" | "toolEdit" | "superYolo")[]; readonly limit?: "never" | "ask" | undefined; }>; readonly pluginFacts: readonly { readonly kind: string; readonly parent: (string & Brand<"RunId">) | null; readonly plugin: string; readonly type: "plugin.fact"; readonly aggregateId: string & Brand<"AggregateId">; readonly version: number; readonly value: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; readonly stageId?: string | undefined; }[]; readonly queuedFollowUps: ReadonlyMap<string & Brand<"RunId">, readonly { readonly followUpId: string; readonly text: string; }[]>; }, never, never>; }, select: (view: { readonly key: string; readonly runs: ReadonlyMap<string & Brand<"RunId">, { readonly title: string; readonly worktree: { readonly workingDirectory: string; } | null; readonly id: string & Brand<"RunId">; readonly description: string | null; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly takesFollowUps: boolean; readonly model: string | null; readonly inputFiles: readonly string[]; readonly label: string; readonly recipe: string | null; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly turn: number | null; readonly command: string | null; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly facts: { readonly [x: string & Brand<"FactName">]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly position: "waiting" | "ready" | "running"; readonly approval: "own" | "descendant" | "none"; readonly descriptionBy: "model" | "user" | null; readonly modelLabel: string | null; readonly holder: "here" | "none"; readonly statusNotice: { readonly kind: "earlierBuild" | "damaged"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly turnStartedAt: number | null; readonly runStartedAt: number | null; readonly parentId: (string & Brand<"RunId">) | null; readonly launch: { readonly id: string & Brand<"RunId">; readonly card: string | null; } | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; }; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly latestLine: string | null; readonly createdAt: number; readonly launchedAt: number; readonly lastTimestamp: number; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "scratchpad" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly pendingEmbeddedFollowup?: boolean | undefined; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly sectionCount: number; readonly tally: { readonly total: number; readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments?: readonly ("image" | "document")[] | undefined; readonly media?: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[] | undefined; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | "model" | "requestId" | "provider" | "operation" | "statusCode" | "statusText" | "rawMessage"; readonly value: string; }[]; readonly failure?: { readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly message: string; readonly source: "model"; readonly status?: number | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; readonly provider?: string | undefined; } | { readonly message: string; readonly source: "route"; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; } | { readonly source: "interrupted"; readonly provider?: string | undefined; } | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly toolUse: { readonly toolName: string; readonly errorText: string; readonly outputText: string; readonly exitCode?: number | undefined; readonly userInstructionText: string; readonly input: unknown; readonly isUserFeedback: boolean; readonly headerSummary: string; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; }; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: "in_progress" | "completed" | "failed"; readonly label: string; })[]; readonly output?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showOutput: boolean; readonly outputSuppression?: ToolOutputSuppression | undefined; readonly showsNoOutputMarker: boolean; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly isError: boolean; readonly isUserFeedback: boolean; readonly isInProgress: boolean; readonly exitCode?: number | undefined; }; readonly log: { readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly toolName?: string | undefined; readonly input?: unknown; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; }; readonly section?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly source?: string | undefined; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly media: readonly { readonly path: string; readonly media: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; }; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; } | { readonly action: "compaction" | "clear_tool_uses" | "clear_thinking" | "truncation"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly tokensAfter: number; readonly utilizationAfter: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly quotaFallback?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | undefined; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly settledThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly finishedAt?: number | undefined; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; }; readonly label: string; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo?: number | undefined; readonly settlementSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "toolUse" | "thinking" | "scratchpad" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "quotaFallback" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly stages: readonly { readonly id: string; readonly name: string; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly seqNo: number; readonly startTime: number; readonly endTime?: number | undefined; }[]; readonly settledRows: number; }; readonly agentScope?: readonly string[] | null | undefined; }>; readonly order: readonly (string & Brand<"RunId">)[]; readonly cursor: number; readonly debug: boolean; readonly transcriptSeq: ReadonlyMap<string & Brand<"AggregateId">, number>; readonly rollup: { readonly running: number; readonly waiting: number; readonly interrupted: number; }; readonly requests: readonly { readonly runId: string & Brand<"RunId">; readonly requestId: string; readonly payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly offersGrant: boolean; readonly runId: string & Brand<"RunId">; readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; readonly content: string; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly operation: string; readonly failure: { readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly message: string; readonly source: "model"; readonly status?: number | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; readonly provider?: string | undefined; } | { readonly message: string; readonly source: "route"; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; } | { readonly source: "interrupted"; readonly provider?: string | undefined; }; readonly runId: string & Brand<"RunId">; readonly model?: string | undefined; readonly credentialSwitch?: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; readonly automatic: boolean; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly options?: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly offersGrant: boolean; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; } | { readonly kind: "plugin"; readonly plugin: string; readonly blocksCaller: boolean; readonly answers: readonly ("retry" | "approve" | "approve_and_goal" | "submit" | "answer" | "skip")[]; readonly data: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; readonly requestId: string; readonly runId: string & Brand<"RunId">; }; }; }[]; readonly policy: ReadonlyMap<string & Brand<"RunId">, { readonly own: { readonly bash?: "parent" | "on" | "off" | undefined; readonly toolEdit?: "parent" | "on" | "off" | undefined; readonly superYolo?: "parent" | "on" | "off" | undefined; }; readonly goal: readonly ("bash" | "toolEdit" | "superYolo")[]; readonly limit?: "never" | "ask" | undefined; }>; readonly pluginFacts: readonly { readonly kind: string; readonly parent: (string & Brand<"RunId">) | null; readonly plugin: string; readonly type: "plugin.fact"; readonly aggregateId: string & Brand<"AggregateId">; readonly version: number; readonly value: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; readonly stageId?: string | undefined; }[]; readonly queuedFollowUps: ReadonlyMap<string & Brand<"RunId">, readonly { readonly followUpId: string; readonly text: string; }[]>; }) => readonly P[], program: (request: P) => Effect<void, never, R>) => Effect<void, never, Scope | R>
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

## getEnabledModels

The models the pickers show — the single reader of
{@link MODEL_SELECTION_KEY} for every host.

```ts
const getEnabledModels: (state: Pick<StateStore, "get">) => Effect<readonly string[], StateReadFailed, never>
```

## getHelperModelName

The helper model a run, a merge, or the Models tab uses: the configured
choice while it is enabled, else the catalog's default for the setting;
`undefined` when neither names one, and a run's helper calls use its own
model. The harness names no default: an app's catalog supplies its own
(`settingsCatalog`'s `defaults`). That default is always accepted because it
serves internal auxiliary tasks, not user-facing generation; a disabled
choice falls back to it, never to the first picker model, which is a
premium default.

The one resolution of the chain: every surface that shows or uses the
helper model reads it here, from the setting slots the caller holds.

```ts
const getHelperModelName: (stores: SettingsStores) => Effect<string | undefined, StateReadFailed, never>
```

## getPathSegments

Get path segments as an array.
Only converts backslashes — does NOT resolve '..' so callers can detect
traversal attempts (e.g. AcceptRunFilesTool's `includes('..')` guard).
It also trims its input, so a caller that must keep a leading or trailing
space in a name (hidden-file and excluded-directory checks, published
artifact paths) cannot route through it; those call sites split on their
own, and each handles `..` its own way on purpose.

```ts
function getPathSegments(input: string): string[]
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

## hasExtension

Check if a file path has a specific extension (case-insensitive).
Consolidates scattered `.toLowerCase().endsWith('.ext')` patterns.

- `@example` hasExtension('notes.md', '.md') // true
  hasExtension('Notes.MD', '.md') // true
  hasExtension('notes.pdf', '.md') // false

```ts
function hasExtension(filePath: string, extension: string): boolean
```

## helperCall

One helper call: bind the configured helper model (else `runModel`) for
this call alone and run one completion off the rows (`run/modelCall.ts`),
gated on the process's retry gate, priced and reported to the usage log
as `attribution`. No row is written. Returns the
turn's assistant text and its priced usage (`null`: the provider reported
none), for a caller whose row records what the call cost. `stores` are the
asking session's setting slots: the binding, the retry limit and the usage
consent read them, beside the process `Secrets` and its subscription
accounts.

```ts
const helperCall: (stores: SettingsStores, args_1: HelperPrompt, attribution: UsageAttribution, args_3?: { readonly retries?: number | undefined; readonly runModel?: string | undefined; } | undefined) => Effect<{ readonly text: string; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly provider: string; readonly cost: number; readonly responseTimeMs: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; } | null; }, Error | CallFailure, HttpClient | Secrets | SubscriptionAccounts | UsageLog | RouteRetries>
```

## HelperPrompt

A single non-streaming helper-model text completion.

```ts
interface HelperPrompt {
  readonly userPrompt: string;
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

## HostSkillOptions

A process's skill sources (`ProcessLayerOptions.skills`,
`Composition.skills`): its bundled resources tree, under which each of its
tool plugins ships its bundled skills (`plugins/<id>/skills`), the folder
it keeps in each project, and its process-wide source options (the CLI's
flags). Discovery reads custom roots, project skills, user skills (the
storage root's `skills/`) and the bundled ones in that precedence. A
process given none discovers no skills at all.

```ts
interface HostSkillOptions {
  readonly resourcesPath: string;
  /**
   * The folder the host keeps in each project, relative to a session's
   * workspace (TeXRA's `.texra`): its `skills/` holds the project's own
   * skills. Absent, a project has no skills but those a custom root or an
   * interop listing reads.
   */
  readonly projectDataDirName?: string;
  readonly skillSourceOptions?: SkillSourceOptions;
}
```

## Hunk

A hunk as its readers see it: jsdiff's, or one carried as data.

```ts
type Hunk = Readonly<Omit<StructuredPatchHunk, 'lines'>> & {
  readonly lines: readonly string[];
};
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
const InstalledPlugins: Readonly<{ readonly unloadedComponents: readonly ("LSP servers" | "output styles" | "apps")[]; readonly origin: (input: string, cwd: string, ref: string | undefined) => Result<PluginOrigin, PluginRequestError>; readonly install: (origin: PluginOrigin, only: readonly string[], env: PluginEnv) => Effect<{ readonly name: string; readonly path: string; readonly source: string; readonly skills: readonly string[]; readonly enabled: boolean; readonly description?: string | undefined; readonly commit?: string | undefined; readonly version?: string | undefined; readonly ref?: string | undefined; readonly trust?: { readonly version: string | null; readonly digest: string; } | undefined; }[], Error, FileSystem | ChildProcessSpawner>; readonly update: (names: readonly string[], env: PluginEnv) => Effect<PluginUpdate[], PluginError | PluginRequestError, FileSystem | ChildProcessSpawner>; readonly remove: (name: string, env: PluginEnv) => Effect<{ name: string; path: string; local: boolean; leftover: boolean; }, PluginError | PluginRequestError, FileSystem>; readonly list: (env: PluginEnv) => Effect<PluginListing[], PluginError, FileSystem>; readonly enable: <E, R>(name: string, env: PluginEnv, confirm: (review: PluginReview) => Effect<boolean, E, R>) => Effect<"enabled" | "declined", PluginError | PluginRequestError | E, FileSystem | R>; readonly disable: (name: string, env: PluginEnv) => Effect<undefined, PluginError | PluginRequestError, never>; readonly loaded: (env: Pick<PluginEnv, "globalState">) => Effect<{ readonly name: string; readonly path: string; readonly source: string; readonly skills: readonly string[]; readonly enabled: boolean; readonly description?: string | undefined; readonly commit?: string | undefined; readonly version?: string | undefined; readonly ref?: string | undefined; readonly trust?: { readonly version: string | null; readonly digest: string; } | undefined; }[], never, FileSystem>; readonly describeHook: (hook: ConfiguredHook) => Effect<string, never, never>; }>
```

## InvalidAgentTeamError

```ts
class InvalidAgentTeamError extends Schema.TaggedError<InvalidAgentTeamError>()(
  'InvalidAgentTeamError',
  { message: Schema.String },
)
```

## isModuleNotFoundError

Check if an error is "dynamic import couldn't find the module" (Node + ESM variants).

```ts
function isModuleNotFoundError(err: unknown): boolean
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

## MODEL_SELECTION_KEY

The model selection's key. Its absence is the empty delta, read here
rather than by a decoding default, so a corrupt record is reported.

```ts
const MODEL_SELECTION_KEY: { readonly key: "modelSelection"; readonly slot: "globalState"; readonly schema: Struct<{ readonly enabledExtras: $Array<String>; readonly disabledDefaults: $Array<String>; }>; }
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
      readonly usageRoute?: DeclinableUsageRoute;
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

## normalizeProviderError

A failure as a host reads it: its plain words, with the model call's
verdict and the vendor's raw body when a model call failed.

```ts
function normalizeProviderError(err: unknown): ProviderError
```

## Notices

What shows a notice: a session's {@link Interactions}, or a window's own
host ({@link presenterOn}).

```ts
interface Notices {
  emit<K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
    options?: AgentRuntimeEmitOptions,
  ): Effect.Effect<void>;
}
```

## OFFICE_EXTENSIONS

File extensions for binary office document formats (case-insensitive, with leading dot).

```ts
const OFFICE_EXTENSIONS: readonly string[]
```

## onAppSignal

Deliver `signal` to `listener` until the caller interrupts. The program a
host's run edge forks: its scope holds the subscription, so interrupting
the fiber unsubscribes, and the `warn` on a failing listener is this
module's, not the host's.

```ts
function onAppSignal<K extends AppSignal>(
  signal: K,
  listener: (payload: AppSignalPayloads[K]) => void,
): Effect.Effect<void, never, AppSignals>
```

## ownKeyCredential

The user's own key for `config` and the endpoint they set for its
provider, for a request llm does not model (audio transcription): the
route `config` takes with every preference off.

```ts
const ownKeyCredential: (stores: SettingsStores, config: ModelConfig) => Effect<{ readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } & { readonly route: "api-key"; readonly bearer: string; } & { readonly endpoint: string; }, RouteUnavailable, Secrets>
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

## PlatformServices

The platform- and shared-owned services every process serves, merged once
in `processLayer`'s `services` layer: the host ports (the secret store with
the subscription accounts over it), the language-model bridge and the HTTP
client, plus the standard library's `FileSystem`,
`Path` and `ChildProcessSpawner`, which the same install provides from
`@effect/platform-node` so a program that reads a file or starts a child
process takes them from context instead of building a Node layer of its
own, and `GlobalStorageFs`, the cross-workspace storage view every session
of the process shares, `GlobalDatabase`, that same root's one database
handle, which the app's records and the CLI's input history read through,
and `AppSignals`, the process's app-lifecycle signal hub. Every run and
session of the process is provided these, beneath the run-level services
the agent runtime adds (`RunServices`) and the `ProcessServices` a
composition root runs on. The project stores (`ProjectDatabases`) and the
identity stamped on every row (`ProcessIdentity`) are not among them: only
the session composition and its stores read them.

```ts
type PlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | GlobalStorageFs
  | GlobalDatabase
  | HttpClient.HttpClient
  | Secrets
  | SubscriptionAccounts
  | AppState
  | AgentDirectories
  | GlobalValues
  | StateStores
  | UsageLog
  | AppSignals;
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

## presenterOn

Notices shown on one host that is not a session's: a window presenting
its own failures before a run opens.

```ts
function presenterOn(host: HostInteractions): Notices
```

## presentFollowUpResult

```ts
function presentFollowUpResult(
  result: SubmitFollowUpResult,
): { severity: 'none' } | { severity: 'warning'; message: string }
```

## presentRunFailure

Present a failed run from its raw error, replayed to a surface that
attaches later: a refused launch's notice (`LaunchRefused.notice`), or
else the primary failure as `prefix` plus its text (a `Rejected`
request's reason). With no prefix, a model failure is shown as its run
would record it, its verdict beside, which a host may word in its
place; a prefixed text says more than the failure, so it is shown as
written. A host that throws on the notice shows that text as an error
instead. It presents whatever it is given, so each failure has one
presenter: a launch that failed before its run opened is its caller's,
and a run's end is the session's ({@link presentTerminalResult}).

```ts
function presentRunFailure(
  interactions: Notices,
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

A plugin list the harness cannot compose (the defects `toolTable`
refuses: an id that is not lowercase letters, digits and dashes, an id or
tool name listed twice, a switch on a plugin with no availability probe,
a `requires` naming a plugin not listed, an agent-file block owned twice or keyed by a persona key,
two script modules of one name) fails the build with {@link PluginsRefused} before
anything is built, so the refusal names the plugin rather than failing
the first session open. A global store the process builds itself is
seeded with the first-install tool switches; a store handed in is left as
it is. Every root run is labelled with a short title from the helper model
(its `run.description`): an extra model request per root run, counted in
the run's usage, which every host's run list shows.

```ts
function processLayer(
  options: ProcessLayerOptions,
): Layer.Layer<ProcessServices | Sessions, PluginsRefused>
```

## ProcessLayerOptions

What a composition root composes its process from: the services' options
and its skill sources.

```ts
interface ProcessLayerOptions extends Omit<
  ProcessServicesOptions,
  'appState'
> {
  /** The host's skill sources; absent, the process discovers no skills. */
  readonly skills?: HostSkillOptions;
  /** The global store; absent, the one under the process's global storage
   *  root. */
  readonly appState?: ProcessServicesOptions['appState'];
}
```

## ProcessRuntime

The runtime a composition root makes over `processLayer`: the process
services, and the `Sessions` that open and close its sessions. Its build
cannot fail, so the root has already decided what a `PluginsRefused`
means (a host with a fixed list, `Layer.orDie`).

```ts
type ProcessRuntime = ManagedRuntime.ManagedRuntime<
  ProcessServices | Sessions,
  never
>;
```

## ProcessServices

The process services a composition root runs on, the public name every
host writes against: what a run's program requires of the process
({@link RunServices}) and `ToolCatalog`, the tool catalog each session's
steps pin their tools in. Every run and session of the process is provided
these; the {@link Sessions} above them is the composition root's alone
({@link ProcessRuntime}).

```ts
type ProcessServices = RunServices | ToolCatalog;
```

## ProcessServicesOptions

What the process services are composed from: the app's plugins and the
host's own ports; what every host builds the same way (the process
identity, the global root's database) has a default.

```ts
interface ProcessServicesOptions {
  /** The storage root this process opened (`WorkspaceRoots.storageRoot`). */
  readonly storageRoot: string;
  /** The config's catalog: the state stores key rows under its namespace. */
  readonly settings: SettingsCatalog;
  /**
   * The app's plugins, in order, `harnessBuiltins` among them (the harness
   * names no plugin of its own): the process serves them as `ToolRegistry`
   * and the tool catalog over it (`ToolCatalog`).
   */
  readonly plugins: readonly Plugin[];
  /** The process's store and the subscription accounts over it
   *  (`Secrets.layer`, `Secrets.announcing`). */
  readonly secrets: Layer.Layer<
    Secrets | SubscriptionAccounts,
    never,
    AppSignals
  >;
  /** The host's agent-directory layer: it may capture AppState as it is
   *  built, which its readers never see. */
  readonly agentDirectories: Layer.Layer<AgentDirectories, never, AppState>;
  /** The global application-state layer, acquired in this runtime's scope
   *  (`processLayer` picks the host's and seeds it). */
  readonly appState: Layer.Layer<AppState, DatabaseOpenFailed, GlobalDatabase>;
  /** The dependency probes every tool gate and Tools dashboard read. Hosts
   *  leave it absent; only the repository's test kernel passes one, which
   *  starts no probe, so a suite does not see what the machine installed. */
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
  /** The runtime's emission threshold for Effect diagnostics, from facts that
   *  cannot change mid-process: the surface (the extension's channel filters
   *  itself: `'Trace'`; the desktop's log file: `'Debug'`) or the CLI's
   *  `--quiet` / `--verbose`; no live setting changes it. Absent (an
   *  embedder), no logger, level or tracer is installed: its own decide. */
  readonly minimumLogLevel?: LogLevel.LogLevel;
  /** A single-project host's folder, whose `.env` its own reads see. */
  readonly workspace?: string;
}
```

## ProviderError

A failure as a host reads it: its plain words, the model call's verdict
when one failed, and the vendor's raw body, which stays in the process
log.

```ts
interface ProviderError {
  readonly message: string;
  readonly failure?: ModelFailure;
  readonly rawErrorBody?: unknown;
}
```

## readCustomAgentDir

{@link CUSTOM_AGENT_DIR_KEY}, read.

```ts
const readCustomAgentDir: (state: Pick<StateStore, "get">) => Effect<string, StateReadFailed, never>
```

## readMcpConfig

The config file's servers and the warnings its invalid entries raise, or
`null` when the file does not exist. An unreadable file, invalid JSON or a
wrong shape is one warning and no servers. The Plugins page lists them
read-only from here, and the CLI warns of a broken file at startup.

```ts
const readMcpConfig: (
  fs: FileSystem.FileSystem,
  file: string,
) => Effect.Effect<ReturnType<typeof parseMcpServers> | null>
```

## readModelOptions

Every visible model's option, in the order they are shown — the one read
behind every model picker, run-model check and prospective route. The
facts every model shares are read once, each model is routed once, then
one key status is read per provider the routes consult; each option is
finished purely over them, so the ~157-model settings pass costs no
per-model awaits. Each read fails with its own error: a settings or key
read as itself, a subscription session as its route (`RouteUnavailable`,
with whether it needs a sign-in). `models`, when given, is honored
verbatim, one option each, in order. Nothing is cached here: the sign-in
state is read live by design. `stores` are the caller's setting slots (a
session's `roots`); provider keys and sign-ins come from the process
{@link Secrets} service.

```ts
const readModelOptions: (stores: SettingsStores, models?: readonly string[] | undefined) => Effect<ModelOption[], StateReadFailed | SecretsFailed | RouteUnavailable, Secrets | SubscriptionAccounts>
```

## readStorageInventory

The orphaned stores and aside copies under `storageRoot`.

```ts
const readStorageInventory: (storageRoot: string) => Effect<{ orphans: { readonly directory: string; readonly bytes: number; readonly why: string; }[]; asides: { readonly path: string; readonly bytes: number; }[]; skipped: { readonly path: string; readonly message: string; }[]; }, DatabaseReadFailed | PlatformError, FileSystem | GlobalValues>
```

## REASONING_LEVELS_KEY

The user's saved reasoning effort per model reference. Its entries stay
unparsed in the record so a write keeps every entry, readable or not.

```ts
const REASONING_LEVELS_KEY: { readonly key: "reasoningLevels"; readonly slot: "globalState"; readonly schema: withDecodingDefault<$Record<String, Unknown>, never>; }
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

## replayTrace

A run's trace read back from its session's view inputs, for every reader
of `Run.events`: the rows of the reader's activation, then each as it
commits with the text streamed between them, until its `run.end` (or,
with none stored, every row committed when the run was over);
then `result`'s failure. A stream that ended before the reader came
arrives as one chunk of its final text, so a reader's chunks always add
up to each stream's final text.

```ts
function replayTrace<E>(
  session: {
    /** Ordered view inputs for one reader: a session handle's, or a
     *  `Session.view.watch` with its arguments spread. */
    readonly view: {
      readonly inputs: (
        set: readonly TranscriptSubscription[],
        fromCommit: CommitOrdinal,
        debug: boolean,
      ) => Stream.Stream<readonly SessionViewInput[]>;
    };
    /** `settled`: every write enqueued so far is committed; `now()`: the
     *  head. */
    readonly log: {
      readonly settled: Effect.Effect<void>;
      readonly now: () => CommitOrdinal;
    };
  },
  runId: RunId,
  /** A commit in the reader's activation: it reads the latest at or before. */
  activation: CommitOrdinal,
  result: Effect.Effect<unknown, E>,
): Stream.Stream<AgentEvent, E>
```

## reportDiffTimeout

Warn that a diff pass fell back to a whole-file replacement, if it did.

```ts
function reportDiffTimeout(
  timeout: string | undefined,
): Effect.Effect<void>
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
  /** Directory entries with the type of each, from one typed listing. */
  readonly readDirectoryTyped: (
    target: string,
  ) => Effect.Effect<
    ReadonlyArray<readonly [string, FileSystem.File.Type]>,
    PlatformError.PlatformError
  >;
}
```

## RouteCredential

The credential of one route. `bearer` is what the transport sends: a key,
or a session's token, which llm reads per request and renews once when
the provider rejects it.

```ts
type RouteCredential = {
  readonly provider: ApiKeyProviderId;
} & (
  | { readonly route: 'api-key'; readonly bearer: string }
  | { readonly route: 'xai-subscription'; readonly bearer: SessionToken }
  | {
      readonly route: 'chatgpt-subscription';
      readonly bearer: SessionToken;
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
A missing key is the one fact a host acts on (it offers the key
setting); any other failure is read as its message, which for a
subscription session is the session's own failure, recorded with its
route and remedy (`session`) on the run's `route` failure.

```ts
class RouteUnavailable extends Schema.TaggedError<RouteUnavailable>()(
  'RouteUnavailable',
  {
    /** The route's credential is not set anywhere the run reads. */
    missingApiKey: Schema.optional(Schema.Literal(true)),
    message: Schema.String,
    /** A signed-in subscription that could not bill the call: its route,
     *  and whether only a fresh sign-in can help (else it may recover). */
    session: Schema.optional(SubscriptionSessionFailureSchema),
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
}
```

## RunModelDecision

The model a run takes and why. `Fallback` runs another model than the one
its candidate named and carries the sentence that tells the person;
`Unavailable` names the candidate that cannot run and has nothing to fall
back to. A caller matches every case.

```ts
type RunModelDecision = Data.TaggedEnum<{
  Chosen: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
  };
  Fallback: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
    readonly from: {
      readonly model: string;
      readonly reason: RunModelDecisionReason;
    };
    readonly notice: string;
  };
  Unavailable: {
    readonly model: string;
    readonly reason: RunModelDecisionReason;
  };
}>;
```

## RunModelDecisionReason

```ts
type RunModelDecisionReason = keyof typeof RUN_MODEL_REASONS;
```

## RunServices

What a run's program requires of the process: the platform services every
process serves, the agent catalog, the plugin table its offered tools are
rebuilt from, each workspace's last dependency probe and the model routes'
retry gate. The composition's tool catalog (`ToolCatalog`) is not among
them: no run names it.

```ts
type RunServices =
  | PlatformServices
  | AgentCatalog
  | RouteRetries
  | ToolRegistry
  | ToolAvailability;
```

## RuntimePresentationEvent

```ts
type RuntimePresentationEvent = keyof RuntimePresentationEventPayloads;
```

## RuntimePresentationEventPayloads

The notices the runtime and an embedder's tools show a person through the
session's host, each named for what it says, never for a screen of one
application. They are not progress facts and are not stored. Hosts may
render them, ignore them, or route them to their own presentation channel
without changing the agent loop. Presentation is fire-and-forget: a host
that cannot render an event logs the cause itself.

```ts
interface RuntimePresentationEventPayloads {
  openFile: OpenFilePayload;
  requestShowInstruction: RequestShowInstructionPayload;
  agentNotFound: AgentNotFoundPayload;
  requestShowError: RequestShowErrorPayload;
}
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

## setModelEnabled

Enable or disable one model — the only writer of
{@link MODEL_SELECTION_KEY}.

Two invariants: at least one model stays enabled, and an unserved model is
never enabled. Either violation fails with `StateWriteFailed`.

```ts
function setModelEnabled(input: {
  readonly model: string;
  readonly enabled: boolean;
  readonly state: StateStore;
})
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
const Skills: Readonly<{ readonly interopDirs: readonly [".agents", ".claude", ".codex", ".gemini"]; readonly display: (roots: SkillRoots) => Effect<{ skills: { readonly name: string; readonly description: string; readonly scope: "custom" | "user" | "bundled" | "project" | "interop"; readonly label: string; readonly path: string; readonly sourcePath: string; readonly enabled: boolean; }[]; issues: { readonly message: string; readonly path?: string | undefined; }[]; }, Error, FileSystem>; readonly enabled: (roots: SkillRoots, options?: SkillSourceOptions | undefined) => Effect<{ skills: EnabledSkill[]; issues: SkillLoadIssue[]; }, Error, FileSystem>; }>
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

## ToolAvailability

```ts
class ToolAvailability extends Context.Service<
  ToolAvailability,
  {
    /** Each workspace root's last results; a dashboard follows its changes. */
    readonly results: SubscriptionRef.SubscriptionRef<AvailabilityResults>;
    /**
     * Probe every plugin for `inputs`' workspace and publish the results:
     * the round after the one in flight for that root reads `inputs` (or
     * newer ones another caller asked with), and every caller asking while
     * it waits shares it. Each plugin's probe has its own deadline and
     * reports a failure as `unknown`, so this never fails.
     */
    readonly refresh: (
      inputs: ToolProbeInputs,
    ) => Effect.Effect<readonly ExternalToolCheckResult[]>;
    /**
     * Keep `roots`' results for the caller's scope and probe them now,
     * without waiting: a session holds its roots for its life, and a refresh
     * holds its root while it waits. Only a held root's results are kept, and
     * a root's are dropped when its last holder closes, so the map is bounded
     * by the open sessions and the refreshes in flight.
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

## toPosixPath

Convert a path to POSIX style (forward slashes, collapsed separators, resolved `.` and `..`).

```ts
function toPosixPath(relativePath: string): string
```

## TraceRow

One session arm as the trace carries it, distributive over `T`: an
{@link AgentEvent} arm, or the `run.end` a {@link ResultEvent} names. A
row the run's state is folded from is never one: the trace is the
display door, and those rows commit through the run's cell
(`runEventDraft`, typed to an unfolded draft, refuses any other).

```ts
type TraceRow<T extends (typeof TRACE_ROW_TYPES)[number] | 'run.end'> =
  T extends unknown
    ? Omit<Extract<SessionRowDraft, { type: T }>, 'aggregateId'>
    : never;
```

## unifiedDiffText

Unified-diff body between two texts (`text` is undefined when they are
identical), with the pass's {@link DiffHunks.timeout} for the caller to
report.

Carries no `---`/`+++` file header: every consumer already names the file in
its own surrounding prose.

```ts
function unifiedDiffText(
  oldText: string,
  newText: string,
): { readonly text: string | undefined; readonly timeout: string | undefined }
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

## UsageLogEntrySchema

One entry of the usage log's wire, a body of the `log-usage-v2` edge
function. The sender checks each entry against it before queueing, so
nothing goes out that the edge would reject. Field names are the wire's,
not `NormalizedUsage`'s.

The edge decodes the same entry (`supabase/functions/log-usage-v2/usageBatch.ts`)
and the two must match: everything this schema accepts, that one accepts.
There the counts are non-negative ints, `listCost` a non-negative finite
number, `timestamp` a UTC ISO 8601 date-time and every string non-empty,
`provider` and `usageRoute` included.

```ts
const UsageLogEntrySchema: Struct<{ readonly timestamp: String; readonly model: String; readonly provider: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly agentName: optional<String>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly streamId: optional<String>; readonly inputTokens: Int; readonly outputTokens: Int; readonly listCost: Finite; readonly responseTimeMs: optional<Int>; readonly cachedInputTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly extensionVersion: optional<String>; readonly editorType: optional<String>; }>
```

## ValidationModel

The canned model a package-validation build provides beneath the process
layer, and whether a new run takes it. Absent, none does, and a run
recorded on the validation route fails to bind.

```ts
class ValidationModel extends Context.Service<
  ValidationModel,
  {
    readonly enabled: Effect.Effect<boolean>;
    readonly bind: (config: ModelConfig) => {
      readonly model: Model;
      readonly origin: ModelOrigin;
    };
  }
>()('@texra-ai/harness/ValidationModel')
```

## ValueFamily

One family of current values: its stored name and the schema its value
decodes with. A change that answers `undefined` deletes the row.

```ts
interface ValueFamily<T> {
  readonly name: string;
  readonly schema: Schema.Codec<T, unknown>;
}
```

## WithBlobs

A draft with the blobs it stores or links.

```ts
type WithBlobs<Draft> = Draft & {
  readonly blobs?: readonly DraftBlob[];
};
```

## withPerKeyLane

Run `self` on `key`'s lane, FIFO: each entrant claims the lane
synchronously when its effect starts by swapping its own `Deferred` in as
the tail, waits for its predecessor's, and hands off in `ensuring` once
`self` succeeds, fails, or is interrupted. The wait itself is
interruptible; a waiter interrupted before entering hands its successor
the wait for its own predecessor, so the successor still waits for whoever
actually holds the lane. A hand-off through a `Deferred` resumes the next
fiber directly, so fibers started in sequence enter in that order. The
lane is created on first use and deleted from `lanes` once the last fiber
holding or waiting on it settles.

A `Queue` of tickets served by one detached worker fiber (the shape
`sessionFrames.ts` uses) was prototyped against this chain in review and
not taken. FIFO came for free, but `Queue.make` is `withFiber`, so the
queue cannot be created in the synchronous claim step: the create path
had to re-check the map after `Queue.unbounded` and claim in the same
synchronous step as the insert, because a lane whose count drops to zero
ends its queue and a ticket offered to an ended queue waits forever. Its
interruption handling was the same single `ensuring` as here, with the
body still on the caller's fiber, and it was longer while adding two
lifecycle cases (raced creation, ended queue) that the chain does not have.

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
(a shutdown handler, a host callback typed as an Effect) without
stepping through a Promise to get them. The services are the runtime's own
context, built once and cached there, so this is the same provision
`runPromise` would have made, minus the boundary.

```ts
function withProcessServices<A, E, R = ProcessServices | Sessions>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
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

## WorkspaceAgents

One workspace's agents over the catalog: its selection, the agents it
shows (`visible`), and the agent a launch from it runs.

```ts
interface WorkspaceAgents extends WorkspaceAgentsController<AgentEntry> {
  /**
   * The agent a launch runs, over a settled catalog: the entry an explicit
   * `source` pins, else a visible one, else any. A miss reloads once, then
   * fails with {@link AgentNotFound}, saying what the load said.
   */
  readonly forLaunch: (
    identifier: string,
    source?: AgentSource | null,
  ) => Effect.Effect<
    AgentEntry,
    AgentNotFound | AgentCatalogLoadError | StateReadFailed
  >;
}
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
  /** The app's team membership read (`AgentDirectoriesPort.teamMembers`). */
  readonly teamMembers: AgentDirectoriesPort['teamMembers'];
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
holding several sessions never answers one project's question with another's
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
