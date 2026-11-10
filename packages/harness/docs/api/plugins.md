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
  ([`AGENT_TOOL_NAME`](#agent_tool_name)), and [`web`](#web) for
  `Sessions.layer({ platform, plugins })`.
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
- **Lifetimes, prompt sections & durable rows**:
  [`PromptSection`](#promptsection),
  [`ProcessPluginLayer`](#processpluginlayer),
  [`SessionPluginLayer`](#sessionpluginlayer), [`PluginHold`](#pluginhold),
  [`RequestDecisionHook`](#requestdecisionhook), [`FactKind`](#factkind),
  and [`AgentBlock`](#agentblock) ([`agentBlockOf`](#agentblockof)).

## AGENT_TOOL_NAME

The tool that runs a named agent as a child of the calling run.

```ts
const AGENT_TOOL_NAME: "agent"
```

## AgentBlock

A top-level block a plugin owns in an agent file (such as `task:`). The
catalog scan checks a file's block against `schema`
and keeps the parsed value on the entry (`AgentEntry.blocks`); a file
whose block fails it, or that holds a key no listed plugin owns, is
refused like any other invalid definition. An agent with a block is a
task: it declares no tools, delegation marks it for the tools that
`launchesTasks`, and it runs as one only through a launch its plugin
builds (a `script` of kind `recipe`). The harness reads nothing inside it.

```ts
interface AgentBlock<A = unknown, R = unknown> {
  /** The key in an agent file: unique across the plugin list, and never a
   *  key of the persona itself. */
  readonly key: string;
  /** The block as written, to its value with defaults applied. */
  readonly schema: Schema.Codec<A, unknown>;
  /** How a run of this block's recipe reads to whoever launched it. */
  readonly result?: AgentBlockResult<R>;
  /** The files the block binds, relative to its agent file: part of the
   *  agent, so a customized copy carries them and the file's digest covers
   *  them. */
  files?(block: A): readonly string[];
}
```

## agentBlockOf

The value of `block` on `entry`, as the catalog scan parsed it with the
block's schema; undefined when the agent has none.

```ts
function agentBlockOf<A>(
  entry: Pick<AgentEntry, 'blocks'>,
  block: AgentBlock<A>,
): A | undefined
```

## AgentBlockResult

How a completed recipe run reads: to the launching model, and to a
script's summary of the files its calls wrote. What it reports is the
run's latest row of the plugin's own `fact` kind (`Plugin.factKinds`),
the one record of it; the recipe's return value is not read. The harness
reads the row only through these.

```ts
interface AgentBlockResult<R = unknown> {
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
  /** The files the recipe wrote, in the order it wrote them (a document
   *  revised twice appears twice, the later entry its latest): the files a
   *  parent may read of its child's storage, and a script's summary. */
  changes(
    value: R,
    roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
  ): readonly RecipeChange[];
}
```

## AgentTrace

Agent-general SDK surface. Every method ultimately reduces to `emit()` so
the trace channel is a single source of truth. App-specific helpers are
plain functions over this interface (see `helpers.ts`).

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
  openRun(kind: MessageType): StreamHandle;
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

## assertNoParentTraversal

Fail when a raw tool path contains a parent-directory segment.

```ts
const assertNoParentTraversal: (targetPath: string) => Effect<void, ToolError, never>
```

## boundFile

The file an agent file at `agentPath` binds as `file`: where it is
(beside the agent file, or an absolute path as written) and how to read
it. A file that cannot be read fails the read; every reader of a bound
file goes through this, so none mistakes a missing file for an empty or
a changed one.

```ts
function boundFile(
  agentPath: string,
  file: string,
): {
  readonly path: string;
  readonly read: Effect.Effect<
    string,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  >;
}
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

## CALL_FIELDS

The fields every child launch takes beside its own: memories, the call's
reuse id and card label, its time limit, and whether a script waits.

```ts
const CALL_FIELDS: Readonly<{ memories: decodeTo<toType<$Array<String>>, optional<NullOr<$Array<String>>>, never, never>; working_directory: decodeTo<optional<String>, optional<NullOr<String>>, never, never>; id: optional<NullOr<String>>; label: optional<NullOr<String>>; timeoutMs: optional<NullOr<Int>>; background: optional<NullOr<Boolean>>; }>
```

## CallRequests

The requests one tool call raises, opened through its run's loop. Each
carries an id its attempt derives, so a person's pending approval outlives
the process that asked: a resume re-enters the call, and the call opens
that same request again, joining it instead of asking twice.

```ts
interface CallRequests {
  /** The id the call's next request of `kind` opens under: the request a
   *  resumed call left standing, when it is of this kind, else the
   *  attempt's next derived id. A request is staged under this id before
   *  it opens. */
  readonly nextId: (kind: RequestPayload['kind']) => string;
  /** Open the request (or re-enter the standing one) and wait for its
   *  decision. The returned payload is the request actually answered,
   *  which on resume may differ from the proposal recomputed by the caller.
   *  `blobs` are the strings the payload names by address, stored with its row. */
  readonly open: <P extends RequestPayload>(
    payload: P,
    blobs?: readonly DraftBlob[],
  ) => Effect.Effect<
    {
      readonly payload: Extract<RequestPayload, { kind: P['kind'] }>;
      readonly decision: DecisionOf<P['kind']>;
    },
    DatabaseAggregateClosed | CellError
  >;
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

## ChildLaunch

One child launch as the shared core runs it: the agent and its prompt,
and what the child is. A chat (`task: null`) may ask for a value of
`schema` and attaches `mediaFiles` to its prompt. A task opens on what
the launching plugin builds for the approved agent (`configFor`: its
recipe and outputs, null for an agent with no task block) and works over
`files` with `options`, as its proposal says. `tool` names the launching
tool in its reuse key and its copy.

```ts
type ChildLaunch = {
  readonly tool: string;
  readonly agentName: string;
  /** An agent the call defines, named `agentName`: no catalog entry. */
  readonly persona?: AgentProposal['persona'];
  readonly prompt: string;
  readonly model: string | null | undefined;
  readonly memories: readonly string[];
  readonly workingDirectory: string | null | undefined;
  readonly id: string | null | undefined;
  readonly timeoutMs: number | null | undefined;
  readonly background: boolean | null | undefined;
} & (
  | {
      readonly task: null;
      readonly schema: Record<string, unknown> | null | undefined;
      readonly mediaFiles: readonly string[];
    }
  | {
      readonly task: {
        readonly configFor: (
          chosen: AgentProposal,
        ) => Pick<AgentConfig, 'script' | 'outputFiles'> | null;
        readonly options: NonNullable<AgentProposal['options']>;
      };
      readonly files: {
        readonly inputFiles: readonly string[];
        readonly contextFiles: readonly string[];
        readonly mediaFiles: readonly string[];
        readonly outputFiles: readonly string[];
      };
    }
);
```

## ChildRunDelivery

One child-run delivery: the envelope's identity followed by the facts its
driver selected. Every fact is optional; the body renders those present, in
the fixed order declared below, so two drivers reporting the same fact
always render it the same way and in the same place.

```ts
interface ChildRunDelivery {
  /** Root element name (`subagent-result`, `background-error`, …). A
   *  plugin's is `<family>-result` or `<family>-error`, `family` being
   *  lowercase words joined by `-`: every render surface recognizes that
   *  shape as a delivery, so a plugin registers no tag. */
  readonly tag: string;
  readonly runId: string;
  /** Echoed prompt attribute, for a child that took a prompt; truncated before escaping. */
  readonly prompt?: string;
  /**
   * Attributes rendered after id/prompt (`agent`, `status`, `thread-id`, …).
   * Null/undefined values are dropped by the envelope.
   */
  readonly attributes?: readonly {
    readonly name: string;
    readonly value: string | number | boolean | null | undefined;
  }[];
  /** Pre-rendered wall-time body text (`1.2s`). */
  readonly wallTime?: string;
  /** Final assistant response as one inline element; empty → `(no response)`. */
  readonly response?: string;
  /** Token usage element; omitted when null/undefined. */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  } | null;
  /** Pre-rendered fact lines appended after the shared elements. */
  readonly lines?: readonly string[];
  /** Failure text; its presence is what makes this delivery an error report. */
  readonly message?: string;
}
```

## ChildRuns

The door, as the run loop provides it beside each call ({@link childRuns}).

```ts
class ChildRuns extends Context.Service<ChildRuns, ChildRunsShape>()(
  '@texra-ai/harness/agent/ChildRuns',
)
```

## ChildRunsShape

A plugin tool's one door to the session's runs. It launches children of
its call's run: an agent's (`launch`: the child's result, or its receipt
for a background launch) or an external process's (`launchProcess`: its
run id, outside the child-run budget); a plugin's tool reaches no other
launch. And it reaches a
run of the session by id: its input, live parent edge, records, whether
it holds a request, and the plugin's own facts on it, each over the
call's run.

```ts
interface ChildRunsShape {
  readonly launch: (
    launch: ChildLaunch,
  ) => Effect.Effect<ToolResult, Error, PluginToolServices>;
  readonly launchProcess: (
    launch: ProcessChildLaunch,
  ) => Effect.Effect<RunId, Error, ToolContext | RunServices>;
  /** The run's input: what a tool sends it, and when it takes no more. */
  readonly inbox: (runId: RunId) => Effect.Effect<RunInbox, Error>;
  /** Its attached parent as the rows record it (`run.start`, then a
   *  `run.detach`): null for a root, or a run that is not there. */
  readonly parent: (runId: RunId) => Effect.Effect<RunId | null, Error>;
  /** Its records: whether the store still lists it, and its terminal
   *  result (null before it ends). */
  readonly records: (runId: RunId) => {
    readonly exists: Effect.Effect<boolean, Error>;
    readonly end: Effect.Effect<RunEnd | null, Error>;
  };
  /** The latest value of `arm`'s kind among the run's own facts, decoded
   *  by the arm's schema; undefined while the run recorded none. */
  readonly fact: <A>(
    runId: RunId,
    arm: {
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
gets them if its configuration names `script`, or, while script-only
tools are on, as every chat run does; its session layer is the code
sandbox the scripts run in.

```ts
const codemode: Plugin
```

## DecisionOf

The decisions a request of kind `K` takes: its own actions and the three
refusals. A plugin's request declares its actions on its row, so its
type admits any decision.

```ts
type DecisionOf<K extends RequestPayload['kind']> =
  | Extract<
      RequestDecision,
      {
        action: (typeof OWN_ANSWERS & {
          readonly plugin: PluginRequest['answers'];
        })[K][number];
      }
    >
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
harness's built-ins and an app's plugins are written the same way.

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
  Pick<ToolDefinition, 'scriptReturns' | 'card'> &
  Pick<
    ITool,
    | 'hostCapability'
    | 'launchesTasks'
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
     * call writes and the command it must get approved. Declared here,
     * applied once in `agent/runtime/loop/toolGuard.ts`.
     *
     * `NoInfer<R>`: the guard is checked against the requirement channel the
     * tool already has, it never sets it.
     */
    guard?: ToolGuard<T>;
    /** The run body. Succeed with the text the model reads back, or with a
     *  whole `ToolResult` for a summary, attachments or facts; fail with
     *  an `Error` and the model reads its message as the tool's error. */
    execute: (input: T) => Effect.Effect<ToolResult | string, Error, R>;
  };
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
    previous: PluginRow | undefined,
    next: PluginRow,
  ) => string | null;
  /** Whether the aggregate's `latest` row already says more than `next`
   *  (a call's fact that lagged behind a later writer): the call's batch
   *  then leaves `next` out instead of failing on `accepts`. */
  readonly supersedes?: (latest: PluginRow, next: PluginRow) => boolean;
  /** The workspace files a row of the kind says its run wrote past the
   *  editor's own write path: every process that folds the run announces
   *  them (`workspaceFilesWritten`), a window hearing a service task's
   *  write as it hears its own. */
  readonly writes?: (value: JsonValue) => readonly string[];
}
```

## fileList

A list of file paths, empty when the call names none.

```ts
const fileList: (description: string) => decodeTo<toType<$Array<String>>, optional<NullOr<$Array<String>>>, never, never>
```

## fileOps

Files and the shell: every agent needs them. An app passes the filter
`write_file` applies to what it writes (its own content replacements).

```ts
const fileOps: (options?: { readonly writeFilter?: WriteFilter | undefined; }) => Plugin
```

## FollowUpFailureReason

Why a submission could not be admitted, worded for the user by
{@link presentFollowUpResult}: the kind of a resume's refusal
(`ResumeRefusal`; a message to a run with no loop here is admitted only as
a resume would be, and `notResumable` there also covers a closed input, a
disposed session, or a message that does not wake the run), or one of the
message's alone:

- `readFailed`: the run's rows could not be read just now (a failing
  store), which says nothing about the run itself.
- `notParent`: the sender is not the run's parent.
- `ranOnce`: the run was launched to run once (`run.start.takesFollowUps`
  false: a one-shot root, a process run) and reads no message, live or
  resumed.

```ts
type FollowUpFailureReason =
  | ResumeRefusal['kind']
  | 'readFailed'
  | 'notParent'
  | 'ranOnce';
```

## FollowUpSenderInput

Who a producer says a follow-up is from. Runs talk as a graph: any run may
message any run in the project, whatever their places in the supervision
tree. A run names only itself; the recipient's admission
(`Inbox.send`) stamps how it relates to the recipient.

```ts
type FollowUpSenderInput =
  | Exclude<FollowUpSender, { readonly kind: 'run' }>
  | { readonly kind: 'run'; readonly runId: RunId };
```

## formatDelivery

Build the `<...-result>` / `<...-error>` XML delivered to the parent's
follow-up queue when a child run's turn settles.

```ts
function formatDelivery(delivery: ChildRunDelivery): string
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

One message a producer sends.

```ts
interface InboxItem {
  readonly text: string;
  readonly displayText?: string;
  /** A user's media (e.g. pasted images) and its blobs (`attachedMedia`). */
  readonly media?: QueuedFollowUp['content']['media'];
  readonly blobs?: readonly DraftBlob[];
  readonly from: FollowUpSenderInput;
  /** Identity of a delivery its producer may repeat (a child's result):
   *  the row's `followUpId`, so a replay writes nothing. */
  readonly deliveryId?: string;
  /** A request of the run's own (`/compact`, a model switch), not a message. */
  readonly control?: QueuedFollowUp['control'];
  /** The id a caller named the message by (`followUp.send`; `deliveryId`
   *  is its `sentFollowUpId`): a retry under it answers with the first
   *  send's receipt, another message under it fails `Conflict`. */
  readonly caller?: string;
}
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
  /** Launches agents' tasks (a plugin's block): its step lists the agents
   *  with one. */
  readonly launchesTasks?: true;
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
   *   every call after it until it settles.
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
   * question, a plugin's request), which answers what the call's hooks
   * said. A run that cannot present a prompt is not offered such a tool
   * (`asksApproval`).
   */
  readonly requiresApproval?: true | 'inBody';
  /** The loop-side guard this tool declares; see {@link ToolGuard}. */
  readonly guard?: ToolGuard<never>;
  /**
   * A description rendered from the other tools the run declares and the
   * modules its scripts may import, in place of `definition.description`:
   * rendered at the step that freezes the run's system text and kept as
   * that step recorded it until a compaction opens the freeze again, so a
   * catalog change mid-run leaves its text, and the cached
   * prefix through it, as it was. The tool that has one is the script tool,
   * which reaches nothing but the run's other tools and its own agent: a
   * child is offered it, and its script-only functions, whatever its parent
   * was.
   */
  readonly describe?: (
    declared: readonly Pick<ITool, 'definition' | 'scriptGlobal'>[],
    /** The specifiers of the modules the step's scripts may import. */
    modules: readonly string[],
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

## LogOptions

Sugar passed to debug/info/warn/error.

```ts
interface LogOptions {
  readonly data?: unknown;
  /** The row's category; subscribers pick a render style from it. */
  readonly messageType?: MessageType;
}
```

## LogWriteError

A write the store refused: nothing was written.

```ts
type LogWriteError = DatabaseAggregateClosed | DatabaseWriteFailed;
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
const MemoryStore: { folder: "memories"; storagePath: (input: string) => Effect<string, Error, never>; displayPath: (storagePath: string) => string; list: Effect<{ readonly displayPath: string; readonly storagePath: string; readonly size: number; readonly mtime: string; readonly preview?: string | undefined; readonly lineCount?: number | undefined; readonly previewError?: boolean | undefined; readonly modifiedBy?: string | undefined; readonly pinned?: boolean | undefined; }[], PlatformError, StorageFs>; preview: (input: string) => Effect<MemoryPreview, Error | PlatformError, StorageFs>; delete: (input: string) => Effect<void, Error | PlatformError, StorageFs>; pin: (input: string) => Effect<MemoryPinResult, Error | PlatformError, StorageFs>; unpin: (input: string) => Effect<void, Error | PlatformError, StorageFs>; }
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

Child agents: the `agent` tool.

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
   * its tools are withheld while the dependency is missing. Without it the
   * plugin is built in and always available.
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
   *  run (a task's recipe) and a text-only persona get none. */
  readonly injectedWhen?: Readonly<Record<string, SettingRow<boolean> | true>>;
  /** Its section of each request's system text, pinned while it is on. */
  readonly prompt?: PromptSection;
  /** Process-lifetime services, up while the plugin is switched on or a step
   *  pins it. A host-supplied one (VS Code's Lean services) is passed with
   *  the host's plugin value. */
  readonly processLayer?: ProcessPluginLayer;
  /** Session-lifetime services, one per open session, up while the plugin
   *  is switched on or a step of that session pins it. */
  readonly sessionLayer?: SessionPluginLayer;
  /** Its side of a decision on a pending request it opened, on or off. */
  readonly decision?: RequestDecisionHook;
  /** The row kinds it owns (`plugin.fact`), on or off: rows outlive it. */
  readonly factKinds?: readonly FactKind[];
  /** The agent-file block it owns (`AgentBlock`), on or off. */
  readonly agentBlock?: AgentBlock;
  /** Script module sources by name, imported as `builtIn:<name>`. */
  readonly scriptModules?: Readonly<Record<string, string>>;
  /** The plugins it runs on, by id; a list lacking one is rejected. */
  readonly requires?: readonly string[];
}
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

## PluginFactRejected

A plugin fact its writer refused in the job: its kind's rule
(`FactKind.accepts`) rejected it against the aggregate's latest row, or
it moves a plugin's aggregate under a run the store no longer holds
open. Nothing was written.

```ts
class PluginFactRejected extends Schema.TaggedError<PluginFactRejected>()(
  'PluginFactRejected',
  { aggregateId: Schema.String, reason: Schema.String },
)
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

## PluginRow

One stored row of a plugin's kind, as its fact kind's transition rule reads
it: the row's decoded value and the run it is parented to, if any.

```ts
interface PluginRow {
  readonly value: JsonValue;
  readonly parent: RunId | null;
}
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
  /** The delivery its parent reads (`formatDelivery`). */
  readonly report: string;
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
  readonly reportError: (error: Error) => string;
}
```

## PromptSection

A plugin's section of each request's system text, rendered from the tool
names the request's step offers, whether the run is a child and its
workspace configuration ('' for none).

```ts
type PromptSection = (ctx: {
  readonly offered: readonly string[];
  readonly isChild: boolean;
  /** The step's bound model is an Anthropic model. */
  readonly isAnthropic: boolean;
  /** The run's workspace configuration, for a section that follows a
   *  setting of its plugin's. */
  readonly config: ConfigProvider;
}) => string;
```

## randomizedExponentialBackoff

```ts
function randomizedExponentialBackoff(base: Duration.Input)
```

## RecipeChange

One file a recipe wrote, as a script summary counts it.

```ts
interface RecipeChange {
  /** The workspace path the file replaces. */
  readonly path: string;
  /** The file the recipe wrote. */
  readonly absolutePath: string;
  /** The file it was diffed against, when it continues one: an earlier
   *  call's `absolutePath` continues that call's row. */
  readonly base: string | null;
  readonly added: number | null;
  readonly removed: number | null;
}
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
- `@returns` The rendered prompt; a template error fails with that `Error`

```ts
const renderPrompt: (prompt: string, variables: Record<string, unknown>) => Effect<string, Error, never>
```

## RequestDecisionHook

A plugin's side of a decision on a pending request it opened (a
`PluginRequest` naming it). The session runs it before the decision's row
commits, under the request's decision lane, so a process that exits in
between leaves the request pending and answerable rather than settled
with nothing recorded. It may send a run of the session its input
(`inbox`), and commit facts about its own aggregates, hung under the
request's run (`commit`).

```ts
interface RequestDecisionHook {
  readonly record: (request: {
    readonly payload: PluginRequest;
    readonly decision: RequestDecision;
    readonly inbox: (runId: RunId) => RunInbox;
    readonly commit: (
      facts: readonly (ToolFact & { readonly aggregate: string })[],
    ) => Effect.Effect<
      void,
      LogWriteError | DatabaseReadFailed | PluginFactRejected
    >;
  }) => Effect.Effect<void, Error, GlobalValues>;
}
```

## requestToolEditApproval

Ask the person for an edit when `sessionPermission` (`loop/toolGuard.ts`),
given what the call's hooks said, asks: a `request.opened` on the run
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

A path that escapes that root is admitted only inside a registered external
root or with path protection switched off; otherwise it fails with a
`ToolError` the tool runner reports to the model. With no folder open and
no working directory, only an absolute path can resolve (the agent
directories are registered external roots).

`fsPath` is workspace-relative for a workspace path, so the confined
`WorkspaceFs` view answers it, and absolute for a working-directory or
outside path.

```ts
const resolveToolPath: (call: ToolPathCall, targetPath?: string | undefined) => Effect<ToolPathResolution, Error, never>
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

## RoutePolicy

One route a binding's calls go through: its key, and the scope of the
failures that cool it (llm's `ModelError.scope`).

```ts
interface RoutePolicy {
  readonly key: string;
  readonly scope: 'model' | 'route';
}
```

## RunFileService

```ts
class RunFileService
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

Which arms are reachable, and from where:
- `not-owner`: from `RunCell.append`, where the session's log refuses a
  closed target as `DatabaseAggregateClosed`, nothing written. It is never
  synthesised from any other write failure: a disk error stays a
  `DatabaseWriteFailed`. A loop that meets it mid-turn stops with it,
  no retry and no second write.
- `unsafe-endpoint`: a pre-publish assertion over every durable origin,
  the loud restatement of the package's endpoint constraint.
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
(`Effect.die`), not an arm: the loop must not handle it.

```ts
class RunHistoryRefused extends Schema.TaggedError<RunHistoryRefused>()(
  'RunHistoryRefused',
  {
    reason: Schema.Literals([
      'not-owner',
      'unsafe-endpoint',
      'unprepared-history',
      'inconsistent',
      'foreign-protocol',
    ]),
    runId: RunIdSchema,
    detail: Schema.String,
    cause: Schema.optional(RunHistoryInconsistent),
  },
)
```

## RunInbox

One run's input, as a plugin reaches it: what it sends the run (routed,
admitted and woken as {@link submitFollowUp} does), and when the run
takes no more.

```ts
interface RunInbox {
  /** Deliver `item` to the run. */
  readonly send: (
    item: InboxItem,
    options?: RunInboxSendOptions,
  ) => Effect.Effect<SubmitFollowUpResult, Error>;
  /** Hear the run take no more input, or its session's inbox close;
   *  returns the detach. */
  readonly onClosed: (listener: () => void) => () => void;
}
```

## RunInboxSendOptions

How one input is delivered to a run.

```ts
interface RunInboxSendOptions {
  /** Only from the run's parent, by its rows (`SendOptions.fromParent`). */
  readonly fromParent?: boolean;
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

## StepRoot

A read-only directory one step admits for its own calls, beside the
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

## StreamHandle

Handle returned by `openRun` — append chunks then finalize.

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
one), or it was not admitted for a worded reason. A delivery the
admission boundary had already accepted is `sent`. A resume the input
started that the run refused is told by the resume itself.

```ts
type SubmitFollowUpResult =
  | { status: 'sent' }
  | { status: 'queued' }
  | { status: 'failed'; reason: FollowUpFailureReason };
```

## TEMPLATE_INPUT_NAMES

The names of the fixed template variables, the keys of
{@link TemplateInputsSchema}. A plugin that adds variables of its own
checks them against this list, so none shadows a fixed one.

```ts
const TEMPLATE_INPUT_NAMES: readonly string[]
```

## TemplateInputs

The fixed variables every prompt template may read.

```ts
type TemplateInputs = typeof TemplateInputsSchema.Type;
```

## TemplateOpening

What a launch opens from: the template inputs; the names of the skills a
tool-use run's instruction activated; the attached memories' XML block,
appended to the system prompt (null when none are attached); and the
attached memories that could not be read.

```ts
interface TemplateOpening {
  readonly inputs: TemplateVars;
  readonly activated: readonly string[];
  readonly attachedMemories: string | null;
  readonly attachedMemoryMisses: AttachedMemoryMiss[];
}
```

## TemplateVars

The template-variable map a launch opens with: fixed variables may be
absent (template rendering keeps `throwOnUndefined` off, so templates
must tolerate absence). A plugin renders its own variables beside these
by spreading this map into its own (`TEMPLATE_INPUT_NAMES`).

```ts
type TemplateVars = Partial<TemplateInputs>;
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
read-only roots the call's step admits (the skills it lists or its user
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

```ts
class ToolError extends Error
```

## ToolFileAttachment

```ts
type ToolFileAttachment = typeof ToolFileAttachmentSchema.Type;
```

## ToolGuard

The guard the run loop applies before a tool's body runs, declared on the
tool instead of called inside it: the paths the call writes and the command
it must get approved. `agent/runtime/loop/toolGuard.ts` is the one place
either is checked, so no tool body re-checks its own roots or asks for the
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
admits (the skills it lists or its user activated; none outside a run).
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
than copied onto the call. It names the run's id; the runtime adds the
rest.

```ts
interface ToolRun {
  readonly runId: RunId;
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
  /** The agent-file blocks the plugins own, by key (`Plugin.agentBlock`). */
  readonly blocks: ReadonlyMap<string, AgentBlock>;
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
