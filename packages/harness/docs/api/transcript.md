# `@texra-ai/harness/transcript`

<!-- Generated from `packages/harness/src/transcriptEntry.ts` by `npm run docgen`; do not edit. -->

Browser-safe transcript row projections and cross-process view
synchronization for UI renderers (CLI TUI, VS Code webviews, desktop
renderer, and static trace viewer).

> **Guide:** Read [Views, Transcripts & Renderers](/api/views-and-transcripts)
> for how `SessionView`, `RemoteSessionView`, and `TranscriptRow` fit
> together, with end-to-end rendering examples.

### Key exports by role

- **Cross-process view synchronization**: [`RemoteSessionView`](#remotesessionview)
  and [`SessionInputs`](#sessioninputs) keep a renderer's `SessionView` in
  sync across an IPC or message transport using ordered event batches
  ([`CommitOrdinalSchema`](#commitordinalschema),
  [`EventInputSchema`](#eventinputschema)), the other inputs a transport
  serves ([`SessionViewInputSchema`](#sessionviewinputschema)), and
  transcript subscriptions
  ([`TranscriptSubscriptionSchema`](#transcriptsubscriptionschema)).
- **Transcript row union**: [`TranscriptRow`](#transcriptrow) (with shared
  fields on [`TranscriptRowBase`](#transcriptrowbase)) discriminates on
  `kind` across [`UserRow`](#userrow),
  [`StreamingTextRow`](#streamingtextrow), [`ToolRow`](#toolrow),
  [`CompactionActivityRow`](#compactionactivityrow),
  [`ContextManagementRow`](#contextmanagementrow),
  [`WebSearchRow`](#websearchrow), [`ErrorRow`](#errorrow),
  [`FileListRow`](#filelistrow), [`LogRow`](#logrow), and
  [`ProgressStatusRow`](#progressstatusrow).
- **Structured tool cards**: [`ToolRowModel`](#toolrowmodel) and
  [`ToolSection`](#toolsection) (`ToolStatusSection`, `ToolBadgesSection`,
  `ToolDiffSection`, `ToolCodeSection`, `ToolTextSection`, `ToolFileSection`,
  `ToolFileListSection`, `ToolFileGroupsSection`) structure tool inputs and
  outputs without custom per-tool UI parsing.
- **Text budgets & headlines**: [`rowHeadline`](#rowheadline),
  [`transcriptText`](#transcripttext), [`elideText`](#elidetext), and
  [`TextBudget`](#textbudget) format and truncate row text for terminal and
  compact UIs.

## BASH_TOOL_DEFAULT_TIMEOUT_MS

Default `bash` tool timeout (ms) when the model omits `timeout`.

```ts
const BASH_TOOL_DEFAULT_TIMEOUT_MS: 120000
```

## buildMcpToolName

Build the `mcp:<server>/<tool>` wire name for an MCP tool call. Single
source of the `mcp:` contract so a plugin reporting an external agent's
MCP call and the recognition/display side here can't drift: if the producer used its own literal, a drift would silently make
`isMcpToolName` return false for every MCP call and names would render
verbatim.

```ts
function buildMcpToolName(server: string, tool: string): string
```

## CommitOrdinal

```ts
type CommitOrdinal = typeof CommitOrdinalSchema.Type;
```

## CommitOrdinalSchema

The session-wide insert ordinal a replay follows; zero is "before the
first commit", the cursor an empty view starts from. Local: no row
stores one.

```ts
const CommitOrdinalSchema: Int
```

## CompactionActivityBlock

One stable transcript block projected from a correlated activity lifecycle.

```ts
interface CompactionActivityBlock {
  readonly operationId: string;
  readonly status: CompactionActivityStatus;
  /** Whether the block may move into finalized transcript output. */
  readonly finalized: boolean;
  /** Source-log boundary that finalized an otherwise unmatched start. */
  readonly settledThroughSeqNo?: number;
  readonly startPosition: number;
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** What the compaction freed, from the `compaction` context-management
   *  entry the run writes just before the activity completes. */
  readonly freed?: {
    readonly tokens: number;
    readonly utilizationBefore: number;
    readonly utilizationAfter: number;
  };
}
```

## CompactionActivityRow

```ts
interface CompactionActivityRow extends TranscriptRowBase {
  readonly kind: 'compactionActivity';
  readonly block: CompactionActivityBlock;
  readonly label: string;
}
```

## CompactionActivityStatus

```ts
type CompactionActivityStatus =
  | 'running'
  | CompactionActivityOutcome
  | 'interrupted';
```

## compareByNewestCreationTime

Sort runs newest first, breaking ties alphabetically by id.

```ts
function compareByNewestCreationTime(
  a: { readonly id: string; readonly createdAt: number },
  b: { readonly id: string; readonly createdAt: number },
): number
```

## ContextManagementRow

```ts
interface ContextManagementRow extends TranscriptRowBase {
  readonly kind: 'contextManagement';
  readonly data: ContextManagementData;
  /** `Compacted`, `Cleared tool uses`, … */
  readonly label: string;
  readonly items: readonly StatItem[];
}
```

## decodeXmlEntities

```ts
function decodeXmlEntities(text: string): string
```

## dispatchedChildren

The runs `run` launched that are not a script's calls: what its dispatch
card lists (a direct `agent` call that detached, a background script's
run). A child whose card (`launch.card`) sits under a script stage, awaited
or sent to the background, has its one home in that stage's rows.

```ts
function dispatchedChildren<Run extends RunView>(
  run: Run,
  view: { readonly runs: ReadonlyMap<RunId, Run> },
): Run[]
```

## DisplayRowSchema

```ts
const DisplayRowSchema: Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly takesFollowUps: Boolean; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly call: NullOr<Struct<{ readonly callId: String; readonly card: String; readonly awaited: Boolean; }>>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly version: Int; readonly value: Codec<Json, Json, never, never>; readonly aggregateId: brand<String, "AggregateId">; readonly unavailable: optional<String>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.stop">; readonly reason: Literals<readonly ["user", "released", "shutdown"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["disk-full", "result-lost", "unexpected"]>; readonly message: String; }>, Struct<{ readonly kind: Literal<"model">; readonly failure: Union<readonly [Struct<{ readonly kind: Literals<readonly ["invalid-request", "authentication", "context-overflow", "continuation-gone", "transport", "provider-rejection"]>; readonly message: String; readonly status: optional<Int>; readonly requestId: optional<String>; readonly quota: optional<Struct<{ readonly plan: NullOr<Literals<("chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription")[]>>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>>; readonly source: Literal<"model">; readonly provider: optional<String>; readonly partialText: optional<String>; }>, Struct<{ readonly source: Literal<"route">; readonly provider: optional<String>; readonly message: String; readonly missingApiKey: optional<Literal<true>>; readonly session: optional<Struct<{ readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; }>>; }>, Struct<{ readonly source: Literal<"interrupted">; readonly provider: optional<String>; }>]>; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; readonly usage: optional<Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly responseTimeMs: Number; readonly provider: String; }>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly media: optional<$Array<Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: String; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; readonly disposition: Union<readonly [Struct<{ readonly kind: Literal<"turn">; readonly turn: Int; }>, Struct<{ readonly kind: Literal<"answered">; }>, Struct<{ readonly kind: Literal<"applied">; }>, Struct<{ readonly kind: Literal<"dropped">; readonly reason: Literals<readonly ["noop", "ended", "closed"]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; readonly content: String; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly failure: Union<readonly [Struct<{ readonly kind: Literals<readonly ["invalid-request", "authentication", "context-overflow", "continuation-gone", "transport", "provider-rejection"]>; readonly message: String; readonly status: optional<Int>; readonly requestId: optional<String>; readonly quota: optional<Struct<{ readonly plan: NullOr<Literals<("chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription")[]>>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>>; readonly source: Literal<"model">; readonly provider: optional<String>; readonly partialText: optional<String>; }>, Struct<{ readonly source: Literal<"route">; readonly provider: optional<String>; readonly message: String; readonly missingApiKey: optional<Literal<true>>; readonly session: optional<Struct<{ readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; }>>; }>, Struct<{ readonly source: Literal<"interrupted">; readonly provider: optional<String>; }>]>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly model: String; readonly instruction: String; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly workingDirectory: optional<NullOr<String>>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>, Struct<{ readonly kind: Literal<"plugin">; readonly plugin: String; readonly blocksCaller: Boolean; readonly answers: $Array<Literals<readonly ["approve", "approve_and_goal", "submit", "answer", "skip", "retry"]>>; readonly data: StructWithRest<Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; }>, readonly [$Record<String, Codec<Json, Json, never, never>>]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"process.output">; readonly stageId: optional<String>; readonly stream: Literals<readonly ["stdout", "stderr"]>; readonly text: String; readonly elided: optional<Int>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly section: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly cut: optional<Literals<readonly ["length", "content-filter"]>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>
```

## ElidedText

What an elision keeps: the head and tail lines, and how many it hid.

```ts
interface ElidedText {
  readonly head: readonly string[];
  readonly tail: readonly string[];
  /** Lines between `head` and `tail`; zero when nothing was hidden. */
  readonly hiddenLines: number;
}
```

## elideText

Split a text into the lines a host will paint under its own budget. The
elision only ever removes whole lines from the middle, so the first and
last lines of an output stay visible at any budget.

```ts
function elideText(
  text: TranscriptText,
  budget: TextBudget,
): ElidedText
```

## ErrorDetailKey

One of {@link ERROR_DETAIL_KEYS}.

```ts
type ErrorDetailKey = (typeof ERROR_DETAIL_KEYS)[number];
```

## ErrorRow

```ts
interface ErrorRow extends TranscriptRowBase {
  readonly kind: 'error';
  /** The failure headline. */
  readonly summary: TranscriptText;
  /** Canonical detail field set, in display order: a host shows each as a
   *  `key: value` line. */
  readonly details: readonly ErrorRowDetail[];
  /** The model call's failure the row records, as its verdict: an app
   *  with words of its own for it shows them where the row shows the
   *  verdict's plain words (the summary, or the `message` detail). */
  readonly failure?: ModelFailure;
}
```

## ErrorRowDetail

One `key: value` line of an error's detail block, pre-stringified so both
hosts show the same rendering of the same field.

```ts
interface ErrorRowDetail {
  readonly key: ErrorDetailKey;
  readonly value: string;
}
```

## EventInputSchema

The read that delivered a durable row: the cold listing, one
aggregate's history, or the tail. Only a tail row advances `cursor`.

```ts
const EventInputSchema: TaggedStruct<"event", { readonly read: Literals<readonly ["listing", "aggregate", "all"]>; readonly event: Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly takesFollowUps: Boolean; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly call: NullOr<Struct<{ readonly callId: String; readonly card: String; readonly awaited: Boolean; }>>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly version: Int; readonly value: Codec<Json, Json, never, never>; readonly aggregateId: brand<String, "AggregateId">; readonly unavailable: optional<String>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.stop">; readonly reason: Literals<readonly ["user", "released", "shutdown"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["disk-full", "result-lost", "unexpected"]>; readonly message: String; }>, Struct<{ readonly kind: Literal<"model">; readonly failure: Union<readonly [Struct<{ readonly kind: Literals<readonly ["invalid-request", "authentication", "context-overflow", "continuation-gone", "transport", "provider-rejection"]>; readonly message: String; readonly status: optional<Int>; readonly requestId: optional<String>; readonly quota: optional<Struct<{ readonly plan: NullOr<Literals<("chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription")[]>>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>>; readonly source: Literal<"model">; readonly provider: optional<String>; readonly partialText: optional<String>; }>, Struct<{ readonly source: Literal<"route">; readonly provider: optional<String>; readonly message: String; readonly missingApiKey: optional<Literal<true>>; readonly session: optional<Struct<{ readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; }>>; }>, Struct<{ readonly source: Literal<"interrupted">; readonly provider: optional<String>; }>]>; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; readonly usage: optional<Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly responseTimeMs: Number; readonly provider: String; }>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly media: optional<$Array<Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: String; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; readonly disposition: Union<readonly [Struct<{ readonly kind: Literal<"turn">; readonly turn: Int; }>, Struct<{ readonly kind: Literal<"answered">; }>, Struct<{ readonly kind: Literal<"applied">; }>, Struct<{ readonly kind: Literal<"dropped">; readonly reason: Literals<readonly ["noop", "ended", "closed"]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; readonly content: String; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly failure: Union<readonly [Struct<{ readonly kind: Literals<readonly ["invalid-request", "authentication", "context-overflow", "continuation-gone", "transport", "provider-rejection"]>; readonly message: String; readonly status: optional<Int>; readonly requestId: optional<String>; readonly quota: optional<Struct<{ readonly plan: NullOr<Literals<("chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription")[]>>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>>; readonly source: Literal<"model">; readonly provider: optional<String>; readonly partialText: optional<String>; }>, Struct<{ readonly source: Literal<"route">; readonly provider: optional<String>; readonly message: String; readonly missingApiKey: optional<Literal<true>>; readonly session: optional<Struct<{ readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; }>>; }>, Struct<{ readonly source: Literal<"interrupted">; readonly provider: optional<String>; }>]>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly model: String; readonly instruction: String; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly workingDirectory: optional<NullOr<String>>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>, Struct<{ readonly kind: Literal<"plugin">; readonly plugin: String; readonly blocksCaller: Boolean; readonly answers: $Array<Literals<readonly ["approve", "approve_and_goal", "submit", "answer", "skip", "retry"]>>; readonly data: StructWithRest<Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; }>, readonly [$Record<String, Codec<Json, Json, never, never>>]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"process.output">; readonly stageId: optional<String>; readonly stream: Literals<readonly ["stdout", "stderr"]>; readonly text: String; readonly elided: optional<Int>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly section: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly cut: optional<Literals<readonly ["length", "content-filter"]>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>; }>
```

## EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS

Default `executions wait` timeout (seconds) when the model omits `timeout`.

```ts
const EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS: 300
```

## executionsWaitTimeoutSeconds

The `executions wait` timeout the tool honours, in seconds: `timeout`
clamped to [{@link EXECUTIONS_WAIT_MIN_TIMEOUT_SECONDS},
{@link EXECUTIONS_WAIT_MAX_TIMEOUT_SECONDS}], or
{@link EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS} when it is not a finite
number.

```ts
function executionsWaitTimeoutSeconds(timeout: unknown): number
```

## FileListRow

```ts
interface FileListRow extends TranscriptRowBase {
  readonly kind: 'fileList';
  /** Every entry the loader reported, loaded and failed alike. */
  readonly files: readonly FileListEntry[];
  /** `Files (3/4 loaded, 1 not found)` — the one statement of partial load. */
  readonly summary: string;
  /** The subset a host can preview inline. Kept beside `files`, not instead
   *  of it: a failed or non-media attachment must stay visible. */
  readonly media: readonly LoadedMediaRef[];
}
```

## isMcpToolName

True for an MCP tool call: the harness's `mcp__<server>__<tool>` or an
external agent's `mcp:<server>/<tool>`.

```ts
function isMcpToolName(toolName: string): boolean
```

## isScriptCall

Whether a row is a script's call: a tool card under a stage. Only the
loop's script dispatch puts a card under a stage, so the stages that hold
one are a run's script stages.

```ts
function isScriptCall(row: ReadonlyDeep<TranscriptRow>): row is Extract<
  TranscriptRow,
  { kind: 'tool' }
> & {
  readonly stageId: string;
}
```

## LoadedMediaRef

A file that came through the media pipeline as visual/audio model input.

```ts
interface LoadedMediaRef {
  readonly path: string;
  readonly media: LoadedMediaMetadata;
}
```

## LogRow

A plain log line: a `default` row, or a row with no message type.

```ts
interface LogRow extends TranscriptRowBase {
  readonly kind: 'log';
  readonly text: TranscriptText;
}
```

## mcpServerOfToolName

The server an MCP tool name (or `mcp__<server>__*` wildcard) names, or
`undefined` for any other tool name.

```ts
function mcpServerOfToolName(name: string): string | undefined
```

## normalizeToolName

Canonical lookup key for a tool name: namespaces stripped, lowercased.
Every name-keyed display rule (`toolDisplayKind`,
`deriveToolInputPreview`, icon and label maps) keys off this, so a
namespaced name from a delegated sub-agent gets the same treatment as the
registry name it wraps.

```ts
function normalizeToolName(toolName: string): string
```

## PayloadLanguage

Serialization format {@link stringifyPayload} chose for a value.

```ts
type PayloadLanguage = 'yaml' | 'plaintext';
```

## ProgressStatusRow

A status note: its message, and no untyped payload beside it.

```ts
interface ProgressStatusRow extends TranscriptRowBase {
  readonly kind: 'progressStatus';
  readonly summary: TranscriptText;
  /** The used-up plan's route a quota fallback notice reports: the run
   *  retried on the model's own key without asking. An app words it; the
   *  summary is the harness's plain wording of the same fact. */
  readonly quotaFallback?: DeclinableUsageRoute;
}
```

## RemoteSessionView

A session's view built where its store is not: a webview, a renderer, a
client of another process. The caller serves `SessionInputs` from its
transport, in the order the store's reader produced them; the layer runs
the same updater over them a session runs over its store, keyed by the
session's storage root, and `subscribe` names the aggregates each of the
caller's ports wants transcripts for (an empty set removes the port).

```ts
class RemoteSessionView extends Context.Service<
  RemoteSessionView,
  {
    /** The current view. */
    readonly current: () => ReadonlySessionView;
    /** The current view, then every later one; as
     *  `SessionViewService.changes`, it ends, or dies, with the updates. */
    readonly changes: Stream.Stream<ReadonlySessionView>;
    /** Subscribe `set`'s transcripts for the caller's scope; the handle
     *  replaces the set. */
    readonly subscribe: (
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<TranscriptInterest, never, Scope.Scope>;
  }
>()('@texra-ai/harness/session/RemoteSessionView')
```

## rowHeadline

The headline a row leads with: its own text, untrimmed and unsanitized;
a host sanitizes for its surface at paint.

```ts
function rowHeadline(row: ReadonlyDeep<TranscriptRow>): string
```

## ScriptCallStatus

```ts
type ScriptCallStatus =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'finished'
  | 'reused'
  | 'skipped'
  | 'cancelled'
  | 'failed'
  | 'not run';
```

## ScriptCallView

```ts
interface ScriptCallView {
  /** The card's id (`logId`). */
  readonly id: string;
  readonly toolName: string;
  /** An `agent` call's label or agent; any other call's tool and preview. */
  readonly label: string;
  readonly status: ScriptCallStatus;
  readonly section: string | null;
  /** `drafter · gpt-5 · retried · a.md · 1m 12s · $0.31` */
  readonly facts: readonly string[];
  /** What the row says first: its error, a note, or a run's request. */
  readonly detail?:
    | { readonly kind: 'error'; readonly text: string }
    | { readonly kind: 'notRun' | 'interrupted' }
    | {
        readonly kind: 'request';
        readonly payload: ReadonlyDeep<RequestPayload>;
      };
  /** The child run an `agent` call launched: the row opens it. */
  readonly childRunId?: RunId;
  /** The run under the call waiting on the user: Review opens it. */
  readonly askingRunId?: RunId;
  /** A run under the call waits on a request this window can answer. */
  readonly needsYou: boolean;
  /** An agent row whose agent takes a message here now (`acceptsFollowUp`,
   *  the rule the composer it opens reads): opening it is talking to it
   *  (a host's talk-to-agent action). Any other agent opens read-only. */
  readonly talkable: boolean;
  /** A finished agent's answer, else what its child last said, cut to its
   *  first line: never the delivery envelope or later paragraphs. */
  readonly summary?: string;
}
```

## ScriptSectionView

```ts
interface ScriptSectionView {
  /** The guest's `section()` title; null before its first. */
  readonly title: string | null;
  /** The section's calls, in issue order. */
  readonly calls: readonly ScriptCallView[];
}
```

## scriptStages

The script stages of a run's transcript, oldest first: one per `script`
call that issued a call, its calls in issue order (first appearance) and
grouped by section.

```ts
function scriptStages(
  run: RunView,
  view: Pick<SessionView, 'runs' | 'requests'>,
): ScriptStageView[]
```

## ScriptStageView

```ts
interface ScriptStageView {
  /** The stage's id; its calls' cards carry it as their `stageId`. */
  readonly id: string;
  /** The outcome its stage closed with; null while it is open. */
  readonly outcome: Stage['outcome'];
  /** Every call, in issue order. */
  readonly calls: readonly ScriptCallView[];
  readonly sections: readonly ScriptSectionView[];
  /** How many of `calls` run a child, and how many wait on this window. */
  readonly agents: number;
  readonly needsYou: number;
  /** What every child its calls launched has cost so far, their own
   *  agents included (`treeUsage`), discarded attempts included. */
  readonly costUsd: number;
}
```

## SessionInputs

```ts
class SessionInputs extends Context.Service<
  SessionInputs,
  {
    /** A complete replay batch followed by ordered event, text, and local
     *  batches. A reader never observes a partially collected replay. */
    readonly read: (
      aggregates: readonly TranscriptSubscription[],
      fromCommit: CommitOrdinal,
      previousDebug: boolean,
    ) => Stream.Stream<readonly SessionViewInput[]>;
  }
>()('@texra-ai/harness/session/SessionInputs')
```

## SessionViewInput

```ts
type SessionViewInput = typeof SessionViewInputSchema.Type;
```

## SessionViewInputSchema

One input of the session view, as the reader orders them: what a frame
carries across a wire.

```ts
const SessionViewInputSchema: Union<readonly [TaggedStruct<"event", { readonly read: Literals<readonly ["listing", "aggregate", "all"]>; readonly event: Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly takesFollowUps: Boolean; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly call: NullOr<Struct<{ readonly callId: String; readonly card: String; readonly awaited: Boolean; }>>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly version: Int; readonly value: Codec<Json, Json, never, never>; readonly aggregateId: brand<String, "AggregateId">; readonly unavailable: optional<String>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.stop">; readonly reason: Literals<readonly ["user", "released", "shutdown"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly kind: Literals<readonly ["disk-full", "result-lost", "unexpected"]>; readonly message: String; }>, Struct<{ readonly kind: Literal<"model">; readonly failure: Union<readonly [Struct<{ readonly kind: Literals<readonly ["invalid-request", "authentication", "context-overflow", "continuation-gone", "transport", "provider-rejection"]>; readonly message: String; readonly status: optional<Int>; readonly requestId: optional<String>; readonly quota: optional<Struct<{ readonly plan: NullOr<Literals<("chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription")[]>>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>>; readonly source: Literal<"model">; readonly provider: optional<String>; readonly partialText: optional<String>; }>, Struct<{ readonly source: Literal<"route">; readonly provider: optional<String>; readonly message: String; readonly missingApiKey: optional<Literal<true>>; readonly session: optional<Struct<{ readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; }>>; }>, Struct<{ readonly source: Literal<"interrupted">; readonly provider: optional<String>; }>]>; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: String; readonly files: $Array<String>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; readonly usage: optional<Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly responseTimeMs: Number; readonly provider: String; }>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly media: optional<$Array<Struct<{ readonly mimeType: String; readonly digest: String; readonly name: String; }>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: String; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; readonly disposition: Union<readonly [Struct<{ readonly kind: Literal<"turn">; readonly turn: Int; }>, Struct<{ readonly kind: Literal<"answered">; }>, Struct<{ readonly kind: Literal<"applied">; }>, Struct<{ readonly kind: Literal<"dropped">; readonly reason: Literals<readonly ["noop", "ended", "closed"]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; readonly content: String; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly failure: Union<readonly [Struct<{ readonly kind: Literals<readonly ["invalid-request", "authentication", "context-overflow", "continuation-gone", "transport", "provider-rejection"]>; readonly message: String; readonly status: optional<Int>; readonly requestId: optional<String>; readonly quota: optional<Struct<{ readonly plan: NullOr<Literals<("chatgpt-subscription" | "xai-subscription" | "kimi-code-subscription" | "glm-coding-plan-subscription")[]>>; readonly planType: optional<String>; readonly resetsInMs: optional<Int>; }>>; readonly source: Literal<"model">; readonly provider: optional<String>; readonly partialText: optional<String>; }>, Struct<{ readonly source: Literal<"route">; readonly provider: optional<String>; readonly message: String; readonly missingApiKey: optional<Literal<true>>; readonly session: optional<Struct<{ readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription"]>; readonly needsReauth: Boolean; }>>; }>, Struct<{ readonly source: Literal<"interrupted">; readonly provider: optional<String>; }>]>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly model: String; readonly instruction: String; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly workingDirectory: optional<NullOr<String>>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly offersGrant: Boolean; readonly runId: brand<String, "RunId">; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>, Struct<{ readonly kind: Literal<"plugin">; readonly plugin: String; readonly blocksCaller: Boolean; readonly answers: $Array<Literals<readonly ["approve", "approve_and_goal", "submit", "answer", "skip", "retry"]>>; readonly data: StructWithRest<Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; }>, readonly [$Record<String, Codec<Json, Json, never, never>>]>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"process.output">; readonly stageId: optional<String>; readonly stream: Literals<readonly ["stdout", "stderr"]>; readonly text: String; readonly elided: optional<Int>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly section: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cachedInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheWriteTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly toolUsePromptTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly QUOTA_FALLBACK: "quotaFallback"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly cut: optional<Literals<readonly ["length", "content-filter"]>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>; }>, TaggedStruct<"chunk", { readonly runId: brand<String, "RunId">; readonly rowId: String; readonly from: Int; readonly to: Int; readonly text: String; }>, TaggedStruct<"debug", { readonly enabled: Boolean; }>, TaggedStruct<"local", { readonly local: Struct<{ readonly runsHere: $Array<brand<String, "RunId">>; }>; }>, TaggedStruct<"subscriptions", { readonly set: $Array<Struct<{ readonly id: brand<String, "AggregateId">; readonly fromSeq: Int; }>>; }>, TaggedStruct<"replay.complete", { readonly existence: Struct<{ readonly checkedAggregateIds: $Array<brand<String, "AggregateId">>; readonly present: $Array<brand<String, "AggregateId">>; readonly unreadable: $Array<Struct<{ readonly runId: brand<String, "RunId">; readonly reason: Literals<readonly ["damaged", "earlierBuild"]>; }>>; }>; }>, TaggedStruct<"drained", { readonly cursor: Int; readonly existence: Struct<{ readonly checkedAggregateIds: $Array<brand<String, "AggregateId">>; readonly present: $Array<brand<String, "AggregateId">>; readonly unreadable: $Array<Struct<{ readonly runId: brand<String, "RunId">; readonly reason: Literals<readonly ["damaged", "earlierBuild"]>; }>>; }>; }>]>
```

## StatItem

One labeled number from a context-management row.

```ts
interface StatItem {
  /** Stable key hosts use to pick an icon; never shown as-is. */
  readonly key: string;
  readonly label: string;
  readonly value: string;
}
```

## StreamingTextRow

Model text, thinking, and scratchpad share one shape: streaming markdown.

```ts
interface StreamingTextRow extends TranscriptRowBase {
  readonly kind: 'assistant' | 'thinking' | 'scratchpad';
  readonly text: TranscriptText;
  /** True while the producer is still appending to `text`. */
  readonly streaming: boolean;
  /** True while the text hides an embedded subagent block that has opened but
   *  not closed. Blocks settlement: the visible text is still going to move. */
  readonly pendingEmbeddedFollowup?: boolean;
  /** The limit that ended an assistant's answer early, from its
   *  `response.finalized` row; each reader words it. */
  readonly cut?: ResponseCut;
}
```

## summarizeEmbeddedSubagentFollowups

```ts
function summarizeEmbeddedSubagentFollowups(text: string): string
```

## TextBudget

Head/tail line budget a host chooses for one paint.

```ts
interface TextBudget {
  readonly headLines: number;
  readonly tailLines: number;
}
```

## TimelineEntry

One entry of the layout: a row no stage holds, or a stage and its rows.

```ts
type TimelineEntry<
  Row extends Pick<TranscriptRow, 'id' | 'seqNo' | 'stageId'>,
  S extends Stage = Stage,
> =
  | { readonly kind: 'row'; readonly row: Row }
  | { readonly kind: 'stage'; readonly stage: S; readonly rows: Row[] };
```

## ToolBadgesSection

A section of short badges.

```ts
interface ToolBadgesSection extends ToolSectionBase {
  readonly kind: 'badges';
  readonly badges: readonly string[];
}
```

## ToolCodeSection

```ts
interface ToolCodeSection extends ToolSectionBase {
  readonly kind: 'code';
  readonly text: TranscriptText;
  /** Highlighting hint: a language id, or the serializer that produced it. */
  readonly language: string | PayloadLanguage;
}
```

## ToolDiffSection

A section showing one hunk's old and new text.

```ts
interface ToolDiffSection extends ToolSectionBase {
  readonly kind: 'diff';
  readonly oldText: string;
  readonly newText: string;
  /** Painter label for this hunk when no real file section can represent it. */
  readonly fileLabel?: string;
}
```

## toolDisplayKind

Look up a tool's display kind. The name is normalized first, so a
provider-namespaced name from a delegated sub-agent (`claude:Bash`) or an
MCP-wrapped one (`mcp:terminal/bash`) gets the same treatment as the
canonical name it wraps. Returns `undefined` for tools that use the
generic display treatment. Guarded with `Object.hasOwn` so an arbitrary
tool name (e.g. `toString`, `__proto__`) cannot resolve to an inherited
`Object.prototype` member.

```ts
function toolDisplayKind(toolName: string): ToolDisplayKind | undefined
```

## ToolDisplayKind

```ts
type ToolDisplayKind = 'edit' | 'read' | 'write' | 'bash' | 'script';
```

## ToolFileGroupsSection

```ts
interface ToolFileGroupsSection extends ToolSectionBase {
  readonly kind: 'fileGroups';
  readonly groups: readonly ProposalFileGroup[];
}
```

## ToolFileListSection

```ts
interface ToolFileListSection extends ToolSectionBase {
  readonly kind: 'fileList';
  readonly files: readonly ToolSectionFile[];
}
```

## ToolFileNamespace

Which path vocabulary a {@link ToolFileSection} names.

```ts
type ToolFileNamespace = 'workspace' | 'memory' | 'run';
```

## ToolFileSection

```ts
interface ToolFileSection extends ToolSectionBase {
  readonly kind: 'file';
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly namespace: ToolFileNamespace;
}
```

## ToolIdentifierSection

A section naming one identifier (an agent, a model, a command).

```ts
interface ToolIdentifierSection extends ToolSectionBase {
  readonly kind: 'identifier';
  readonly value: string;
  /** Parenthetical qualifier, e.g. the model an agent runs on. */
  readonly note?: string;
}
```

## ToolOutputSuppression

Why the generic output block carries nothing for this call. Absent when the
output is shown.

```ts
type ToolOutputSuppression =
  | 'empty'
  | 'duplicate-of-header'
  | 'duplicate-of-error'
  | 'rendered-by-sections'
  | 'file-link'
  | 'trivial-write';
```

## ToolRow

```ts
interface ToolRow extends TranscriptRowBase {
  readonly kind: 'tool';
  readonly toolUse: NormalizedToolUse;
  readonly model: ToolRowModel;
  /** The decoded durable payload the row was built from, without live
   *  output: what a conversation export formats. */
  readonly log: ToolUseLog;
  /** A script's call's section, as its card's `tool.start` names it. */
  readonly section?: string;
  /** The call's attempt, from the second on (its card's `tool.start`). */
  readonly attempt?: number;
  /** The run waited or ended while the call was open: the call never
   *  finished, so nothing records how it ended, and the row reads failed.
   *  A result that lands once the run runs again replaces it. The row
   *  holds no text for it; each reader words it. */
  readonly cutByRunEnd?: true;
}
```

## ToolRowModel

```ts
interface ToolRowModel {
  /** Tool name as a user reads it (`MCP fs/read`, `Multi-agent workflow`). */
  readonly headerLabel: string;
  /** Untruncated single-line "what is this call doing" text; `''` when the
   *  call says nothing beyond its name. Hosts cut it to their own width. */
  readonly headerPreview: string;
  readonly sections: readonly ToolSection[];
  /** Untruncated tool output; present only when {@link showOutput}. */
  readonly output?: TranscriptText;
  /** Untruncated error text. Named `preview` because hosts cut it. */
  readonly errorPreview?: TranscriptText;
  /** The instruction a user typed when rejecting or redirecting the call. */
  readonly userInstruction?: TranscriptText;
  readonly showOutput: boolean;
  readonly outputSuppression?: ToolOutputSuppression;
  /** A completed shell or MCP call that printed nothing: "it ran and printed
   *  nothing" is a result for a call whose output is the point. */
  readonly showsNoOutputMarker: boolean;
  readonly status?: ToolCallStatus;
  readonly isError: boolean;
  readonly isUserFeedback: boolean;
  readonly isInProgress: boolean;
  readonly exitCode?: number;
}
```

## ToolSection

```ts
type ToolSection =
  | ToolTextSection
  | ToolCodeSection
  | ToolIdentifierSection
  | ToolFileSection
  | ToolFileGroupsSection
  | ToolFileListSection
  | ToolDiffSection
  | ToolBadgesSection
  | ToolStatusSection;
```

## ToolSectionBase

What every tool-row section carries.

```ts
interface ToolSectionBase {
  /** Display prefix (`Files:`, `Instruction:`); empty for an unlabeled body. */
  readonly label: string;
}
```

## ToolSectionFile

One file row inside a {@link ToolFileListSection}.

```ts
interface ToolSectionFile {
  readonly path: string;
  /** Source path when the call maps a produced file onto a different one. */
  readonly from?: string;
  /** Parenthetical qualifier for this file alone — a patch's change kind
   *  (`add`/`update`/`delete`), for instance. */
  readonly note?: string;
  readonly lineChanges?: { readonly added: number; readonly removed: number };
}
```

## ToolStatusSection

A section stating a status: running, finished or failed. A plugin
reporting another agent's work states it in this one vocabulary.

```ts
interface ToolStatusSection extends ToolSectionBase {
  readonly kind: 'status';
  readonly status: ToolCallStatus;
}
```

## ToolTextSection

```ts
interface ToolTextSection extends ToolSectionBase {
  readonly kind: 'text';
  readonly text: TranscriptText;
}
```

## TranscriptInterest

One subscriber's transcript set, held for the scope that subscribed it.

```ts
interface TranscriptInterest {
  /** Replace the set. */
  readonly set: (
    next: readonly TranscriptSubscription[],
  ) => Effect.Effect<void>;
}
```

## TranscriptRow

```ts
type TranscriptRow =
  | StreamingTextRow
  | UserRow
  | ErrorRow
  | ToolRow
  | WebSearchRow
  | FileListRow
  | ContextManagementRow
  | ProgressStatusRow
  | CompactionActivityRow
  | LogRow;
```

## TranscriptRowBase

Fields every row carries, stamped by the transcript fold from the event
that wrote it. Optional keys are spread-omitted rather than set to
`undefined`, so a row built from the same facts twice is structurally
identical.

```ts
interface TranscriptRowBase {
  /** The writing event's id (a card's, a stream's, a stage's) or its durable
   *  coordinates; stable across deltas. */
  readonly id: string;
  /** First-appearance order of the row within its run's transcript. */
  readonly seqNo?: number;
  /** Order in which the source row became printable, when it has settled. */
  readonly settlementSeqNo?: number;
  readonly timestamp: number;
  readonly level: LogLevel;
  /** True when the row belongs to the verbose tier of its host's chrome. */
  readonly verbose?: boolean;
  /** The stage the row belongs to (`Stage.id`), from its event's
   *  `stageId`. */
  readonly stageId?: string;
  /** Source vocabulary. Absent on the one row with no message type of its
   *  own, `compactionActivity` (a projection). */
  readonly messageType?: MessageType;
  /** Present when a host synthesized this row rather than the fold building
   *  it from an event: a local notice the run itself never recorded. Such a
   *  row is immutable from birth, carries the host's own id, and takes its
   *  place in the order where the host merges it into the run's rows. */
  readonly origin?: 'local';
}
```

## TranscriptRowKind

```ts
type TranscriptRowKind = TranscriptRow['kind'];
```

## TranscriptSubscription

```ts
type TranscriptSubscription =
  (typeof TranscriptSubscriptionSchema)['Type'];
```

## TranscriptSubscriptionSchema

The aggregates whose transcripts the view holds, each with the seq its
history is read from. Every value of the set is a view input: an
aggregate entering it gets its `transcriptSeq` entry, one leaving it loses
its transcript.

```ts
const TranscriptSubscriptionSchema: Struct<{ readonly id: brand<String, "AggregateId">; readonly fromSeq: Int; }>
```

## transcriptText

```ts
function transcriptText(raw: string): TranscriptText
```

## TranscriptText

One text-bearing field of a transcript row.

```ts
interface TranscriptText {
  /** Lines in the untruncated text; a trailing newline is not a line. */
  readonly lineCount: number;
  /** The complete text, exactly as the producer wrote it. */
  readonly full: string;
  /** Whitespace-collapsed single line — still untruncated. For one-line
   *  density paints and for equality tests between two texts. */
  readonly oneLine: string;
}
```

## transcriptTimeline

The transcript's stages, each with its rows, among its other rows.

```ts
function transcriptTimeline<
  Row extends Pick<TranscriptRow, 'id' | 'seqNo' | 'stageId'>,
  S extends Stage,
>(transcript: {
  readonly rows: readonly Row[];
  readonly stages: readonly S[];
}): TimelineEntry<Row, S>[]
```

## UserRow

```ts
interface UserRow extends TranscriptRowBase {
  readonly kind: 'user';
  /** The message as its follow-up shows it: a delivery or notice is its
   *  summary (`FollowUpContent.displayText`), not its envelope. */
  readonly text: TranscriptText;
  /** A script delivery's facts, typed. */
  readonly scriptSummary?: ReadonlyDeep<ScriptDeliverySummary>;
  /** Media that was sent to the model beside the text, by kind (no bytes). */
  readonly attachments?: readonly MediaAttachmentKind[];
  /** What a follow-up attached, by address, which "Fork from here" carries. */
  readonly media?: readonly StoredMedia[];
  /** The settled point "Fork from here" cuts at: the `seq` of the park the
   *  run stood at before it took this message. Absent on the first message,
   *  which no park precedes. */
  readonly forkAt?: number;
}
```

## viewDiagnosticsLayer

The logger of a view's runtime, which builds no process diagnostics layer:
each entry takes the log sink's write path, redacted unless a host marked
the sink trusted, instead of Effect's default console logger. An entry
keeps its level: fork-failure reports and fold defects show in DevTools
as the errors they are.

```ts
const viewDiagnosticsLayer: Layer.Layer<never>
```

## WebSearchRow

A web search the model ran; its headline is the query ({@link rowHeadline}).

```ts
interface WebSearchRow extends TranscriptRowBase {
  readonly kind: 'webSearch';
  readonly query?: string;
}
```

## withForkFailureReporting

A runtime whose `runFork` reports a fiber's failure or defect on exit.
`Fiber.addObserver` fires on every exit, including fibers a
caller later `Fiber.join`s, so a joined failure is logged here and still
delivered to the joiner. A success stays silent, as does an exit made of
interrupts alone or of interrupts beside Effect's end-of-stream `Done`.
`runPromise` and `runSync` hand their exits to the caller already.

```ts
function withForkFailureReporting<R, ER>(
  runtime: ManagedRuntime.ManagedRuntime<R, ER>,
): ManagedRuntime.ManagedRuntime<R, ER>
```
