# `@texra-ai/harness/host`

<!-- Generated from `packages/harness/src/host.ts` by `npm run docgen`; do not edit. -->

`@texra-ai/harness/host`: what a full application host composes beyond
the root entry. TeXRA's editor extension, desktop app and terminal app
read it; an embedder that runs agents from a program needs none of it.

It holds the process layer a host builds once (`processLayer`), the
services a host serves its views from (agent catalog, skills, installed
plugins, model options, tool availability, storage maintenance), the
presenters of the root's `HostInteractions`, and the helpers the hosts
share for files, errors and logs.

No signature on another entry names a type that only this one exports,
with one exception: the requirement unions `RunServices` and
`PlatformServices`, which list the services a host process serves and
which a plugin passes through without naming a member.

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
disabled-plugin switch is read from, and the plugin table whose switched
plugins' bundled agent directories are scanned.

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
   * Rescan every source, after every older load has finished, and publish
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
  /** Make a custom copy of `entry` (see {@link AgentCustomization}):
   *  the copy's path. */
  readonly customize: (
    entry: AgentEntry,
    change: AgentCustomization,
  ) => Effect.Effect<
    { readonly path: string },
    | AgentCustomizeRefused
    | AgentDirectoriesFailed
    | StateReadFailed
    | PlatformError.PlatformError
  >;
  /**
   * Keep the custom agent `name` and dismiss its newer-built-in notice: its
   * copy is re-stamped with the changed bundled version. Refused when the
   * catalog holds no such custom agent (`noFile`) or its bundled version has
   * not changed (`current`). The copy's path.
   */
  readonly keepCustom: (
    name: string,
  ) => Effect.Effect<
    { readonly path: string },
    | AgentCustomizeRefused
    | AgentDirectoriesFailed
    | StateReadFailed
    | PlatformError.PlatformError
  >;
}
```

## AgentCustomization

A custom copy of an agent: `copy` writes a new one into the custom
directory, stamped with the bundled file's digest (`basedOn`), and is
refused when one is there; `overwrite` replaces it.

```ts
type AgentCustomization = 'copy' | 'overwrite';
```

## AgentCustomizeRefused

`customize`, `keepCustom` or `removeCustom` refused the change: the entry
has no file of its own to copy, keep or delete (`noFile`), its copy or the file to delete
would lie outside the custom directory (`escapes`), a copy is already
there (`exists`, at `path`), or a copy has no newer bundled version
to keep (`current`).

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
an entry that exists can launch. Every entry is a persona.

```ts
interface AgentEntry {
  name: string;
  source: CatalogAgentSource;
  path: string; // absolute path to the definition file
  description?: string;
  /** Digest of the definition file; absent on a plugin agent. */
  digest?: string;
  /** A customized copy's `basedOn`: the bundled file's digest it began from. */
  basedOn?: string;
  /** The model agent the entry names. */
  persona: Persona;
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

No agent answers to `agent` in the finished catalog, rescanned once:
the catalog's own answer, which a launch turns into its refusal
({@link missingAgentRefusal}) and every other reader reads as "not found".

```ts
class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  'AgentNotFound',
  { agent: Schema.String, message: Schema.String },
)
```

## agentToolNames

The names of the tools `entry`'s persona is offered.

```ts
const agentToolNames: (entry: Pick<AgentEntry, "persona">) => readonly string[]
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

## AvailabilityResults

Each workspace root's last results (`undefined` = no folder open); a root
no probe has answered for yet is absent.

```ts
type AvailabilityResults = ReadonlyMap<
  string | undefined,
  readonly ExternalToolCheckResult[]
>;
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

## CUSTOM_AGENT_DIR_KEY

The custom agent directory the user configured, trimmed; empty when none is
(the host then uses its default directory).

```ts
const CUSTOM_AGENT_DIR_KEY: { readonly key: "customAgentDir"; readonly slot: "globalState"; readonly schema: withDecodingDefault<Trim, never>; }
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
view, for as long as the view lists it. A program holds its request (a
decision, a preview, a staged card) by ending with `Effect.never`, and
releases it in a finalizer, which runs once the view drops the request,
however it was decided. One that returns runs again on the next view that
still lists its request, an event that may not come: a program that must
try again does so on its own schedule.

```ts
const followPendingRequests: <P extends PendingRequest, R>(view: { readonly changes: Stream<{ readonly key: string; readonly runs: ReadonlyMap<string & Brand<"RunId">, { readonly id: string & Brand<"RunId">; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly label: string; readonly description: string | null; readonly title: string; readonly model: string | null; readonly modelLabel: string | null; readonly command: string | null; readonly inputFiles: readonly string[]; readonly agentScope: readonly string[] | null; readonly facts: { readonly [x: string & Brand<"FactName">]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly worktree: { readonly workingDirectory: string; } | null; readonly position: "waiting" | "ready" | "running"; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly holder: "here" | "none"; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly statusNotice: { readonly kind: "earlierBuild" | "damaged"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly createdAt: number; readonly launchedAt: number; readonly runStartedAt: number | null; readonly lastTimestamp: number; readonly turn: number | null; readonly takesFollowUps: boolean; readonly queuedFollowUps: readonly { readonly followUpId: string; readonly text: string; }[]; readonly grants: { readonly own: { readonly bash?: "parent" | "on" | "off" | undefined; readonly toolEdit?: "parent" | "on" | "off" | undefined; readonly superYolo?: "parent" | "on" | "off" | undefined; }; readonly goal: readonly ("bash" | "toolEdit" | "superYolo")[]; readonly limit?: "never" | "ask" | undefined; }; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly parentId: (string & Brand<"RunId">) | null; readonly launch: { readonly id: string & Brand<"RunId">; readonly card: string | null; } | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; readonly kinds: { readonly agent: number; readonly process: number; readonly script: number; }; }; readonly approval: "own" | "none" | "descendant"; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly latestLine: string | null; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly sectionCount: number; readonly tally: { readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments: readonly ("image" | "document")[]; readonly media: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[]; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | "model" | "provider" | "requestId" | "operation" | "statusCode" | "statusText" | "rawMessage"; readonly value: string; }[]; readonly failure?: { readonly source: "model"; readonly message: string; readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly status?: number | undefined; readonly provider?: string | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; } | { readonly source: "route"; readonly message: string; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; } | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: "in_progress" | "completed" | "failed"; readonly label: string; })[]; readonly output: { readonly kind: "shown"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; } | { readonly kind: "empty"; } | { readonly kind: "withheld"; readonly reason: ToolOutputSuppression; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; }; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showsNoOutputMarker: boolean; readonly status?: ToolRowStatus | undefined; readonly isUserFeedback: boolean; readonly timeoutMs?: number | undefined; readonly exitCode?: number | undefined; }; readonly log: { readonly toolName: string; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly summary?: string | undefined; readonly input?: unknown; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; readonly result?: { readonly status: "executed"; readonly value?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; readonly files?: readonly { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; readonly path: string; readonly mimeType: string; readonly description?: string | undefined; readonly digest?: string | undefined; }[] | undefined; readonly output?: string | undefined; readonly summary?: string | undefined; readonly endTurn?: boolean | undefined; readonly edits?: readonly { readonly path: string; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; readonly startLine?: number | undefined; }[] | undefined; readonly reads?: readonly string[] | undefined; readonly reuseKey?: string | undefined; readonly reusedFrom?: string | undefined; readonly userInstruction?: string | undefined; } | { readonly status: "error"; readonly error: string; readonly name?: string | undefined; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; } | undefined; }; readonly section?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly finalThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; readonly replaced?: number | undefined; }; readonly label: string; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly stages: readonly { readonly id: string; readonly name: string; readonly seqNo: number; readonly startTime: number; readonly end: { readonly outcome: "completed" | "failed" | "cancelled"; readonly at: number; } | null; }[]; readonly finalRows: number; }; readonly program: string | null; }>; readonly order: readonly (string & Brand<"RunId">)[]; readonly cursor: number; readonly debug: boolean; readonly transcriptSeq: ReadonlyMap<string & Brand<"RunId">, number>; readonly rollup: { readonly running: number; readonly waiting: number; readonly interrupted: number; }; readonly requests: readonly { readonly runId: string & Brand<"RunId">; readonly requestId: string; readonly payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; readonly content: string; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "pluginTrust"; readonly data: { readonly plugin: string; readonly path: string; readonly skills: number; readonly requestId: string; readonly digest: string; readonly runId: string & Brand<"RunId">; readonly programs: readonly string[]; readonly servers: readonly string[]; readonly review: readonly string[]; readonly version?: string | undefined; readonly native?: { readonly description: string; readonly provides: readonly string[]; } | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly operation: string; readonly failure: { readonly source: "model"; readonly message: string; readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly status?: number | undefined; readonly provider?: string | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; } | { readonly source: "route"; readonly message: string; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; }; readonly runId: string & Brand<"RunId">; readonly credentialSwitch: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null; readonly model?: string | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | undefined; readonly agentSource?: { readonly kind: "custom" | "builtIn" | "plugin"; } | { readonly kind: "inline"; readonly persona: { readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; }; } | undefined; readonly rootUserInstruction?: string | undefined; readonly options?: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; }; readonly answeredBy: "bash" | "toolEdit" | "superYolo" | "person"; }[]; }, never, never>; }, select: (view: { readonly key: string; readonly runs: ReadonlyMap<string & Brand<"RunId">, { readonly id: string & Brand<"RunId">; readonly identity: { readonly kind: "agent"; readonly agent: string; readonly tool?: string | undefined; } | { readonly kind: "process"; readonly tool: string; } | { readonly kind: "script"; readonly title: string; }; readonly label: string; readonly description: string | null; readonly title: string; readonly model: string | null; readonly modelLabel: string | null; readonly command: string | null; readonly inputFiles: readonly string[]; readonly agentScope: readonly string[] | null; readonly facts: { readonly [x: string & Brand<"FactName">]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; }; readonly worktree: { readonly workingDirectory: string; } | null; readonly position: "waiting" | "ready" | "running"; readonly outcome: "completed" | "failed" | "cancelled" | null; readonly holder: "here" | "none"; readonly output: { readonly files: readonly string[]; readonly response: string; readonly structured?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; } | null; readonly statusNotice: { readonly kind: "earlierBuild" | "damaged"; } | { readonly kind: "lost"; readonly message: string; } | null; readonly lost: string | null; readonly createdAt: number; readonly launchedAt: number; readonly runStartedAt: number | null; readonly lastTimestamp: number; readonly turn: number | null; readonly takesFollowUps: boolean; readonly queuedFollowUps: readonly { readonly followUpId: string; readonly text: string; }[]; readonly grants: { readonly own: { readonly bash?: "parent" | "on" | "off" | undefined; readonly toolEdit?: "parent" | "on" | "off" | undefined; readonly superYolo?: "parent" | "on" | "off" | undefined; }; readonly goal: readonly ("bash" | "toolEdit" | "superYolo")[]; readonly limit?: "never" | "ask" | undefined; }; readonly context: { readonly inputTokens: number; readonly contextWindow: number; readonly utilizationPercent: number; } | null; readonly parentId: (string & Brand<"RunId">) | null; readonly launch: { readonly id: string & Brand<"RunId">; readonly card: string | null; } | null; readonly forkedFrom: { readonly id: string & Brand<"RunId">; readonly at: number; } | null; readonly forkPoint: number | null; readonly ancestors: readonly { readonly id: string & Brand<"RunId">; readonly label: string; }[]; readonly childIds: readonly (string & Brand<"RunId">)[]; readonly rollup: { readonly total: number; readonly running: number; readonly finished: number; readonly kinds: { readonly agent: number; readonly process: number; readonly script: number; }; }; readonly approval: "own" | "none" | "descendant"; readonly actions: readonly ("fork" | "files" | "compact" | "stop" | "copy" | "grant" | "resume" | "runAgain" | "delete" | "rename" | "openRunStorage" | "export")[]; readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly treeUsage: { readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; }; readonly thinkingActive: boolean; readonly compactingActive: boolean; readonly latestLine: string | null; readonly transcript: { readonly rows: readonly ({ readonly kind: "thinking" | "assistant"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly streaming: boolean; readonly cut?: "length" | "content-filter" | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "user"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly scriptSummary?: { readonly name: string; readonly outcome: "completed" | "failed" | "stopped"; readonly sectionCount: number; readonly tally: { readonly ok: number; readonly failed: number; readonly cancelled: number; readonly skipped: number; }; readonly costUsd: number; readonly durationMs: number; readonly files: readonly { readonly path: string; readonly added: number | null; readonly removed: number | null; }[]; readonly errorCause: string | null; } | undefined; readonly attachments: readonly ("image" | "document")[]; readonly media: readonly { readonly mimeType: string; readonly digest: string; readonly name: string; }[]; readonly forkAt?: number | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "error"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly details: readonly { readonly key: "message" | "model" | "provider" | "requestId" | "operation" | "statusCode" | "statusText" | "rawMessage"; readonly value: string; }[]; readonly failure?: { readonly source: "model"; readonly message: string; readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly status?: number | undefined; readonly provider?: string | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; } | { readonly source: "route"; readonly message: string; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; } | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "tool"; readonly model: { readonly headerLabel: string; readonly headerPreview: string; readonly sections: readonly ({ readonly kind: "text"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly label: string; } | { readonly kind: "code"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly language: string; readonly label: string; } | { readonly kind: "identifier"; readonly value: string; readonly note?: string | undefined; readonly label: string; } | { readonly kind: "file"; readonly path: string; readonly startLine?: number | undefined; readonly endLine?: number | undefined; readonly namespace: ToolFileNamespace; readonly label: string; } | { readonly kind: "fileGroups"; readonly groups: readonly { readonly label: string; readonly files: readonly string[]; readonly clickable: boolean; }[]; readonly label: string; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly from?: string | undefined; readonly note?: string | undefined; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; }[]; readonly label: string; } | { readonly kind: "diff"; readonly oldText: string; readonly newText: string; readonly fileLabel?: string | undefined; readonly label: string; } | { readonly kind: "badges"; readonly badges: readonly string[]; readonly label: string; } | { readonly kind: "status"; readonly status: "in_progress" | "completed" | "failed"; readonly label: string; })[]; readonly output: { readonly kind: "shown"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; } | { readonly kind: "empty"; } | { readonly kind: "withheld"; readonly reason: ToolOutputSuppression; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; }; readonly errorPreview?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly userInstruction?: { readonly lineCount: number; readonly full: string; readonly oneLine: string; } | undefined; readonly showsNoOutputMarker: boolean; readonly status?: ToolRowStatus | undefined; readonly isUserFeedback: boolean; readonly timeoutMs?: number | undefined; readonly exitCode?: number | undefined; }; readonly log: { readonly toolName: string; readonly card?: { readonly title: string; readonly sections: readonly ({ readonly kind: "text"; readonly label: string; readonly text: string; } | { readonly kind: "status"; readonly label: string; readonly status: "in_progress" | "completed" | "failed"; } | { readonly kind: "identifier"; readonly label: string; readonly value: string; } | { readonly kind: "badges"; readonly label: string; readonly badges: readonly string[]; } | { readonly kind: "fileList"; readonly label: string; readonly files: readonly { readonly path: string; readonly note?: string | undefined; }[]; })[]; } | undefined; readonly status?: "in_progress" | "completed" | "failed" | undefined; readonly error?: string | undefined; readonly output?: unknown; readonly summary?: string | undefined; readonly input?: unknown; readonly userInstruction?: string | undefined; readonly exitCode?: number | undefined; readonly result?: { readonly status: "executed"; readonly value?: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; readonly files?: readonly { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null | undefined; readonly path: string; readonly mimeType: string; readonly description?: string | undefined; readonly digest?: string | undefined; }[] | undefined; readonly output?: string | undefined; readonly summary?: string | undefined; readonly endTurn?: boolean | undefined; readonly edits?: readonly { readonly path: string; readonly lineChanges?: { readonly added: number; readonly removed: number; } | undefined; readonly startLine?: number | undefined; }[] | undefined; readonly reads?: readonly string[] | undefined; readonly reuseKey?: string | undefined; readonly reusedFrom?: string | undefined; readonly userInstruction?: string | undefined; } | { readonly status: "error"; readonly error: string; readonly name?: string | undefined; readonly summary?: string | undefined; readonly userInstruction?: string | undefined; } | undefined; }; readonly section?: string | undefined; readonly attempt?: number | undefined; readonly cutByRunEnd?: true | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "webSearch"; readonly query?: string | undefined; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "fileList"; readonly files: readonly { readonly path: string; readonly ok: boolean; readonly media?: { readonly kind: "image"; readonly mimeType: string; readonly sizeBytes: number; } | { readonly kind: "audio"; readonly mimeType: string; readonly sizeBytes: number; } | undefined; readonly sourceDisplay?: string | undefined; readonly varName?: string | undefined; }[]; readonly summary: string; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "contextManagement"; readonly data: { readonly action: "max_tokens_reduced"; readonly contextWindow: number; readonly tokensBefore: number; readonly utilizationBefore: number; readonly originalMaxTokens: number; readonly reducedMaxTokens: number; readonly details?: string | undefined; }; readonly label: string; readonly items: readonly { readonly key: string; readonly label: string; readonly value: string; }[]; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "progressStatus"; readonly summary: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "compactionActivity"; readonly block: { readonly operationId: string; readonly status: CompactionActivityStatus; readonly finalized: boolean; readonly finalThroughSeqNo?: number | undefined; readonly startPosition: number; readonly startedAt: number; readonly freed?: { readonly tokens: number; readonly utilizationBefore: number; readonly utilizationAfter: number; } | undefined; readonly replaced?: number | undefined; }; readonly label: string; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; } | { readonly kind: "log"; readonly text: { readonly lineCount: number; readonly full: string; readonly oneLine: string; }; readonly id: string; readonly seqNo: number; readonly finalSeqNo?: number | undefined; readonly timestamp: number; readonly level: "error" | "warn" | "info" | "debug"; readonly verbose?: boolean | undefined; readonly stageId?: string | undefined; readonly messageType?: "fileList" | "error" | "thinking" | "toolUse" | "webSearch" | "modelResponse" | "userMessage" | "progressStatus" | "contextCompactionActivity" | "contextManagement" | "default" | undefined; readonly origin?: "local" | undefined; })[]; readonly stages: readonly { readonly id: string; readonly name: string; readonly seqNo: number; readonly startTime: number; readonly end: { readonly outcome: "completed" | "failed" | "cancelled"; readonly at: number; } | null; }[]; readonly finalRows: number; }; readonly program: string | null; }>; readonly order: readonly (string & Brand<"RunId">)[]; readonly cursor: number; readonly debug: boolean; readonly transcriptSeq: ReadonlyMap<string & Brand<"RunId">, number>; readonly rollup: { readonly running: number; readonly waiting: number; readonly interrupted: number; }; readonly requests: readonly { readonly runId: string & Brand<"RunId">; readonly requestId: string; readonly payload: { readonly kind: "toolEdit"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly path: string; readonly relativePath: string; readonly sourceTool: string; readonly addedLines: number; readonly removedLines: number; readonly content: string; }; } | { readonly kind: "bash"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly command: string; readonly cwd?: string | undefined; }; } | { readonly kind: "pluginTrust"; readonly data: { readonly plugin: string; readonly path: string; readonly skills: number; readonly requestId: string; readonly digest: string; readonly runId: string & Brand<"RunId">; readonly programs: readonly string[]; readonly servers: readonly string[]; readonly review: readonly string[]; readonly version?: string | undefined; readonly native?: { readonly description: string; readonly provides: readonly string[]; } | undefined; }; } | { readonly kind: "retry"; readonly data: { readonly requestId: string; readonly operation: string; readonly failure: { readonly source: "model"; readonly message: string; readonly kind: "invalid-request" | "authentication" | "context-overflow" | "continuation-gone" | "transport" | "provider-rejection"; readonly status?: number | undefined; readonly provider?: string | undefined; readonly partialText?: string | undefined; readonly requestId?: string | undefined; readonly quota?: { readonly plan: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | null; readonly planType?: string | undefined; readonly resetsInMs?: number | undefined; } | undefined; } | { readonly source: "route"; readonly message: string; readonly session?: { readonly route: "chatgpt-subscription" | "xai-subscription"; readonly needsReauth: boolean; } | undefined; readonly provider?: string | undefined; readonly missingApiKey?: true | undefined; }; readonly runId: string & Brand<"RunId">; readonly credentialSwitch: { readonly kind: "decline-route"; readonly route: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | { readonly kind: "new-key"; readonly provider: "openai" | "anthropic" | "google" | "xai" | "deepseek" | "moonshot" | "dashscope" | "minimax" | "glm" | "meta" | "kimiCode"; } | null; readonly model?: string | undefined; }; } | { readonly kind: "proposal"; readonly data: { readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly task: boolean; readonly script?: { readonly title: string | null; readonly source: string; readonly calls: readonly { readonly toolName: string; readonly preview: string; }[]; } | null | undefined; readonly workingDirectory?: string | undefined; readonly agentSource?: { readonly kind: "custom" | "builtIn" | "plugin"; } | { readonly kind: "inline"; readonly persona: { readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; }; } | undefined; readonly rootUserInstruction?: string | undefined; readonly options?: { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | { readonly [x: string]: string | number | boolean | any | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null)[] | { readonly [x: string]: string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | readonly (string | number | boolean | any | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null)[] | any | null; } | null; } | null | undefined; }; } | { readonly kind: "planApproval"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly plan: { readonly objective: string; }; }; } | { readonly kind: "userQuestion"; readonly data: { readonly requestId: string; readonly runId: string & Brand<"RunId">; readonly questions: readonly { readonly options: readonly { readonly label: string; readonly description?: string | null | undefined; }[]; readonly question: string; readonly header?: string | null | undefined; readonly multiSelect?: boolean | null | undefined; readonly allowFreeText?: boolean | null | undefined; }[]; readonly context?: string | null | undefined; }; }; readonly answeredBy: "bash" | "toolEdit" | "superYolo" | "person"; }[]; }) => readonly P[], program: (request: P) => Effect<void, never, R>) => Effect<void, never, Scope | R>
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
const getEnabledModels: (stores: Pick<SettingsStores, "config" | "globalState">) => Effect<readonly string[], StateReadFailed, never>
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

## helperCall

One helper call: bind the configured helper model (else `runModel`) for
this call alone and run one completion off the run's rows,
gated on the process's retry gate, priced and reported to the usage log
as `attribution`. No row is written. Returns the
turn's assistant text and its priced usage (`null`: the provider reported
none), for a caller whose row records what the call cost. `stores` are the
asking session's setting slots: the binding, the retry limit and the usage
consent read them, beside the process `Secrets` and its subscription
accounts.

```ts
const helperCall: (stores: SettingsStores, args_1: HelperPrompt, attribution: UsageAttribution, args_3?: { readonly retries?: number | undefined; readonly runModel?: string | undefined; } | undefined) => Effect<{ readonly text: string; readonly usage: { readonly provider: string; readonly inputTokens: number; readonly outputTokens: number; readonly cost: number; readonly responseTimeMs: number; readonly cachedInputTokens?: number | undefined; readonly cacheWriteTokens?: number | undefined; readonly reasoningTokens?: number | undefined; readonly toolUsePromptTokens?: number | undefined; readonly cacheMissInputTokens?: number | undefined; readonly usageRoute?: "chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription" | "api-key" | undefined; readonly usagePlan?: string | undefined; } | null; }, Error | CallFailure, HttpClient | Secrets | SubscriptionAccounts | UsageLog | RouteRetries | PlanQuotas>
```

## HelperPrompt

A single non-streaming helper-model text completion.

```ts
interface HelperPrompt {
  readonly userPrompt: string;
  readonly systemPrompt?: string;
}
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
const InstalledPlugins: Readonly<{ readonly unloadedComponents: readonly ("LSP servers" | "output styles" | "apps")[]; readonly origin: (input: string, cwd: string, ref: string | undefined) => Result<PluginOrigin, PluginRequestError>; readonly install: (origin: PluginOrigin, only: readonly string[], env: PluginEnv) => Effect<{ readonly source: string; readonly name: string; readonly path: string; readonly skills: readonly string[]; readonly enabled: boolean; readonly description?: string | undefined; readonly commit?: string | undefined; readonly version?: string | undefined; readonly ref?: string | undefined; readonly trust?: { readonly version: string | null; readonly digest: string; } | undefined; }[], Error, FileSystem | ChildProcessSpawner>; readonly update: (names: readonly string[], env: PluginEnv) => Effect<PluginUpdate[], PluginError | PluginRequestError, FileSystem | ChildProcessSpawner>; readonly remove: (name: string, env: PluginEnv) => Effect<{ name: string; path: string; local: boolean; leftover: boolean; }, PluginError | PluginRequestError, FileSystem>; readonly list: (env: PluginEnv) => Effect<PluginListing[], PluginError, FileSystem>; readonly enable: <E, R>(name: string, env: PluginEnv, confirm: (review: PluginReview) => Effect<boolean, E, R>) => Effect<"enabled" | "declined", PluginError | PluginRequestError | E, FileSystem | R>; readonly review: (name: string, env: PluginEnv) => Effect<{ review: { name: string; version: string | null; digest: string; path: string; skills: number; programs: string[]; servers: string[]; lines: string[]; native: NativeEntry | null; }; trusted: boolean; enabled: boolean; }, PluginError | PluginRequestError, FileSystem>; readonly disable: (name: string, env: PluginEnv) => Effect<undefined, PluginError | PluginRequestError, never>; readonly loaded: (env: Pick<PluginEnv, "globalState">) => Effect<{ readonly source: string; readonly name: string; readonly path: string; readonly skills: readonly string[]; readonly enabled: boolean; readonly description?: string | undefined; readonly commit?: string | undefined; readonly version?: string | undefined; readonly ref?: string | undefined; readonly trust?: { readonly version: string | null; readonly digest: string; } | undefined; }[], never, FileSystem>; readonly describeHook: (hook: ConfiguredHook) => Effect<string, never, never>; readonly describeNative: (provides: readonly string[]) => string; }>
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

## ModelVerdict

One visible model's verdict: whether it can run now, the route that decided
it, and what that route means for the next request. The registry does not
describe an `unknown-model`. Each host words a row from it (the app's
`modelOptionsFrom`).

```ts
type ModelVerdict =
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

## NativeEntry

A native entry as its file declares it.

```ts
interface NativeEntry {
  /** Its file, absolute. */
  readonly file: string;
  readonly description: string;
  /** What its plugin contributes, as `provides` names it. */
  readonly provides: readonly string[];
}
```

## normalizeProviderError

A failure as a host reads it: its plain words, with the model call's
verdict and the vendor's raw body when a model call failed.

```ts
function normalizeProviderError(err: unknown): ProviderError
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
const ownKeyCredential: (stores: SettingsStores, config: ModelConfig) => Effect<{ readonly bearer: string; readonly endpoint: string; }, RouteUnavailable, Secrets>
```

## PlanQuota

What is known of one plan's quota now. `at` is when it was learned, in
epoch milliseconds: an endpoint's answer when it came, a reply's when it
arrived, which may be long ago when no request was made since.

```ts
type PlanQuota =
  /** The plan's quota endpoint answered. */
  | {
      readonly state: 'read';
      readonly at: number;
      /** The plan's tier as the provider names it, when it says. */
      readonly planName?: string;
      readonly windows: readonly PlanUsageWindow[];
    }
  /** The plan's quota endpoint gave no windows. */
  | {
      readonly state: 'failed';
      readonly at: number;
      readonly reason: PlanQuotaFailure;
    }
  /** A reply on the plan stated its windows. */
  | {
      readonly state: 'observed';
      readonly at: number;
      readonly windows: readonly PlanUsageWindow[];
    }
  /** The plan's replies state its quota, and none has in this process. */
  | { readonly state: 'unobserved' }
  /** Nothing this process reads states the plan's quota. */
  | { readonly state: 'unread' };
```

## PlanQuotas

The process's plan quotas ({@link PlanQuotasShape}).

```ts
class PlanQuotas extends Context.Service<PlanQuotas, PlanQuotasShape>()(
  '@texra-ai/harness/PlanQuotas',
)
```

## PlanQuotasShape

The process's plan quotas.

```ts
interface PlanQuotasShape {
  /** What is known of `route`'s quota now, asked of its endpoint with the
   *  key and settings `stores` hold when the cached answer has expired. A
   *  failure is the answer's `failed` state, logged here, never the
   *  read's. */
  readonly read: (
    route: PlanRoute,
    stores: SettingsStores,
  ) => Effect.Effect<PlanQuota, never, HttpClient.HttpClient | Secrets>;
  /** Drop `route`'s cached and in-flight answers (every plan's when
   *  omitted), so the next read asks: after its key or account changed, or
   *  a person's refresh. A reader already waiting still gets its answer,
   *  which is not cached. */
  readonly invalidate: (route?: PlanRoute) => Effect.Effect<void>;
  /** `fetch` for requests billed to `plan`: when the plan's replies state
   *  its quota, each reply's word is recorded as it arrives; otherwise
   *  `fetch` itself. */
  readonly observing: (
    plan: PlanRoute | null,
    fetch: typeof globalThis.fetch,
  ) => typeof globalThis.fetch;
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
composition root runs on. The project stores (`ProjectDatabases`) are not
among them: only the session composition and its stores read them.

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
  /** The programs it carries, by the name each is started by. */
  readonly programs: readonly string[];
  /** Its MCP servers' names, as its tools carry them. */
  readonly mcpServers: readonly string[];
  /** Its native entry, as its file declares it. */
  readonly native: NativeEntry | null;
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
  /** The digest trusting it records. */
  readonly digest: string;
  /** Its folder. */
  readonly path: string;
  readonly skills: number;
  /** Its programs, by the name each is started by. */
  readonly programs: readonly string[];
  /** Its MCP servers, by name. */
  readonly servers: readonly string[];
  /** What the plugin declares, one line each, for the prompt. */
  readonly lines: readonly string[];
  /** Its native entry, which runs inside the process once trusted: only a
   *  person's own answer trusts it. */
  readonly native: NativeEntry | null;
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
a `requires` naming a plugin not listed, two script modules of one name,
a program that is not one of its plugin's script modules) fails the build with {@link PluginsRefused} before
anything is built, so the refusal names the plugin rather than failing
the first session open. A global store the process builds itself is
seeded with the first-install tool switches; a store handed in is left as
it is. Every root run is labelled with a short title from the helper model
(its `run.description`): an extra model request per root run, counted in
the run's usage, which every host's run list shows.

The filesystem, path and child-process spawner are a requirement, as the
model is: the root provides `nodePlatformServices`
(`@texra-ai/harness/node`) once, and every session and run of the process
reads the files and starts the children that layer gives it.

```ts
function processLayer(
  options: ProcessLayerOptions,
): Layer.Layer<
  ProcessServices | Sessions,
  PluginsRefused,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner
>
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

## programLaunch

What launches the program `name` as a run of its own in the project at
`roots`: the run is named for the program and has no agent's prompt or
tools (its script is all it runs), and it writes the program's own
outputs unless the launch names files other than its inputs.

```ts
const programLaunch: (name: string, args: Readonly<Record<string, Json>>, files: Pick<{ readonly agent: string; readonly model: string; readonly instruction: string; readonly inputFiles: readonly string[]; readonly contextFiles: readonly string[]; readonly mediaFiles: readonly string[]; readonly outputFiles: readonly string[]; readonly memories: readonly string[]; readonly script?: { readonly kind: "background"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly timeoutMs?: number | undefined; } | { readonly kind: "program"; readonly name: string; readonly args: { readonly [x: string]: Json; }; } | undefined; readonly workingDirectory?: string | undefined; readonly agentSource?: { readonly kind: "custom" | "builtIn" | "plugin"; } | { readonly kind: "inline"; readonly persona: { readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; }; } | undefined; readonly asCaller?: boolean | undefined; readonly rootUserInstruction?: string | undefined; readonly displayInstruction?: string | undefined; readonly skills?: readonly string[] | undefined; readonly launch?: { readonly [x: string]: Json; } | undefined; readonly delegationAgentScope?: readonly string[] | undefined; readonly outputSchema?: { readonly [x: string]: unknown; } | undefined; }, "inputFiles" | "outputFiles">, roots: Pick<WorkspaceRoots, "storage">) => Effect<{ agent: string; agentSource: { kind: "inline"; persona: {}; }; outputFiles: string[]; script: { kind: "program"; name: string; args: Readonly<Record<string, Json>>; }; }, ProgramNotRegistered, FileSystem | AppState | ToolRegistry>
```

## ProgramNotRegistered

A run names a program no plugin offers: an earlier build's run, one of
a plugin this process does not load, or one read from a file that is
not loaded now (`withheld` says why).

```ts
class ProgramNotRegistered extends Schema.TaggedError<ProgramNotRegistered>()(
  'ProgramNotRegistered',
  {
    name: Schema.String,
    registered: Schema.Array(Schema.String),
    withheld: Schema.Array(Schema.String),
  },
)
```

## programsNow

Every program a run of the project at `roots` can open on now, by name:
those the plugin list registers and those read from files
({@link programFiles}); a program read from a file has the description
and tools its file declares. `withheld` says why an enabled plugin or a
program file is not loaded.

```ts
const programsNow: (roots: Pick<WorkspaceRoots, "storage">) => Effect<{ programs: Map<string, Program<unknown>>; withheld: string[]; }, never, FileSystem | AppState | ToolRegistry>
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
  file: string,
) => Effect.Effect<
  ReturnType<typeof parseMcpServers> | null,
  never,
  FileSystem.FileSystem
>
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
const readModelOptions: (stores: SettingsStores, models?: readonly string[] | undefined) => Effect<ModelVerdict[], StateReadFailed | SecretsFailed | RouteUnavailable, Secrets | SubscriptionAccounts>
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

## redactDiagnostics

Text a host shows as a diagnostic (a health report, a log viewer, an
exported log) with what would identify the user masked: the home and
workspace path prefixes as `[path]`, e-mail addresses to their first
letters, and provider secrets as {@link redactSecrets} does. Paths go
first, so a path that holds an address or a key-shaped name is one
`[path]`. The caller names the paths because this module runs in
browser bundles too and cannot ask the OS for the home directory.

```ts
function redactDiagnostics(
  text: string,
  paths: { readonly home: string; readonly workspace: string | undefined },
): string
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
const registerCustomAgentRoot: Effect<void, never, AgentDirectories | FileSystem | GlobalStorageFs>
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
    /** `finished`: the view applied every write committed so far; `now()`:
     *  the head. */
    readonly log: {
      readonly drained: Effect.Effect<void>;
      readonly now: () => CommitOrdinal;
    };
  },
  runId: RunId,
  /** A commit in the reader's activation: it reads the latest at or before. */
  activation: CommitOrdinal,
  result: Effect.Effect<unknown, E>,
): Stream.Stream<AgentEvent, E>
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
    ...RouteFailureFieldsSchema.fields,
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
rebuilt from, each workspace's last dependency probe, the model routes'
retry gate and what is known of each plan's quota. The composition's tool catalog (`ToolCatalog`) is not among
them: no run names it.

```ts
type RunServices =
  | PlatformServices
  | AgentCatalog
  | RouteRetries
  | PlanQuotas
  | ToolRegistry
  | ToolAvailability;
```

## scopedFork

The run function a host callback starts Effect work with: each fiber
joins one `FiberSet` of the caller's scope, whose close interrupts and
awaits it, and once that scope has closed a callback starts nothing (the
fiber it gets back is already interrupted). Like `runtime.runFork`, it
runs the effect's first synchronous steps before it returns. A failure or
defect is logged once, as {@link withForkFailureReporting} logs a
runtime's fork.

Build it once where the owner's scope is acquired, in the context the
owner's fibers run in (a host's process services): every fiber starts
from that context, as `runtime.runFork` starts from the runtime's, so no
more specific provision sits inside for it to shadow.

```ts
const scopedFork: <R = never>() => Effect<ScopedFork<R>, never, Scope | R>
```

## ScopedFork

Start an effect on a fiber of the scope that made this run function.

```ts
type ScopedFork<R> = <A, E>(
  effect: Effect.Effect<A, E, R>,
) => Fiber.Fiber<A, E>;
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
  readonly stores: Pick<SettingsStores, 'config' | 'globalState'>;
})
```

## SkillIssueCode

What a reader branches on, where it does: `source_error` is a skill source
that is missing, not the expected kind, or unreadable (the CLI's usage
exit); `read_error` is a directory or file that could not be read, which
becomes a `source_error` when it is a required source's own path. Every
other issue says what it is in its message.

```ts
type SkillIssueCode = 'source_error' | 'read_error';
```

## SkillIssueSeverity

```ts
type SkillIssueSeverity = 'error' | 'warning';
```

## SkillLoadIssue

```ts
interface SkillLoadIssue {
  severity: SkillIssueSeverity;
  code?: SkillIssueCode;
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
const Skills: Readonly<{ readonly display: (roots: SkillRoots) => Effect<{ skills: { readonly name: string; readonly description: string; readonly scope: "custom" | "user" | "bundled" | "project" | "interop"; readonly label: string; readonly path: string; readonly sourcePath: string; readonly enabled: boolean; }[]; issues: { readonly message: string; readonly path?: string | undefined; }[]; }, StateReadFailed, FileSystem>; readonly enabled: (roots: SkillRoots, options?: SkillSourceOptions | undefined) => Effect<{ skills: { readonly name: string; readonly description: string; readonly scope: "custom" | "user" | "bundled" | "project" | "interop"; readonly label: string; readonly path: string; readonly sourcePath: string; readonly enabled: boolean; }[]; issues: SkillLoadIssue[]; }, StateReadFailed, FileSystem>; }>
```

## StorageInventory

What storage maintenance found under a storage root: the workspace stores
whose `workspace-store` record names a root that is gone, and the copies
a store open moved aside (a damaged file's, `.corrupt-`) beside the stores
that remain. The store of no workspace has no root and is never an orphan.
Nothing goes without the caller's word: an unmounted drive looks exactly
like a deleted root.

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

## subscribeAppSignal

Subscribe to `signal` now, in the caller's scope, and stream its payloads
from then on. The subscription is live when this returns, where a stream
run on a forked fiber subscribes only once that fiber starts: for a caller
that must not miss a signal published after it reads the state the signal
announces.

```ts
function subscribeAppSignal<K extends AppSignal>(
  signal: K,
): Effect.Effect<
  Stream.Stream<AppSignalPayloads[K]>,
  never,
  AppSignals | Scope.Scope
>
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

The edge function decodes the same entry, and the two must match: everything this schema accepts, that one accepts.
There the counts are non-negative ints, `listCost` a non-negative finite
number, `timestamp` a UTC ISO 8601 date-time and every string non-empty,
`provider` and `usageRoute` included.

```ts
const UsageLogEntrySchema: Struct<{ readonly timestamp: String; readonly model: NonEmptyString; readonly provider: Literals<readonly ["google-interactions", "openai-responses", "anthropic-messages"]>; readonly agentName: optional<NonEmptyString>; readonly usageRoute: optional<Literals<readonly [...("chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription")[], "api-key"]>>; readonly streamId: optional<NonEmptyString>; readonly inputTokens: Int; readonly outputTokens: Int; readonly listCost: Finite; readonly responseTimeMs: optional<Int>; readonly cachedInputTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly extensionVersion: optional<NonEmptyString>; readonly editorType: optional<NonEmptyString>; }>
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
boundary uses, so a file that only finishes a housekeeping program does not
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
   * The agent a launch runs, over a finished catalog: the entry an explicit
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
  /**
   * Delete the custom agent `name`: its file, and the workspace's hidden
   * choice for it. Refused when the catalog holds no such custom agent
   * (`noFile`) or its file lies outside the custom directory (`escapes`).
   * The deleted file's path.
   */
  readonly removeCustom: (
    name: string,
  ) => Effect.Effect<
    string,
    | AgentCustomizeRefused
    | AgentDirectoriesFailed
    | StateWriteFailed
    | PlatformError.PlatformError
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

The state slot a workspace's agent list resolves against: the repository's
selection. Every read is answered for the workspace whose slot the caller
hands over, so a process holding several sessions never answers one
project's question with another's agent list.

```ts
type WorkspaceAgentsStores = Pick<WorkspaceRoots, 'repoState'>;
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
