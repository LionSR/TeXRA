# `@texra-ai/harness/plugins`

<!-- Generated from `packages/harness/src/plugins.ts` by `npm run docgen`; do not edit. -->

Built-in plugins (`harnessBuiltins`) and the plugin authoring surface for
`@texra-ai/harness`.

> **Guide:** Read [Plugins, Tools & Codemode](/api/plugins-and-codemode) for
> how to author tools and plugins, how step-pinned catalogs work, and how the
> `script` (Codemode) sandbox replays across crashes.

### Key exports by role

- **Built-in plugins**: [`harnessBuiltins`](#harnessbuiltins) bundles
  [`codemode`](#codemode), [`fileOps`](#fileops), [`goal`](#goal),
  [`memoryWorkflow`](#memoryworkflow), [`multiAgent`](#multiagent)
  (the `agent` tool, [`AGENT_TOOL_NAME`](#agent_tool_name), and the
  `program` tool), and [`web`](#web) for
  `Sessions.layer({ platform, plugins, client })`.
- **Plugin & tool authoring**: [`defineTool`](#definetool),
  [`definePlugin`](#defineplugin) and the
  [`Plugin`](#plugin) it returns (what a plugin package declares it exports),
  [`executed`](#executed), [`errorResult`](#errorresult),
  [`ToolError`](#toolerror), [`nullishWithDefault`](#nullishwithdefault),
  [`resolveToolPath`](#resolvetoolpath), and file-edit approval helpers
  ([`requestToolEditApproval`](#requesttooleditapproval),
  [`buildApprovalRejectedResult`](#buildapprovalrejectedresult),
  [`approvedWriteConflict`](#approvedwriteconflict)).
- **Runtime callbacks inside a tool**: the call's run and requests on
  [`ToolContext`](#toolcontext), [`ChildRuns`](#childruns), and
  [`RunInbox`](#runinbox).
- **Settings, stores & signals**: [`Settings`](#settings) over a
  [`ConfigProvider`](#configprovider) and a [`StateStore`](#statestore)
  (failing with [`StateReadFailed`](#statereadfailed),
  [`StateWriteFailed`](#statewritefailed) or
  [`ConfigWriteFailed`](#configwritefailed)), the rooted file systems
  ([`WorkspaceFs`](#workspacefs), [`StorageFs`](#storagefs),
  [`GlobalStorageFs`](#globalstoragefs)), and the process services a
  plugin layer may read ([`AppState`](#appstate),
  [`GlobalValues`](#globalvalues), [`ToolCatalog`](#toolcatalog),
  [`AppSignals`](#appsignals)).
- **Lifetimes, prompt sections & durable rows**:
  [`PromptSection`](#promptsection),
  [`ProcessPluginLayer`](#processpluginlayer),
  [`SessionPluginLayer`](#sessionpluginlayer), [`PluginHold`](#pluginhold),
  [`FactKind`](#factkind), and [`Program`](#program) (how its run
  reads: [`ProgramResult`](#programresult)).

## AGENT_TOOL_NAME

The tool that runs a named agent as a child of the calling run.

```ts
const AGENT_TOOL_NAME: "agent"
```

## AgentTrace

Agent-general SDK surface. Every method ultimately reduces to `emit()` so
the trace channel is a single source of truth. App-specific helpers are
plain functions over this interface.

```ts
interface AgentTrace {
  // ─── SSoT primitives ────────────────────────────────────────────────
  emit(event: AgentEvent): void;

  // ─── Plain logging (sugar over emit) ────────────────────────────────
  debug(message: string, options?: LogOptions): void;
  info(message: string, options?: LogOptions): void;
  warn(message: string, options?: LogOptions): void;
  error(message: string, options?: LogOptions): void;
  /** A chunk of a process run's output, on its stream (`process.output`). */
  output(stream: 'stdout' | 'stderr', text: string): void;

  // ─── Stages and stream handles ──────────────────────────────────────
  /**
   * Run `use` as a labelled stage (`stage.start`): what it logs on the trace
   * it is handed nests under the stage, which closes once `use` exits
   * (`stage.end`): completed when it succeeds, else as its cause reads
   * (`outcomeFromCause`).
   */
  stage<A, E, R>(
    label: string,
    use: (trace: AgentTrace) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R>;
  /**
   * Open a streaming message. Its `stream.start` waits for the first
   * non-empty chunk (or a finalize that carries text): subscribers read
   * `stream.start` as "this phase began" (a thinking stream drives a "model
   * is thinking" indicator), so a stream opened at request setup announces
   * no phase that never happens. A stream that ends without content emits
   * nothing at all.
   */
  openStream(kind: MessageType): StreamHandle;
  /**
   * Open a tool call's card with its first log (`tool.start`). A log whose
   * status is already terminal opens and closes the card at once; one without
   * a status, or `in_progress`, leaves it open for `update`.
   */
  openToolCard(log: ToolUseLog): ToolCardHandle;
}
```

## ApprovedEditConflictError

The approved edit no longer applies: the file changed on disk while the
edit waited for approval (another run, a subagent, the user's editor), and
the approved change overlaps a change made to that version, or the
file was deleted or created meanwhile. Nothing was written.

```ts
class ApprovedEditConflictError extends ToolError
```

## approvedWriteConflict

{@link writeApprovedContent} for a caller that reports each file's
outcome: a conflict is the value, every other failure stays one.

```ts
function approvedWriteConflict(
  path: string,
  original: string | null,
  finalContent: string,
)
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
credentials, workspace-file writes). Not for run or session progress:
that is a run's trace event (`AgentEvent`) or a session row
(`SessionRow`).

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
   * A write or removal of one secret-store entry finished. Emitted by the
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
   * credential-dependent settings surfaces, and any change reloads the
   * launcher's credential check and model catalog), the CLI chat
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
   * sign-out, the enabled models, or a setting whose write re-routes models
   * (`onWrite.invalidatesModelOptions`). Keyless on purpose: a listener
   * re-reads the routes it shows.
   *
   * Emitted by the app's writers themselves, so no caller announces for
   * them: a subscription's sign-in, sign-out and preference write, a coding
   * plan's toggle, and the settings write path for a row that re-routes
   * models. The enabled-model write is the one still announced by its
   * caller, the settings view. Consumed by: the CLI chat TUI's status bar,
   * which re-reads the route and quota it shows, and the extension's and
   * desktop's launchers, which re-read their credential check and model
   * catalog.
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
   * The workspace agents changed. Keyless on purpose: every listener
   * re-reads the agent list, so which agent moved carries no information.
   *
   * Emitted, in every process sharing the global store, when the agent
   * catalog is reloaded after a tool switch, a plugin install or an agent
   * file's edit (`agentCatalogFollower`, in this process or another). The
   * settings views' agent writes emit it themselves.
   *
   * Consumed by: extension and desktop settings views, both re-reading the
   * agent list, and their launchers. Not the CLI: it reads the agent list
   * per command and has no persistent panel that could go stale.
   */
  workspaceAgentsChanged: undefined;

  /**
   * The approval policy was written from a settings view (the shared
   * settings commands' `updateStateSetting`).
   *
   * Consumed by: the extension's status-bar tooltip and the launchers'
   * approval snapshot, painted outside the
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

## AppSignals

The process's signal hub: one unbounded `PubSub`, built once by the
process layer and served to every program of the process from context.
Unbounded and never shut down, so publishing never blocks or drops; a
subscription only receives what is published after it exists.

```ts
class AppSignals extends Context.Service<
  AppSignals,
  {
    /**
     * Publish `signal` to every current subscriber and return. Synchronous
     * by construction: the publish is the enqueue, and the hub is unbounded,
     * so it always accepts without suspending. The delivery itself runs on
     * each subscriber's own fiber — see the delivery and error order above.
     * For an owner whose callbacks run outside any fiber (a secret store's
     * commit, a registry's close listener), which captures the service
     * where its layer is built; a program publishes with
     * {@link emitAppSignal}.
     */
    readonly emit: <K extends AppSignal>(
      signal: K,
      payload: AppSignalPayloads[K],
    ) => void;
    /** A subscription to every signal, held for the caller's scope. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<AppSignalEvent>,
      never,
      Scope.Scope
    >;
  }
>()('@texra-ai/harness/AppSignals')
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

## assertNoParentTraversal

Fail when a raw tool path contains a parent-directory segment.

```ts
const assertNoParentTraversal: (targetPath: string) => Effect<void, ToolError, never>
```

## BoundModel

One bound model: llm's `Binding` (or the validation model's) and the facts
of the run the binding serves. Everything else a binding needs (its
credential, its reasoning choice, the toggles it was bound under) stays
inside model access.

```ts
interface BoundModel extends Binding {
  /** The run's model string (`provider/id[@effort][+pro]`), as its rows name it. */
  readonly modelId: string;
  /** The catalog entry the model string names, before any route's overlay:
   *  the id and list prices the usage log reports each call under. */
  readonly catalogEntry: ModelConfig;
  /** The backend its `run.config` records. */
  readonly backend: ModelBackend;
  /** The subscription routes the run had declined when this binding was
   *  decided; its `run.config` records them, and the fold unions them with
   *  every route a retry declines after. */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  /** The route decision this binding carries out, or the validation model. */
  readonly route: ModelRoute | { readonly kind: 'validation' };
  /** Automatic retries after a failed attempt, read with the binding. */
  readonly automaticRetries: number;
  /** Bound for a text-only persona, with the model's whole output budget; a
   *  rebinding keeps it. */
  readonly textOnly: boolean;
  /** The ChatGPT plan the subscription's token names; display-only. */
  readonly plan?: string;
  /** The retry gate's routes: the model on its wire route, then the wire route. */
  readonly routes: readonly [RoutePolicy, RoutePolicy];
}
```

## buildApprovalRejectedResult

```ts
function buildApprovalRejectedResult(
  path: string,
  sourceTool: string,
  refusal: RefusalDecision,
): ToolResult
```

## buildFileAttachment

Build a tool attachment by reading a workspace file and packaging metadata.

```ts
const buildFileAttachment: (args_0: BuildFileAttachmentOptions) => Effect<{ readonly [x: string]: unknown; readonly path: string; readonly mimeType: string; readonly description?: string | undefined; readonly digest?: string | undefined; readonly base64Data?: string | undefined; readonly bytes?: Uint8Array<ArrayBuffer> | undefined; }, ToolError, FileSystem | ToolContext>
```

## BuildFileAttachmentOptions

```ts
interface BuildFileAttachmentOptions {
  /** Path to a workspace file (relative or absolute) */
  filePath: string;
  /** Optional description surfaced to the model */
  description?: string;
  /** Override detected MIME type */
  mimeType?: string;
  /**
   * Pre-resolved path. When provided, skips the internal resolveToolPath()
   * call — use this to avoid double-resolution when the caller already
   * resolved the path (e.g. ReadTool).
   */
  resolved?: ToolPathResolution;
}
```

## CallRequests

The requests one tool call raises, opened through its run's loop. Each
carries an id its attempt derives. A request still open when its run
stops is cancelled, and the resumed call asks again under a new id.

```ts
interface CallRequests {
  /** The id the call's next request opens under: the attempt's next
   *  derived id. A request is staged under this id before it opens. */
  readonly nextId: () => string;
  /** Open the request and wait for its decision. The returned payload is
   *  the request as it opened.
   *  `blobs` are the strings the payload names by address, stored with its
   *  row. `operation` is what a command (`bash`) asks permission for: the
   *  shell's (`'bash'`, which the run's command grant answers) or another
   *  tool's call (`'call'`, which only the delegated-work grant answers).
   *  An edit, a plan or a proposal asks about its own kind; with the
   *  call's hooks, the operation decides who answers the request, and a
   *  request about none is a person's. */
  readonly open: <P extends RequestPayload>(
    payload: P,
    opening?: {
      readonly blobs?: readonly DraftBlob[];
      readonly operation?: 'bash' | 'call';
    },
  ) => Effect.Effect<
    {
      readonly payload: Extract<RequestPayload, { kind: P['kind'] }>;
      readonly decision: DecisionOf<P['kind']>;
    },
    DatabaseAggregateClosed | CellError
  >;
  /** Show the person something on the session's host (a file opened
   *  beside what they are looking at, a notice), answered by nothing. */
  readonly present: <K extends RuntimePresentationEvent>(
    event: K,
    payload: RuntimePresentationEventPayloads[K],
  ) => Effect.Effect<void>;
}
```

## CellError

What a run cell's commits and re-reads fail with.

```ts
type CellError =
  | RunHistoryRefused
  | DatabaseWriteFailed
  | DatabaseReadFailed;
```

## ChildRunDelivery

A child run's report to its parent ({@link ChildRunDeliverySchema}).

```ts
type ChildRunDelivery = typeof ChildRunDeliverySchema.Type;
```

## ChildRuns

The door, as the run loop provides it beside each call ({@link childRuns}).

```ts
class ChildRuns extends Context.Service<ChildRuns, ChildRunsShape>()(
  '@texra-ai/harness/agent/ChildRuns',
)
```

## ChildRunsShape

A plugin tool's one door to the session's runs. It launches an external
process as a child of its call's run (`launchProcess`: its run id,
outside the child-run budget); a plugin's tool reaches no other launch.
And it reaches a run of the session by id: its input, records, whether
it holds a request, and the plugin's own facts on it, each over the
call's run.

```ts
interface ChildRunsShape {
  readonly launchProcess: (
    launch: ProcessChildLaunch,
  ) => Effect.Effect<RunId, Error, ToolContext | RunServices>;
  /** The run's input: what a tool sends it, and when it takes no more. */
  readonly inbox: (runId: RunId) => Effect.Effect<RunInbox, Error>;
  /** Its records: whether the store still lists it, and its terminal
   *  result (null before it ends). */
  readonly records: (runId: RunId) => {
    readonly exists: Effect.Effect<boolean, Error>;
    readonly end: Effect.Effect<RunEnd | null, Error>;
  };
  /** The latest value of `factKind` among the run's own facts, decoded
   *  by its schema; undefined while the run recorded none. */
  readonly fact: <A>(
    runId: RunId,
    factKind: {
      readonly plugin: string;
      readonly kind: string;
      readonly schema: Schema.Codec<A, unknown>;
    },
  ) => Effect.Effect<A | undefined, Error>;
  /** Whether the launching run's work runs unasked (the Auto-approve policy,
   *  or an all-agent-work grant on it or an ancestor), read on each call,
   *  since a grant may land mid-run: what a child's own sandbox or
   *  permissions follow. */
  readonly autoApproved: Effect.Effect<boolean, Error>;
  /** Whether the run holds the request `requestId`, open or decided: what
   *  a tool that posted one reads after a failed post. */
  readonly requested: (
    runId: RunId,
    requestId: string,
  ) => Effect.Effect<boolean, Error>;
}
```

## codemode

Code mode: the `script` tool, a program that calls the run's other tools,
and `self()`, the function a script runs this agent again with. An agent
gets them if its configuration names `script`, or as every run that takes
injected tools does (not a program's run, a text-only persona, or a plugin
agent that names its own tools). A step that offers `script` sends it and
the run's own tools alone; its session layer is the code sandbox the
scripts run in.

```ts
const codemode: Plugin
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
   * It is synchronous because some readers cannot wait for an Effect: the
   * replacement engine's rule sets, a tool's `prompt` callback, the
   * approval `policy` callback, the VS Code status bar's paint, the host
   * snapshot's projection and the CLI's startup rows, read before its
   * runtime exists. A read is cheap: each scope's JSON store it consults
   * (workspace, global, and local for a local row) stats its file (inode,
   * mtime, size) and re-reads it only when that changed, so another
   * process's edit is seen without a watcher.
   *
   * It casts: the value it returns is whatever the store holds. A reader
   * that needs the value checked reads through `Settings.get`, which
   * safe-parses the stored value against the row's schema; a hand-edited
   * `"false"` in a boolean row is a truthy string here and silently means
   * the opposite.
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

## CurrentValues

A root's current values (`current_value`): one row per family and key,
replaced in place, outside the event history, so an event-format bump
leaves them. Every write is one `BEGIN IMMEDIATE`;
a value decodes with its family's schema where it is read, and a row that
no longer decodes fails that read.

```ts
interface CurrentValues {
  readonly get: <T>(
    family: ValueFamily<T>,
    key: string,
  ) => Effect.Effect<T | undefined, DatabaseReadFailed>;
  /**
   * Change the values of `keys` from the ones read under the write lock:
   * `change` answers with its result and the next value of every key, with
   * its result alone to write nothing, or refuses and nothing is written. A
   * next value of `undefined` deletes the row.
   */
  readonly modify: <T, K extends string, A, E = never>(
    family: ValueFamily<T>,
    keys: readonly K[],
    change: (
      current: Readonly<Record<K, T | undefined>>,
    ) => Result.Result<
      readonly [A] | readonly [A, Readonly<Record<K, T | undefined>>],
      E
    >,
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

## DecisionOf

The decisions a request of kind `K` takes: its own actions and the three
refusals.

```ts
type DecisionOf<K extends RequestKind> =
  | Extract<RequestDecision, { action: (typeof REQUEST_ANSWERS)[K][number] }>
  | RefusalDecision;
```

## DefinedTool

A defined tool: plain data plus a `call` that validates and normalizes
failures. An anonymous object type so the SDK's `.d.ts` inlines it.

```ts
type DefinedTool<T, R = never, Name extends string = string> = Omit<
  ITool<Error, R>,
  'call' | 'guard' | 'definition'
> & {
  readonly definition: ToolDefinition & { readonly name: Name };
  call(
    rawInput: unknown,
  ): Effect.Effect<ToolResult, Error, Exclude<R, Scope.Scope>>;
  readonly guard?: ToolGuard<T>;
};
```

## definePlugin

A plugin value from its definition, its own services erased: the
harness's built-ins and an app's plugins are written the same way. The
value is `plugin` itself, frozen with the arrays and records it is
written with (its tools, its probe, its programs): every session of the
process shares the one definition, and none can change it for the
others.

```ts
const definePlugin: <ROut = never>(plugin: PluginDefinition<ROut>) => Plugin
```

## defineTool

Define a tool: validate the model's input against `schema`, run `execute`,
and turn ordinary failures into `{ status: 'error' }` feedback.
Interruption, run history refusals and database write failures propagate.

A tool whose `execute` succeeds with a `ToolResult` carrying a `value`
hands a script that value in place of `{ output, summary }`. Declare its
TypeScript type in `scriptReturns`, which is what a script is told the
call resolves to. Nothing derives one from the other: a tool that returns
a `value` without `scriptReturns` is declared to scripts as resolving to
`ToolOutput`, so change the two together.

```ts
function defineTool<T, R = never, const Name extends string = string>(
  def: DefineToolOptions<T, R> & { readonly name: Name },
): DefinedTool<T, R, Name>
```

## DefineToolOptions

```ts
type DefineToolOptions<T, R = never> = Required<
  Pick<ToolDefinition, 'name' | 'description'>
> &
  Pick<ToolDefinition, 'scriptReturns'> &
  Pick<
    ITool,
    | 'hostCapability'
    | 'lane'
    | 'scriptGlobal'
    | 'replay'
    | 'requiresApproval'
    | 'describe'
  > & {
    /** Decodes the model's input into `T`. */
    schema: Schema.Codec<T, unknown>;
    /**
     * What the run loop checks before this tool's body runs: the paths the
     * call writes and the command it must get approved. Declared here; the
     * loop applies it once, so the body never re-checks it.
     *
     * `NoInfer<R>`: the guard is checked against the requirement channel the
     * tool already has, it never sets it.
     */
    guard?: ToolGuard<T>;
    /** The card a call states from its decoded input (`ToolUseLog.card`).
     *  A call whose input does not decode gets none. */
    card?: (input: T) => ToolCard | undefined;
    /** The run body. Succeed with the text the model reads back, or with a
     *  whole `ToolResult` for a summary, attachments or facts; fail with
     *  an `Error` and the model reads its message as the tool's error. */
    execute: (input: T) => Effect.Effect<ToolResult | string, Error, R>;
  };
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

## EditRecord

```ts
type EditRecord = typeof EditRecordSchema.Type;
```

## emitAppSignal

Publish `signal` from a program: {@link AppSignals}' `emit`.

```ts
const emitAppSignal: <K extends AppSignal>(signal: K, payload: AppSignalPayloads[K]) => Effect<void, never, AppSignals>
```

## errorResult

Build a `status: 'error'` result literal. Reserved for call sites that
cannot fail the tool's Effect with a `ToolError` (the usual way, which
`defineTool` turns into the call's error): typically a caller that must keep
running after reporting a partial per-item error. Prefer failing with
`ToolError` whenever the call site can.

```ts
function errorResult(
  error: string,
  extra?: Omit<Extract<ToolResult, { status: 'error' }>, 'status' | 'error'>,
): Extract<ToolResult, { status: 'error' }>
```

## executed

Build a `status: 'executed'` result. `summary` is omitted when not given,
matching the many call sites that only ever set `output`.

```ts
function executed(
  output: string,
  summary?: string,
): Extract<ToolResult, { status: 'executed' }>
```

## FactKind

One row kind a plugin owns (`plugin.fact`): the version it writes and
reads, and the schema of that version's value; a stored row at a lower
version is an earlier build's, and one at a higher version refuses the
store. The store checks every row of the kind against its fact kind, and
reads a row whose fact kind the process's plugins lack (its plugin
removed, or not listed here) as written, marked `unavailable`; a run
holding one does not resume. Fact kinds live beside their readers, in
modules webviews can import.

```ts
interface FactKind {
  /** The plugin's id: a fact kind is its own plugin's, never another's. */
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
  /** What a fork of a run (a conversation's, or a script's `self()` child)
   *  starts with of the run's own row of the kind: `copy` the row the run
   *  held at the cut, `drop` none. A row about the plugin's own aggregate
   *  belongs to that aggregate and stays with it. */
  readonly fork: 'copy' | 'drop';
  /** The kind's own transition rule, checked by its writer in the job that
   *  appends the row (`ownFactsChecked`) against the aggregate's latest row
   *  of the kind (none before the first): the rejection's reason, or null
   *  to accept. */
  readonly accepts?: (
    previous: PluginFactRow | undefined,
    next: PluginFactRow,
  ) => string | null;
  /** Whether the aggregate's `latest` row already says more than `next`
   *  (a call's fact that lagged behind a later writer): the call's batch
   *  then leaves `next` out instead of failing on `accepts`. */
  readonly supersedes?: (latest: PluginFactRow, next: PluginFactRow) => boolean;
  /** The workspace files a row of the kind says its run wrote past the
   *  editor's own write path: every process that folds the run announces
   *  them (`workspaceFilesWritten`), a window hearing a service task's
   *  write as it hears its own. */
  readonly writes?: (value: Schema.Json) => readonly string[];
}
```

## FactKinds

The plugin fact kinds a store reads, by `plugin/kind`.

```ts
type FactKinds = Readonly<Record<FactName, FactKind>>;
```

## fileOps

Files and the shell: every agent needs them. An app passes the filter
`write_file` applies to what it writes (its own content replacements).

```ts
const fileOps: (options?: { readonly writeFilter?: WriteFilter | undefined; }) => Plugin
```

## formatToolOutput

Format tool output with a header and content.

```ts
function formatToolOutput(
  header: string,
  content: string | string[] | null,
  noMatchesText: string = '(no entries)',
): string
```

## getGitignoreMatcher

Build the ignore matcher for `workspaceRoot` from its ignore policy files.
The root is the caller's — the `WorkspaceFs` of the session the call works
on — rather than whichever roots the calling fiber carries, so a listing
and the policy that filters it name the same workspace. Read on every call:
a process serves several projects, and each call should see the policy as
it is on disk now.

```ts
const getGitignoreMatcher: (workspaceRoot: string | undefined) => Effect<GitignoreMatcher, PlatformError, FileSystem>
```

## GitignoreMatcher

A workspace's ignore policy: whether a workspace-relative path is
ignored, and the policy files it was read from.

```ts
type GitignoreMatcher = {
  ignores: (relativePath: string) => boolean;
  ignoreFiles: string[];
};
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

## goal

Plans and goals: the `plan` tool proposes a plan, which the user may run
as a goal: a background script of the conversation that runs its agent
in rounds through `self()` (`goalScript`), on the default strategy, its
module `builtIn:goal`, unless `goal.strategy` names another.

```ts
const goal: Plugin
```

## harnessBuiltins

Every built-in, with no app options.

```ts
const harnessBuiltins: readonly Plugin[]
```

## HostCapabilities

The host capabilities a session's host serves now (`ITool.hostCapability`
names one), by the session's storage root: what a plugin whose tools need
a host capability serves from its process layer, from the same place its
tools reach that capability, so it is offered exactly while it works.
A plugin that serves none offers its gated tools nowhere.

```ts
class HostCapabilities extends Context.Service<
  HostCapabilities,
  { readonly of: (storage: string) => ReadonlySet<string> }
>()('@texra-ai/harness/agent/HostCapabilities')
```

## InboxItem

One message a producer sends: a text, with what surfaces show instead
(`displayText`) and a user's media (e.g. pasted images) with its blobs
(`attachedMedia`); or a child's delivery to its parent, whose facts its
row keeps typed.

```ts
type InboxItem = (
  | {
      readonly text: string;
      readonly displayText?: string;
      readonly media?: readonly StoredMedia[];
      readonly blobs?: readonly DraftBlob[];
    }
  | { readonly delivery: ChildRunDelivery }
) & {
  readonly from: FollowUpSender;
  /** Identity of a delivery its producer may repeat (a child's result):
   *  the row's `followUpId`, so a replay writes nothing. */
  readonly deliveryId?: string;
  /** A request of the run's own (`/compact`, a model switch), not a message. */
  readonly control?: QueuedFollowUp['control'];
};
```

## isTransientHttpStatus

Whether an HTTP status code is transient (worth retrying): 408 request
timeout, 429 rate limit, or 5xx server error. Other 4xx statuses are
permanent and won't change on retry.

This is the general-purpose HTTP policy (tool fetches, tool timeouts,
device-code polling). The llm package's internal provider-error retry
policy is a separate, deliberately different policy for LLM provider SDK
errors: it also treats 409 Conflict as retryable, because a provider API's
409 usually signals a transient session/resource race, unlike a generic
HTTP 409. Don't merge the two without re-confirming that call for every
consumer.

```ts
function isTransientHttpStatus(status: number): boolean
```

## isTransportReason

A request that got no (complete) answer: nothing responded, or the
connection dropped mid-body (undici's `TypeError`, "terminated"; a
malformed body is a `SyntaxError`).

```ts
function isTransportReason(
  reason: HttpClientError.HttpClientError['reason'],
): boolean
```

## ITool

Contract for tool implementations.
`defineTool` provides the canonical implementation with schema validation.
A tool fails with an `Error` (usually a `ToolError`) and the model reads its
message as the call's error; a throw is a defect, which `defineTool` turns
into a failed call and logs as a crash unless it is a `ToolError`.

```ts
interface ITool<E = Error, R = never> {
  readonly definition: ToolDefinition;
  /** The host capability (named by the plugin that serves it,
   *  `HostCapabilities`) the session's host must serve for this tool to be
   *  offered, read live each step: a window that attaches mid-run brings it. */
  readonly hostCapability?: string;
  /**
   * Where its calls run beside their siblings (omitted: `'barrier'`).
   * Declared on the tool, not the YAML-overridable definition, so an agent
   * config cannot move an arbitrary tool out of order.
   *
   * - `'parallel'`: side-effect-free AND approval-free, so calls of one
   *   response (or one script) run concurrently within the parallel window,
   *   and identical ones collapse onto one (`partitionDuplicateCalls`). A
   *   read-only tool that prompts for approval is not parallel: it needs an
   *   approval round-trip first, so it stays a barrier.
   * - `'barrier'`: waits for every call issued before it and holds back
   *   every call after it until it finishes.
   * - `'own'`: in a script, its calls neither wait for the calls issued
   *   before them nor block the ones after, and take no place in the
   *   parallel window: the tool bounds how many of its own calls run at
   *   once (a call that waits on a child run). A later barrier still waits
   *   for it; a response's call of it is a barrier.
   */
  readonly lane?: DispatchFacts['lane'];
  /**
   * The tool is also a global function of a script, taking its `positional`
   * field as the first argument and the rest as the second:
   * `agent(prompt, opts)` for `tools.agent({ prompt, ...opts })`.
   * `withScript`: a function of scripts alone (`self()`), offered whenever
   * the script tool is and never sent to the model as a tool of its own.
   */
  readonly scriptGlobal?: {
    readonly positional: string;
    readonly withScript?: true;
  };
  /**
   * Whether a call recorded as started, with no result, may run again on
   * resume without asking: `'safe'` only for a read-only or idempotent tool,
   * whose second run changes nothing the first did not. Omitted is
   * `'unsafe'`. Independent of `lane`, which is about concurrency.
   * The response row saves the declaration with each call, and a resume
   * re-runs a call only when that saved word and the current one both say
   * `'safe'`.
   */
  readonly replay?: 'safe' | 'unsafe';
  /**
   * Whether a call needs a person's approval, and who asks. `true` (implied
   * by `guard.command`): the run loop, before the body runs. `'inBody'`: the
   * body's own request (an edit's review, a plan, a delegation proposal, a
   * question), which answers what the call's hooks
   * said. A run that cannot present a prompt is not offered such a tool
   * (`asksApproval`).
   */
  readonly requiresApproval?: true | 'inBody';
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never>;
  /**
   * A description rendered from the other tools the run declares, the
   * modules its scripts may import and the programs they may start, in
   * place of `definition.description`:
   * rendered at the step that freezes the run's system text and kept as
   * that step recorded it until a compaction opens the freeze again, so a
   * catalog change mid-run leaves its text, and the cached
   * prefix through it, as it was. The tool that has one is the script tool,
   * which reaches nothing but the run's other tools and its own agent: a
   * child is offered it, and its script-only functions, whatever its parent
   * was.
   */
  readonly describe?: (
    declared: readonly Pick<ITool, 'definition' | 'scriptGlobal' | 'lane'>[],
    /** The specifiers of the modules the step's scripts may import. */
    modules: readonly string[],
    /** The programs of the step's plugins, each with its one-line
     *  description. */
    programs: readonly {
      readonly name: string;
      readonly description: string;
    }[],
  ) => string;
  call(rawInput: unknown): Effect.Effect<ToolResult, E, R>;
}
```

## jitteredExponentialBackoffMs

Compute a jittered exponential backoff delay: `baseMs * 2^(failures-1)`,
capped at `maxMs`, then randomized by +/-20% and capped again
so jitter can never push the result past `maxMs`. Shared by every retry/
backoff loop in the codebase so the jitter formula only exists once.

`unitRandom` is the caller's uniform draw in [0, 1) — `yield* Random.next`
in the Effect callers — so a test fixes the jitter through Effect's
`Random` reference instead of stubbing the global `Math.random`.

```ts
function jitteredExponentialBackoffMs(
  baseMs: number,
  failures: number,
  maxMs: number,
  unitRandom: number,
): number
```

## JsonRpcConnection

```ts
interface JsonRpcConnection {
  readonly request: (
    method: string,
    params?: unknown,
  ) => Effect.Effect<unknown, JsonRpcRequestError | JsonRpcConnectionDisposed>;
  /** Send a notification; after `close` it is dropped. */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void>;
  /** Fail every pending request with `reason` and refuse later ones. Idempotent. */
  readonly close: (reason: string) => Effect.Effect<void>;
  /** Completes once the reader has dispatched the input's last message. */
  readonly inputEnded: Effect.Effect<void>;
}
```

## JsonRpcConnectionDisposed

The connection was closed; `message` is the closer's reason.

```ts
class JsonRpcConnectionDisposed extends Schema.TaggedError<JsonRpcConnectionDisposed>()(
  'JsonRpcConnectionDisposed',
  { message: Schema.String },
)
```

## JsonRpcConnectionOptions

What {@link makeJsonRpcConnection} connects: the peer's byte streams,
their framing, and the owner's handlers.

```ts
interface JsonRpcConnectionOptions {
  /** The peer's output: bytes we decode. */
  readonly input: Stream.Stream<Uint8Array, Error>;
  /** The peer's input: bytes we encode. */
  readonly output: Sink.Sink<void, Uint8Array, never, Error>;
  readonly onNotification: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void>;
  /**
   * `'content-length'` (the default): LSP frames. `'newline'`: one JSON
   * message per line, no embedded newlines (MCP stdio).
   */
  readonly framing?: 'content-length' | 'newline';
  /**
   * The result of a request the peer sends us, or `undefined` to refuse it
   * with `MethodNotFound`.
   */
  readonly onRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown> | undefined;
  /** The notification telling the peer we stopped waiting for unanswered
   *  request `id` (its caller was interrupted, a timeout too). */
  cancel?(
    id: number,
    method: string,
  ): { readonly method: string; readonly params: unknown } | undefined;
}
```

## JsonRpcRequestError

The peer answered a request with a JSON-RPC error. `code` is the JSON-RPC
error code the peer sent.

```ts
class JsonRpcRequestError extends Schema.TaggedError<JsonRpcRequestError>()(
  'JsonRpcRequestError',
  {
    method: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.Number),
    cause: Schema.Defect(),
  },
)
```

## logFailure

Log `message` as a warning on `channel`, with the failure it is given
attached as the entry's `data`.

```ts
const logFailure: (channel: string, message: string) => (data: unknown) => Effect<void, never, never>
```

## LogOptions

What a trace's log methods take: a row's category (subscribers pick a
render style from it) with the payload the transcript decodes for it,
so a pairing is checked where it is written; or no category, a default
row with any data. The row stores the payload as JSON; a `Cause` stores
as the error it raised.

```ts
type LogOptions =
  | { readonly messageType?: undefined; readonly data?: unknown }
  | {
      // A payload is required unless the type's schema accepts none.
      [
        K in MessageType
      ]: undefined extends (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded']
        ? {
            readonly messageType: K;
            readonly data?: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded'];
          }
        : {
            readonly messageType: K;
            readonly data: (typeof LOG_PAYLOAD_SCHEMAS)[K]['Encoded'];
          };
    }[MessageType];
```

## makeJsonRpcConnection

```ts
const makeJsonRpcConnection: (options: JsonRpcConnectionOptions) => Effect<JsonRpcConnection, never, Scope>
```

## MemoryPinResult

What a pin did: `cap-reached` names the cap it hit.

```ts
type MemoryPinResult =
  | { readonly status: 'pinned'; readonly pinnedCount: number }
  | { readonly status: 'already' }
  | { readonly status: 'cap-reached'; readonly max: number };
```

## MemoryPreview

One memory's bounded preview, with the path the memory tool shows.

```ts
interface MemoryPreview {
  readonly storagePath: string;
  readonly displayPath: string;
  readonly preview: string;
  /** Absent when the file did not fit the scan window. */
  readonly lineCount: number | undefined;
}
```

## MemoryStore

The memory tree's host-facing reads and edits, over the caller's
`StorageFs`.

```ts
const MemoryStore: { folder: "memories"; storagePath: (input: string) => Effect<string, ToolError, never>; displayPath: (storagePath: string) => string; list: Effect<{ readonly displayPath: string; readonly storagePath: string; readonly size: number; readonly mtime: string; readonly preview?: string | undefined; readonly lineCount?: number | undefined; readonly previewError?: boolean | undefined; readonly modifiedBy?: string | undefined; readonly pinned?: boolean | undefined; }[], PlatformError, StorageFs>; preview: (input: string) => Effect<MemoryPreview, ToolError | PlatformError, StorageFs>; delete: (input: string) => Effect<void, ToolError | PlatformError, StorageFs>; pin: (input: string) => Effect<MemoryPinResult, ToolError | PlatformError, StorageFs>; unpin: (input: string) => Effect<void, ToolError | PlatformError, StorageFs>; }
```

## memoryWorkflow

Memory and past runs: the `memory` tool, offered while memory is on,
and `executions`.

```ts
const memoryWorkflow: Plugin
```

## ModelRetryGate

Gate `attempt` on every route in `routes`, narrowest first. The tuple is
non-empty because an empty list would run the attempt ungated.

```ts
interface ModelRetryGate {
  readonly withRoutes: (
    routes: readonly [RoutePolicy, ...RoutePolicy[]],
  ) => <A, E, R>(attempt: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}
```

## multiAgent

Child runs: the `agent` tool, and `program` for a registered program.

```ts
const multiAgent: Plugin
```

## noLaterTurn

Whether no later turn reaches `run`: a root that stops after its cycle,
or a child its parent's call awaits (the call reads its end and goes
on). A background child stops after its cycle too, but a delivery or a
message resumes it, so a result sent to it as a follow-up arrives.

```ts
const noLaterTurn: (run: Pick<ToolRun, "toolPolicy" | "entry">) => boolean
```

## nullishWithDefault

An optional tool-input field whose absence resolves to `fallback` before
`execute` ever sees it.

The encoded side is `Schema.optional(Schema.NullOr(schema))`, deliberately
not `Schema.optional(schema)` with a decoding default. OpenAI-compatible
providers (DeepSeek, Kimi, …) represent an omitted optional field as an
explicit `null` in structured output, so the field must be nullable as well
as optional; `withDecodingDefault` substitutes only for an absent or
`undefined` field and would hand `null` straight through. The `?? fallback`
covers absent, `undefined` and `null` alike, which is why the decoded field
is required and not nullable, and use sites need no `== null` check of
their own.

`description` is written on the encoded side: that is the side the model's
JSON Schema is generated from, and an annotation on the decoded side of a
transformation never reaches it.

```ts
function nullishWithDefault<S extends Schema.Top>(
  schema: S,
  fallback: S['Type'],
  description: string,
): Schema.decodeTo<Schema.toType<S>, Schema.optional<Schema.NullOr<S>>>
```

## parseWorkingDirectory

Trim and validate a working_directory value. Must be absolute if provided.

```ts
function parseWorkingDirectory(
  raw: string | null | undefined,
): Result.Result<string | undefined, ToolError>
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
themselves, in an `Effect.ensuring` finalizer that runs on every exit: the
file store tells the `credentialChanged` app signal its layer hands it
(`Secrets.announcing`). A writer does not by hand.

```ts
interface PlatformSecrets extends CredentialStore {
  /**
   * List persisted secret names without exposing their values.
   * Used only by credential-audit surfaces.
   */
  listStoredKeys(): Effect.Effect<readonly string[], SecretsFailed>;
}
```

## Plugin

One plugin: what it contributes to a run. How an app shows it (a
dashboard card's copy, its setup guide, its settings rows) is the app's
own record, keyed by `id`.

```ts
interface Plugin {
  /** Stable, persisted identifier (the switch key, the plugin a run's
   *  offered tool records, and the name of its `resources/plugins/<id>/`
   *  directory): lowercase letters, digits and dashes, starting with a
   *  letter or digit. A list with any other id is refused. */
  readonly id: string;
  /** Its tools, registered by each tool's `definition.name`, in order. */
  readonly tools?: readonly ITool<Error, PluginToolServices>[];
  /**
   * Present when the plugin has an external dependency: it is probed, and
   * while the dependency is missing a run is offered none of its tools, is
   * told of none of its programs and reads no prompt section of its.
   * Without it the plugin is built in and always available.
   */
  readonly availability?: ToolAvailabilityChecks;
  /** The plugin has a user switch, which a fresh install sets to this
   *  position; while off, its tools are withheld from every agent. A
   *  switched plugin with no `availability` is probed as needing nothing.
   *  Without a switch the plugin is always on. */
  readonly toggle?: 'on' | 'off';
  /** Tools of this plugin offered to every agent with tools, declared or not,
   *  while the plugin is on and a boolean catalog setting is on: tool name to
   *  setting row, or `true` for no setting but the plugin's own switch. An
   *  injected tool still passes the host and approval gates; a script's
   *  run (a program) and a text-only persona get none. */
  readonly injectedWhen?: Readonly<Record<string, SettingRow<boolean> | true>>;
  /** Its section of each request's system text, pinned while it is on. */
  readonly prompt?: PromptSection;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it. A host-supplied one (VS Code's setup commands) is passed with
   *  the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** The row kinds it owns (`plugin.fact`), on or off: rows outlive it. */
  readonly factKinds?: readonly FactKind[];
  /** Script module sources by name, imported as `builtIn:<name>`. */
  readonly scriptModules?: Readonly<Record<string, string>>;
  /** Those of its `scriptModules` a person or a model starts by name
   *  (`Program`), each under its module's name. */
  readonly programs?: Readonly<Record<string, Program>>;
  /** The plugins it runs on, by id; a list lacking one is rejected. */
  readonly requires?: readonly string[];
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

## PluginDefinition

A plugin as its author writes it: its tools, layers and probe may
require `ROut`, the services its own layers serve, beside the harness's.
`definePlugin` checks that at compile time (a tool that needs a service no
layer of its plugin serves does not compile) and erases it: the table
holds every plugin alike, and the step that pins a plugin provides its
layers' services to its calls.

```ts
interface PluginDefinition<ROut> extends Omit<
  Plugin,
  'tools' | 'processLayer' | 'sessionLayer' | 'availability'
> {
  readonly tools?: readonly ITool<Error, PluginToolServices | ROut>[];
  readonly processLayer?: ProcessPluginLayer<ROut>;
  readonly sessionLayer?: Layer.Layer<ROut, never, PluginHold>;
  /** Probed outside any step, whether or not the plugin is on: it may
   *  require only the process's probe services. Its own process services
   *  are offered while its layer is up, read with `Effect.serviceOption`. */
  readonly availability?: ToolAvailabilityChecks;
}
```

## PluginFactRow

One stored row of a plugin's kind, as its fact kind's transition rule reads
it: the row's decoded value and the run it is parented to, if any.

```ts
interface PluginFactRow {
  readonly value: Schema.Json;
  readonly parent: RunId | null;
}
```

## PluginHold

Keep the session layer that provides this service up until `until` ends:
for work a plugin starts that outlives the step that started it (an agent
CLI's detached child), so switching the plugin off does not drop state
that work still owns. The hold is taken before this returns.

```ts
class PluginHold extends Context.Service<
  PluginHold,
  (until: Effect.Effect<void>) => Effect.Effect<void>
>()('@texra-ai/harness/tools/PluginHold')
```

## PluginLayerServices

What a plugin's process layer is built over: the tool catalog it belongs
to, and the process's filesystem, paths, child processes, application
state (a language server pool spawns and reads its settings) and signal
hub (the GitHub subscriptions announce their bindings).

```ts
type PluginLayerServices =
  | ToolCatalog
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner
  | AppState
  | AppSignals;
```

## PluginToolServices

The services the runtime supplies to a tool's call, a plugin's and a
built-in's alike: the process's, the rooted filesystems of the session
the call works in, the call (`ToolContext`, the run included) and its
child-launch door (`ChildRuns`). A tool takes `WorkspaceFs` from context
instead of resolving a static against whichever roots its fiber happens
to carry. A plugin's tool reads the door and never the session's own
services or the call's place in its run (`RunCall`), which only the
harness's built-ins reach (`inRunSession`).

```ts
type PluginToolServices =
  | RunServices
  | ToolContext
  | ChildRuns
  | WorkspaceFs
  | StorageFs
  | Scope.Scope;
```

## ProcessChildLaunch

A process child as the tool launching it describes it: how it reads
(`identity`), its record, its task label, and the turn built around the
trace of the run the launch registered.

```ts
interface ProcessChildLaunch {
  readonly identity: Extract<RunIdentity, { kind: 'agent' | 'process' }>;
  readonly config: RunRecord;
  readonly description: string;
  /** The turn, built around the trace of the run the launch registered. */
  readonly turn: (ctx: {
    readonly logger: AgentTrace;
    readonly runId: RunId;
  }) => ProcessTurn;
}
```

## ProcessPluginLayer

A plugin's process-lifetime services (its `processLayer`): built
when the plugin is switched on or first pinned, released when it is
switched off and no step uses it. `ROut` is what it
serves its own plugin's code (`definePlugin`); the table holds it erased.
`drain` is its step of the core shutdown protocol, run before the
sessions close while its services are still up.

```ts
interface ProcessPluginLayer<ROut = never> {
  readonly layer: Layer.Layer<ROut, never, PluginLayerServices>;
  readonly drain?: Effect.Effect<void, never, ROut>;
}
```

## ProcessReport

What one process turn reports as it returns.

```ts
interface ProcessReport {
  /** The delivery its parent reads, typed. */
  readonly report: ChildRunDelivery;
  /** How a command exited, recorded as the run's `process.exit` row: a
   *  code other than 0 ends the run failed, its report still delivered. */
  readonly exit?: ProcessExit;
  /** A failure a process with no exit of its own reported without
   *  throwing (an SDK's error result): the run ends failed with it, its
   *  report still delivered. */
  readonly failure?: string;
}
```

## ProcessTurn

A process child's one turn, built around the run's trace.

```ts
interface ProcessTurn {
  /** The turn: the whole process, its output on the trace, over the
   *  process's services (a spawner, the filesystem). A stop interrupts it:
   *  a foreign call takes its signal from that interruption
   *  (`Effect.abortSignal`). */
  readonly run: Effect.Effect<ProcessReport, Error, PlatformServices>;
  /** The delivery of a turn that threw. */
  readonly reportError: (error: Error) => ChildRunDelivery;
}
```

## Program

One of a plugin's script modules that a person or a model starts by name
(`Plugin.programs`): the module's default export is
`async (args, launch) => result`, and a run opened on it
(`AgentConfig.script` of kind `program`) is a script run that imports the
module and calls that export with the launch's `args` and
`{ instruction, inputFiles, contextFiles, mediaFiles }`. A program that
returns text answers with it when it registers no `result`. The plugin wrote
it, not a model, so the launch that chose it granted it: its tools are
the listed ones past any switch, its `agent` calls run under the launch's
approval, and its prompts and files pass as written.

```ts
interface Program<R = unknown> {
  /** One line: what the program does and the `args` it reads. The script
   *  tool's description lists it. */
  readonly description: string;
  /** The tools its run is offered, by name. */
  readonly tools: readonly string[];
  /** How a completed run of it reads to whoever launched it. Without one,
   *  the run delivers its reply alone. */
  readonly result?: ProgramResult<R>;
  /** The files its run writes when its launch names none, for a program
   *  that creates documents (a deck, a transcript) and does not rewrite
   *  its inputs. */
  readonly outputs?: readonly string[];
  /** The `args` keys whose string values name a file the program reads. A
   *  launch a model asks for resolves each as it resolves the launch's
   *  file lists: a run-storage file must be the caller's own or a declared
   *  output of a completed child of it. */
  readonly fileArgs?: readonly string[];
}
```

## ProgramChange

One file a program wrote, as a script summary counts it.

```ts
interface ProgramChange {
  /** The workspace path the file replaces. */
  readonly path: string;
  /** The file the program wrote. */
  readonly absolutePath: string;
  /** The file it was diffed against, when it continues one: an earlier
   *  call's `absolutePath` continues that call's row. */
  readonly base: string | null;
  readonly added: number | null;
  readonly removed: number | null;
}
```

## ProgramResult

How a completed program run reads: to the launching model, and to a
script's summary of the files its calls wrote. What it reports is the
run's latest row of the plugin's own `fact` kind (`Plugin.factKinds`),
the one record of it; the program's return value is not read. The harness
reads the row only through these.

```ts
interface ProgramResult<R = unknown> {
  /** The plugin's row kind that records what the run did, and the schema
   *  its value decodes with. A completed run with no such row, or one that
   *  fails the schema, is delivered as an invalid result naming the issue,
   *  never shaped. */
  readonly fact: {
    readonly plugin: string;
    readonly kind: string;
    readonly schema: Schema.Codec<R, unknown>;
  };
  /** The delivery body inside the harness's own result envelope. */
  delivery(value: R, runId: RunId): readonly string[];
  /** The files the program wrote, in the order it wrote them (a document
   *  revised twice appears twice, the later entry its latest): the files a
   *  parent may read of its child's storage, and a script's summary. */
  changes(
    value: R,
    roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  ): readonly ProgramChange[];
}
```

## PromptRenderFailed

A prompt that did not render: the template's own error, or `nunjucks`
failing to load.

```ts
class PromptRenderFailed extends Schema.TaggedError<PromptRenderFailed>()(
  'PromptRenderFailed',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
)
```

## PromptSection

A plugin's section of each request's system text, rendered from the tool
names the request's step offers, whether the run is a child and its
workspace configuration ('' for none).

```ts
type PromptSection = (ctx: {
  readonly offered: readonly string[];
  readonly isChild: boolean;
  /** The run's workspace configuration, for a section that follows a
   *  setting of its plugin's. */
  readonly config: ConfigProvider;
}) => string;
```

## randomizedExponentialBackoff

```ts
function randomizedExponentialBackoff(base: Duration.Input)
```

## RefusalDecision

The arms that decline a request, whatever the provenance.

```ts
type RefusalDecision = Extract<
  RequestDecision,
  { action: 'reject' | 'deny' | 'cancel' }
>;
```

## renderPrompt

Render a prompt string using nunjucks templating.

- `@param` prompt The prompt template string
- `@param` variables Variables to use in template rendering
- `@returns` The rendered prompt; a template error fails with its message

```ts
const renderPrompt: (prompt: string, variables: Record<string, unknown>) => Effect<string, PromptRenderFailed, never>
```

## requestToolEditApproval

Ask the person for an edit when the session's policy, given what the
call's hooks said, asks: a `request.opened` on the run
that names the proposal's content (the original and proposed text with
their diff) by its address in the session's blob store, stored with the
row, so every process the request reaches shows the same diff
(`request.preview`); answered by a surface's `request.decide`, or by the
edit grant turned on meanwhile. An approve applies the file as the
person left it: the decision's content, else the proposal.

```ts
const requestToolEditApproval: (request: ToolEditProposal) => Effect<ToolEditApprovalResult, Error, ToolContext>
```

## resolveToolPath

Resolve a tool path, relative or absolute, against the call's working
directory when the run has one and its workspace folder otherwise.

A path that escapes that root is accepted only inside a registered external
root or with path protection switched off; otherwise it fails with a
`ToolError` the tool runner reports to the model. With no folder open and
no working directory, only an absolute path can resolve (the agent
directories are registered external roots).

`fsPath` is workspace-relative for a workspace path, so the confined
`WorkspaceFs` view answers it, and absolute for a working-directory or
outside path.

```ts
const resolveToolPath: (call: ToolPathCall, targetPath?: string | undefined) => Effect<ToolPathResolution, ToolError | StateReadFailed, never>
```

## retryTransientFetch

Run `request` under a per-attempt deadline, retrying only transient
failures (timeout, transport failure, 408/429, 5xx) with exponential
backoff and full jitter — the pattern every network-boundary tool (web
fetch/search, Loogle) repeats. Any other failure — a non-transient HTTP
status, a response-shape or size-limit failure reported by `request` — ends
the retry immediately and is the program's failure. Interruption stops both
the active attempt and the backoff sleep.

```ts
const retryTransientFetch: <T, E extends Error, R>(request: Effect<T, E, Scope | R>, options: RetryTransientFetchOptions<E>) => Effect<T, E | TimeoutError, Exclude<R, Scope>>
```

## RetryTransientFetchOptions

How {@link retryTransientFetch} retries: its retry count, base backoff,
per-attempt deadline and transient-failure observer.

```ts
interface RetryTransientFetchOptions<E> {
  /** Retries after the first attempt. */
  readonly retries: number;
  /**
   * Base backoff before the first retry; doubles per retry, then scaled by
   * a uniform factor in [1, 2) — see {@link randomizedExponentialBackoff}.
   */
  readonly minTimeout: number;
  /** Deadline for each attempt, connection and body read included. */
  readonly timeoutMs: number;
  /**
   * Observes each transient failure — the attempts the schedule may retry,
   * the last exhausted one included. A permanent failure ends the retry
   * unobserved, since it never had retries left to report.
   */
  readonly onFailedAttempt?: (
    error: E | Cause.TimeoutError,
    retriesLeft: number,
  ) => Effect.Effect<void>;
}
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

## RoutePolicy

One route a binding's calls go through: its key, and the scope of the
failures that cool it (llm's `ModelError.scope`).

```ts
interface RoutePolicy {
  readonly key: string;
  readonly scope: 'model' | 'route';
}
```

## runDirUnder

A run's directory under `storageRoot`.

```ts
function runDirUnder(storageRoot: string, id: RunId): string
```

## runEntryUnder

Inspect one run-relative entry of run `runId`'s storage under
`storageRoot` without following a workspace-mirror symlink, the entry's
own or an ancestor directory's.

```ts
const runEntryUnder: (storageRoot: string, runId: string & Brand<"RunId">, relativePath: string) => Effect<{ readonly kind: "file"; readonly location: { readonly kind: "runStorage"; readonly absolutePath: string; readonly relativePath: string; readonly runId: string & Brand<"RunId">; }; } | { readonly kind: "symlink" | "directory" | "unsupported"; readonly absolutePath: string; } | { readonly kind: "missing"; } | { kind: "invalid"; reason: string; }, PlatformError, FileSystem>
```

## RunHistoryInconsistent

```ts
class RunHistoryInconsistent extends Schema.TaggedError<RunHistoryInconsistent>()(
  'RunHistoryInconsistent',
  {
    reason: Schema.Literals([
      'out-of-order', // commits not strictly increasing, or a row before the row it needs
      'orphan-settlement', // a tool.result for no pending call
      'unknown-run-row', // an unrecognized type on the run aggregate
      'mismatched-delivery', // a delivering append does not match its response's results
      'unreadable-turn', // a stored turn this build of the package cannot parse
    ]),
    detail: Schema.String,
    commit: Schema.NullOr(CommitOrdinalSchema),
  },
)
```

## RunHistoryRefused

A refusal the run history itself decided. Database failures are kept OUT of
this type: reporting a disk error as a refused run is the silent-
degradation defect in a different costume, so `open` and `load` keep
them in their error channel beside it.

`reason` says why the run's stored rows cannot be used, the one thing a
reader asks of a refusal ({@link runReadRefusal}); a refused write that
says nothing about the stored rows has none, and its `detail` words it.
From where each comes:
- no reason: from `RunCell.append`. Either the session's log refused a
  closed target as `DatabaseAggregateClosed`, nothing written (never
  synthesised from any other write failure: a disk error stays a
  `DatabaseWriteFailed`; a loop that meets it mid-turn stops with it, no
  retry and no second write), or a durable origin in the batch is not a
  scheme, host and path alone, checked before anything is published.
- `unprepared-history`: `PreparedHistorySchema` over the history the batch
  assembles, at the write boundary of every batch that appends to or
  rewrites it, and on cold load.
- `inconsistent`: the rows cannot be applied; `cause` says why. From
  `load`, and from `RunCell.append` before it publishes: a batch is applied
  first and refused with nothing committed, because a published row the
  row handlers reject is a run no later `load` can read.
- `foreign-protocol`: from a resume's activation, before its rows: a turn
  the history replays was recorded on another protocol than the run's
  binding speaks now, so no request could replay it.
A violated `RunCell.append` precondition is a caller defect
(`Effect.die`), not a refusal: the loop must not handle it.

```ts
class RunHistoryRefused extends Schema.TaggedError<RunHistoryRefused>()(
  'RunHistoryRefused',
  {
    reason: Schema.optional(
      Schema.Literals([
        'unprepared-history',
        'inconsistent',
        'foreign-protocol',
      ]),
    ),
    runId: RunIdSchema,
    detail: Schema.String,
    cause: Schema.optional(RunHistoryInconsistent),
  },
)
```

## RunInbox

One run's input, as a plugin reaches it: what it sends the run (routed,
accepted and woken as {@link submitFollowUp} does), and when the run
takes no more.

```ts
interface RunInbox {
  /** Deliver `item` to the run. */
  readonly send: (
    item: InboxItem,
  ) => Effect.Effect<SubmitFollowUpResult, Error>;
  /** Hear the run take no more input, or its session's inbox close;
   *  returns the detach. */
  readonly onClosed: (listener: () => void) => () => void;
}
```

## RunStorageEntry

One run-relative entry of a run's storage, read without following a link.

```ts
type RunStorageEntry =
  | { readonly kind: 'file'; readonly location: RunStorageFileLocation }
  | {
      readonly kind: 'symlink' | 'directory' | 'unsupported';
      readonly absolutePath: string;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid'; readonly reason: string };
```

## scopedClient

The process client for one attempt under {@link withRequestTimeout}: the
attempt's scope aborts its requests. Every tool request takes its client
from here or {@link scopedOkClient}.

```ts
const scopedClient: Effect<With<HttpClientError, Scope>, never, HttpClient>
```

## scopedOkClient

{@link scopedClient} where a non-2xx status fails with a `StatusCodeError`.

```ts
const scopedOkClient: Effect<With<HttpClientError, Scope>, never, HttpClient>
```

## Secrets

The process's secret store as an Effect service, provided once by the composition root through
`processLayer`. The shape is the port itself: a program that reads
or writes a credential yields the store's own Effect and matches
{@link SecretsFailed}.

Both layers also serve the store's `SubscriptionAccounts`, built with it:
a program that reads a subscription session reads it from the store in
force, and a layer that provides another store provides its accounts.

`layer` takes a store built before the runtime (an embedder's, a test's):
the service is that value, not a thunk resolved per member call.

```ts
class Secrets extends Context.Service<Secrets, PlatformSecrets>()(
  '@texra-ai/harness/platform/Secrets',
)
```

## SESSION_CLOSE_DEADLINE_MS

The budget one session close spends waiting for its runs to end before it
reports the ones still live abandoned (`SessionOwner.close`). A hung run
must not wedge desktop quit, eat the extension's ~5s deactivate budget, or
stall a CLI SIGTERM indefinitely. The closes of a process's sessions start
together, so they finish under one deadline for the process, not one each.

```ts
const SESSION_CLOSE_DEADLINE_MS: 5000
```

## SessionPluginLayer

A plugin's session-lifetime services (its `sessionLayer`): one build
per open session, up while the plugin is switched on, a step of that
session pins it, or work it started holds it (`PluginHold`), and closed
with the session. It reads no run: a plugin reaches runs through its
tools' `ChildRuns`.

```ts
type SessionPluginLayer = Layer.Layer<never, never, PluginHold>;
```

## Settings

Every read and write of a setting; see the module comment.

```ts
const Settings: Readonly<{ readonly get: <A>(stores: SettingsStores, row: SettingRow<A>) => Effect<A, StateReadFailed, never>; readonly inspect: <A>(stores: SettingsStores, row: SettingRow<A>) => Effect<StoredSetting<A>, StateReadFailed, never>; readonly getConfig: <A>(config: ConfigProvider, row: SettingRow<A>) => A; readonly defaultOf: <A>(catalog: SettingsCatalog, row: SettingRow<A>) => A; readonly set: <A>(stores: SettingsStores, row: SettingRow<A>, value: A, target?: ConfigTarget | undefined) => Effect<void, Error | ConfigWriteFailed, never>; readonly reset: (stores: SettingsStores, row: SettingRow<unknown>, target?: ConfigTarget | undefined) => Effect<void, Error | ConfigWriteFailed, never>; readonly state: <A>(store: Pick<StateStore, "get">, key: StateKey<A>) => Effect<A, StateReadFailed, never>; }>
```

## SettingsStores

The setting slots a caller holds: a `WorkspaceRoots` is one.

```ts
interface SettingsStores {
  readonly config: ConfigProvider;
  readonly workspaceState: StateStore;
  readonly repoState: StateStore;
  readonly globalState: StateStore;
}
```

## sourceLocationUnder

Where a path a run reads from lives, under the roots its caller holds: a
file in run storage keeps its run's provenance, anything else is its
workspace or external location.

```ts
function sourceLocationUnder(
  roots: { readonly storage: string; readonly workspace: string | undefined },
  inputPath: string,
): FileLocation
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
finish after commit. A change that depends on current values goes through
`modify`, never a `get` then an `update`: the settings surfaces do not
serialize their messages, and hosts in separate processes share one store.

```ts
interface StateStore {
  get(key: string): Effect.Effect<unknown, StateReadFailed>;
  update(key: string, value: unknown): Effect.Effect<void, StateWriteFailed>;
  /**
   * Read-modify-write of `keys` as one step at the store's authority:
   * `change` sees their stored values and answers its result with the next
   * value of every key (`undefined` deletes it), with its result alone to
   * write nothing, or refuses with its own error and nothing is written.
   */
  modify<K extends string, A, E = never>(
    keys: readonly K[],
    change: (
      current: Readonly<Record<K, unknown>>,
    ) => Result.Result<
      readonly [A] | readonly [A, Readonly<Record<K, unknown>>],
      E
    >,
  ): Effect.Effect<A, E | StateWriteFailed>;
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

## StepRoot

A read-only directory one step accepts for its own calls, beside the
registered roots: a skill it lists or its user activated, canonical as
its catalog entry records it (`canonicalizePath`).

```ts
interface StepRoot {
  readonly absolutePath: string;
  readonly label: string;
}
```

## StorageFs

The session's own storage root (under the process's storage directory).

```ts
class StorageFs extends Context.Service<StorageFs, RootedFileSystem>()(
  '@texra-ai/harness/platform/StorageFs',
)
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

## StreamHandle

Handle returned by `openStream` — append chunks then finalize.

```ts
interface StreamHandle {
  readonly id: string;
  /** Append a chunk of text; emits `stream.chunk`. */
  append(text: string): void;
  /**
   * Close the stream and emit its complete text in `stream.end`. Idempotent.
   * Returns that text to the caller as well.
   */
  finalize(finalText?: string): string;
}
```

## SubmitFollowUpResult

Three outcomes: the input reached a running loop, it waits in the run's
queue for its next turn (the resume the send started, or an explicit
one), or it was not accepted, with the words that say why. A delivery the
acceptance boundary had already accepted is `sent`. A resume the input
started that the run refused is told by the resume itself.

```ts
type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued' }
  | { status: 'failed'; message: string };
```

## ToolAvailabilityChecks

How a plugin with an external dependency answers "is it available": one
check returns availability and its dashboard explanation from the same
observations. The availability layer owns caching, refresh and deadlines.

```ts
interface ToolAvailabilityChecks<R = ToolProbeServices> {
  /**
   * Check the asking workspace and return its availability with an optional
   * short badge and explanation. A failed optional detail belongs here:
   * log its cause and retain the availability already established.
   */
  readonly check: (inputs: ToolProbeInputs) => Effect.Effect<
    {
      readonly available: boolean;
      readonly statusLabel?: string;
      readonly statusDetail?: string;
    },
    ToolProbeError,
    R
  >;
  /**
   * The secret-store keys this plugin's answer reads. A committed write to any
   * of them (`credentialChanged`) re-probes every open workspace, so a plugin
   * gated on a credential declares it here instead of each host naming it.
   */
  readonly reprobeOnSecrets?: readonly string[];
}
```

## ToolCardHandle

Handle returned by `openToolCard`: one tool call's card, for a caller that
runs the call outside the run loop (an external agent's own tools).

```ts
interface ToolCardHandle {
  /** The log the card last showed. */
  readonly log: ToolUseLog;
  /**
   * Show the call's latest log: an `in_progress` status keeps the card open,
   * any other closes it, and a log without a status closes it as completed.
   */
  update(log: ToolUseLog): void;
  /**
   * Close the card as failed if it is still open, keeping what it last
   * showed: the caller's turn ended before the call reported. A closed card
   * is left as it closed.
   */
  failIfOpen(): void;
}
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

## ToolContext

The tool call the running tool serves.

```ts
class ToolContext extends Context.Service<
  ToolContext,
  ToolContextShape
>()('@texra-ai/harness/agent/ToolContext')
```

## ToolContextShape

What every tool call knows of itself.

```ts
interface ToolContextShape {
  /** The call's id, as the model (or the host) issued it. */
  readonly callId: string;
  /** Where the call works. */
  readonly env: ToolEnv;
  /** Where the call's requests to a person open. */
  readonly requests: CallRequests;
  /** Transient output for the call's card while it runs, never a row. */
  readonly emit: (text: string) => void;
}
```

## ToolEditApprovalResult

`appliedContent` is required on acceptance: the proposed file as the user
left it (the decision's `content`), else the proposal itself, so this is a
type-level guarantee rather than a convention callers must null-check.

```ts
type ToolEditApprovalResult =
  | {
      readonly action: 'apply';
      readonly appliedContent: string;
      /** The reviewed base, used to reconcile changes made while waiting. */
      readonly originalContent: string | null;
      /** The reviewed proposal, before any edits made in the approval view. */
      readonly proposedContent: string;
      readonly lineChanges?: {
        readonly added: number;
        readonly removed: number;
      };
      readonly startLine?: number;
    }
  | RefusalDecision;
```

## ToolEditProposal

What a tool proposes; {@link requestToolEditApproval} derives the rest:
the diff a host shows (hunks, the first changed line), computed once, and
the permission every surface lists.

```ts
interface ToolEditProposal {
  readonly path: string;
  /** Null when the file did not exist when this edit was proposed. */
  readonly originalContent: string | null;
  readonly proposedContent: string;
  readonly sourceTool: string;
}
```

## ToolEnv

Where a call works: the session's roots (its workspace folder, the
setting slots and its storage), the run's working directory, and the
read-only roots the call's step accepts (the skills it lists or its user
activated). A tool's paths resolve against it.
`workingDirectory` is already absolute or absent: the run decides it once
where it is launched (`buildAgentLaunchContext`).

```ts
interface ToolEnv {
  readonly roots: WorkspaceRoots;
  readonly workingDirectory?: string;
  readonly stepRoots?: readonly StepRoot[];
  /** The run the call works for. */
  readonly run: ToolRun;
}
```

## ToolError

A tool's own failure: the model reads `message` as the failed call's
result. Tagged, so a caller can recover it with `Effect.catchTag` and a
generator can `yield*` it directly.

```ts
class ToolError extends Data.TaggedError('ToolError')<{
  readonly message: string;
  /** Brief human-facing summary carried through to the ToolResult, when set. */
  readonly summary?: string;
  readonly cause?: unknown;
}>
```

## ToolFileAttachment

```ts
type ToolFileAttachment = typeof ToolFileAttachmentSchema.Type;
```

## ToolGuard

The guard the run loop applies before a tool's body runs, declared on the
tool instead of called inside it: the paths the call writes and the command
it must get approved. The run loop is the one place either is checked,
so no tool body re-checks its own roots or asks for the
command's approval; a tool whose body asks its own question declares
`requiresApproval: 'inBody'` (below).

```ts
interface ToolGuard<T> {
  /**
   * The paths this call writes, read from its arguments. Each is resolved
   * against the call's workspace and working directory — which refuses a path
   * outside either — and refused when it lands in a read-only external root.
   */
  readonly writes?: (input: T) => readonly string[];
  /**
   * The command this call runs. Present: the loop puts it through the
   * session's command approval before the body runs.
   */
  readonly command?: {
    /** The command as the approval prompt shows it. */
    readonly text: (input: T) => string;
    /**
     * The standing grant that answers this tool's commands. `'bash'`: the
     * run's command grant ("approve all commands in this task"), which the
     * shell declares. Omitted: each call is asked about and only the
     * delegated-work grant covers it, so a tool whose prompt looks like a
     * command (an MCP tool, codex) never inherits shell permission.
     */
    readonly grant?: 'bash';
    /**
     * Where the approved command actually runs, when that is not the call's
     * own directory. Omitted: the call's working directory, else the
     * workspace, which is what a shell-shaped tool uses. `'unknown'`: the
     * executor cannot name one, so the prompt names none rather than a
     * directory the command may not run in (`send_to_terminal` reuses a
     * terminal whose shell has its own directory).
     */
    readonly cwd?: 'unknown';
  };
}
```

## ToolPathCall

The call fields a tool path resolves against: the session's roots (its
workspace folder and the setting slots containment policy is read from),
the run's working directory, and the read-only roots the call's step
accepts (the skills it lists or its user activated; none outside a run).
A tool's `ToolContext.env` satisfies it structurally.
`workingDirectory` is already absolute or absent: the run decides it once
where it is launched (`buildAgentLaunchContext`).

```ts
interface ToolPathCall {
  readonly roots: { readonly workspace: string | undefined } & SettingsStores;
  readonly workingDirectory?: string;
  readonly stepRoots?: readonly StepRoot[];
}
```

## ToolPathResolution

A resolved tool path plus the POSIX form a tool shows for it.

```ts
interface ToolPathResolution extends WorkspacePathResolution {
  readonly display: string;
}
```

## ToolPolicy

Immutable per-run tool policy, resolved by the launch and read from the
run's `AgentRun` service.

A readonly value the loop takes from context, with no ambient frame
anywhere beneath it — the property an SDK embedder wants.

```ts
interface ToolPolicy {
  /** Stop a tool-use run after one model/tool cycle instead of waiting.
   *  Whether a later turn can still reach the run is read off this and the
   *  launch's parent edge. */
  readonly stopAfterCycle?: boolean;
}
```

## ToolProbeError

What a plugin's availability callbacks may fail with.

```ts
type ToolProbeError = ToolProbeFailed | SecretsFailed;
```

## ToolProbeFailed

The one failure of this module's probes: the native binary lookup a CLI's
probe runs could not answer. An SDK that will not import is a dashboard
message, not a failure; a localhost request a probe makes folds its own
failures to `false`; and a tool that is simply not installed is
`check` answering `false`.

```ts
class ToolProbeFailed extends Schema.TaggedError<ToolProbeFailed>()(
  'ToolProbeFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
)
```

## ToolProbeInputs

The asking workspace, carried into a plugin's probe as data rather than read
from an ambient scope: the folder a probe asks whether it is a git
repository and the configuration a probe reads a port from: two fields of
the roots every caller of the availability surface opened.

```ts
type ToolProbeInputs = Pick<WorkspaceRoots, 'workspace' | 'config'>;
```

## ToolProbeServices

The process services a plugin's availability callbacks read: provider
credentials, the HTTP client a localhost probe requests through, the
spawner every probe runs its child processes on, and the filesystem the
CLI binary probes look in. All four are `ProcessServices` arms, so every
caller of the availability surface already holds them. A plugin's probe
may also read its own process services (`definePlugin`), which it is
served while its layer is up; what its host passes it (an editor's
extensions) it closes over.

```ts
type ToolProbeServices =
  | Secrets
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ChildProcessSpawner;
```

## ToolRegistry

The process's plugin table, which every run's offered tools come from.

```ts
class ToolRegistry extends Context.Service<ToolRegistry, ToolTable>()(
  '@texra-ai/harness/tools/ToolRegistry',
)
```

## ToolResult

```ts
type ToolResult = typeof ToolResultSchema.Type;
```

## ToolRun

What a tool reads of the run its call works for, read from the run rather
than copied onto the call: exactly the fields the app's tools read. Its
id, policy, configuration (which holds its delegation scope), model,
scope (a tool that starts something the run should stop registers that
stop there) and trace (what a plugin's own stages nest under). Never its
session: a plugin reaches the session's runs through `ChildRuns`, and
shows the person something through its call's `requests.present`.
What only the harness's built-in tools read stays internal.

```ts
interface ToolRun {
  readonly runId: RunId;
  readonly toolPolicy: ToolPolicy;
  /** The parent this activation runs under (null for a root), and
   *  whether the parent's call awaits it: with the policy, what
   *  `noLaterTurn` reads. */
  readonly entry: {
    readonly parent: RunId | null;
    readonly awaited: boolean;
  };
  readonly config: AgentConfig;
  readonly model: ScopedRef.ScopedRef<BoundModel>;
  readonly scope: Scope.Scope;
  readonly logger: AgentTrace;
}
```

## ToolTable

The process's plugins by plugin id: what each contributes (its tools,
prompt section and layers) is read off its value.

```ts
interface ToolTable {
  /** Every plugin, in the order the app listed them. */
  readonly entries: ReadonlyMap<string, Plugin>;
  /** The tool registered under `name` in any plugin, typed as plugins
   *  declare their tools (`Plugin.tools`). */
  readonly get: (name: string) => ITool<Error, PluginToolServices> | undefined;
  /** The programs the plugins register, by name (`Plugin.programs`). */
  readonly programs: ReadonlyMap<string, Program>;
  /** The row kinds the plugins own, by `plugin/kind` (`Plugin.factKinds`):
   *  what a store opened in this process reads. */
  readonly factKinds: FactKinds;
}
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

## web

The web: `web_search` and `web_fetch`.

```ts
const web: Plugin
```

## withLogChannel

Name the channel every `Effect.log*` inside `self` belongs to. Annotations
nest, so a callee that names its own channel keeps it: this sets the channel
for the entries that don't.

```ts
const withLogChannel: (channel: string) => <A, E, R>(self: Effect<A, E, R>) => Effect<A, E, R>
```

## withRequestTimeout

One request under a deadline of `timeoutMs` that spans the whole of
`request` — connection and body read. The attempt's scope stays open
through the body read, so the request (see {@link scopedOkClient}) aborts
when the whole attempt ends. Fails with `Cause.TimeoutError` on the deadline
and otherwise with the request's own failure. Defects and interruption are
not converted into request failures.

```ts
const withRequestTimeout: <T, E, R>(timeoutMs: number, request: Effect<T, E, Scope | R>) => Effect<T, E | TimeoutError, Exclude<R, Scope>>
```

## WorkspaceFs

The workspace folder the session works on.

```ts
class WorkspaceFs extends Context.Service<
  WorkspaceFs,
  RootedFileSystem
>()('@texra-ai/harness/platform/WorkspaceFs')
```

## WorkspacePathResolution

A tool path resolved against the call's roots: its root-relative and
absolute spellings, the path filesystem calls take, and the external root
it falls in, if any.

```ts
interface WorkspacePathResolution {
  readonly relative: string;
  readonly absolute: string;
  /**
   * The path to pass to filesystem operations.
   * Absolute when operating outside the workspace (e.g. a worktree),
   * workspace-relative otherwise.
   */
  readonly fsPath: string;
  /**
   * When the resolved path falls inside a registered external root, this
   * describes that root (label, writable flag). Undefined for workspace paths
   * and for any external path outside the allowlist.
   */
  readonly external?: {
    readonly root: string;
    readonly writable: boolean;
    readonly label: string;
  };
}
```

## WriteFilter

What an app does to the content `write_file` is given before it proposes
it, by path, under the call's workspace configuration (text replacements
for a file type, say). The harness's `write_file` writes what it is given.

```ts
type WriteFilter = (
  path: string,
  content: string,
  config: ConfigProvider,
) => Effect.Effect<string>;
```
