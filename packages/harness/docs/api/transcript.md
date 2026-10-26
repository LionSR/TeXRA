# `@texra-ai/harness/transcript`

<!-- Generated from `packages/harness/src/transcriptEntry.ts` by `npm run docgen`; do not edit. -->

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
  'running' | CompactionActivityOutcome | 'interrupted';
```

## compareByNewestCreationTime

Sort runs newest first, breaking ties alphabetically by id.

```ts
function compareByNewestCreationTime(
  a: { readonly id: string; readonly createdAt: number },
  b: { readonly id: string; readonly createdAt: number },
): number
```

## compareBySeqNo

Compare transcript rows by their wire append sequence (`seqNo`), falling
back to a wall-clock key when either row predates sequence tracking.

Live rows (both carrying a usable positive `seqNo`) sort by that sequence —
immune to clock skew and timestamp ties — with the fallback key as the
tie-break. Archived/compat rows, or a mix of row generations, keep the
caller's fallback chronology. `seqNoOf` and `fallbackTimeOf` let the same
rule serve message rows (`timestamp`) and group rows (`startTime`).

```ts
function compareBySeqNo<T>(
  a: T,
  b: T,
  seqNoOf: (item: T) => number | undefined,
  fallbackTimeOf: (item: T) => number,
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
  readonly summary?: TranscriptText;
}
```

## decodeXmlEntities

```ts
function decodeXmlEntities(text: string): string
```

## DELIVERY_TAG

Canonical tag names, referenced by producers instead of string literals.

```ts
const DELIVERY_TAG: { readonly subagentProgress: "subagent-progress"; readonly subagentResult: "subagent-result"; readonly subagentError: "subagent-error"; readonly backgroundResult: "background-result"; readonly backgroundError: "background-error"; readonly codexResult: "codex-result"; readonly codexError: "codex-error"; readonly claudeAgentResult: "claude-agent-result"; readonly claudeAgentError: "claude-agent-error"; readonly scriptResult: "script-result"; readonly scriptError: "script-error"; readonly childPaused: "child-paused"; readonly githubWebhookActivity: "github-webhook-activity"; }
```

## DELIVERY_TAGS

Every recognized child-run delivery-envelope tag, in no particular order.

```ts
const DELIVERY_TAGS: readonly DeliveryTagEntry[]
```

## DeliveryTagEntry

```ts
interface DeliveryTagEntry {
  readonly tag: DeliveryTagName;
  /**
   * Whether the envelope body is XML-entity-escaped (via `escapeText()` in
   * the producer) and needs `decodeXmlEntities()` before display.
   * `github-webhook-activity` neutralizes embedded tag names instead
   * rather than XML-entity-escaping, so it is not in the escaped subset.
   */
  readonly escaped: boolean;
}
```

## DeliveryTagName

Every canonical tag name — the union `DELIVERY_TAGS` entries must draw from.

```ts
type DeliveryTagName = (typeof DELIVERY_TAG)[keyof typeof DELIVERY_TAG];
```

## deliveryTagOf

The delivery-envelope tag `text` opens with, or undefined when the text is
not one of these blocks. The single recognizer for "is this a child-run
delivery envelope", shared by the CLI transcript, the queued follow-ups
panel, and the progress-view message bubble. Leading whitespace is allowed
because producers hand blocks to the render surfaces untrimmed.

```ts
function deliveryTagOf(text: string): DeliveryTagName | undefined
```

## dispatchedChildren

The runs `run` launched that are not a script's calls: what its dispatch
card lists (a direct `agent` call that detached, a background script's
run). A child whose card (`parentCard`) sits under a script stage, awaited
or sent to the background, has its one home in that stage's rows.

```ts
function dispatchedChildren<Run extends RunView>(
  run: Run,
  view: { readonly runs: ReadonlyMap<RunId, Run> },
): Run[]
```

## DisplaySessionEventSchema

```ts
const DisplaySessionEventSchema: Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly userFollowUpSupport: Enum<{ readonly UNSUPPORTED: "unsupported"; readonly NATIVE_INTERACTIVE: "nativeInteractive"; readonly TERMINAL_BACKED: "terminalBacked"; }>; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly callId: NullOr<String>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly parentCard: optional<NullOr<String>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.model">; readonly model: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly message: optional<String>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["abort", "disk-full", "result-lost"]>; }>, Struct<{ readonly message: optional<String>; readonly statusCode: optional<optional<Int>>; readonly statusText: optional<optional<String>>; readonly provider: optional<optional<String>>; readonly classification: optional<optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>>; readonly requestId: optional<optional<String>>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["context-window", "missing-api-key", "unexpected"]>; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: withDecodingDefault<String, never>; readonly files: withDecodingDefault<$Array<String>, never>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"conversation.progress">; readonly progress: Struct<{ readonly toolCallCount: Number; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.fact">; readonly fact: Struct<{ readonly key: Literal<"plan">; readonly plan: NullOr<Struct<{ readonly objective: String; }>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"child.park">; readonly phase: Literals<readonly ["parked", "resumed", "paused"]>; readonly resumeId: optional<String>; readonly heldFor: optional<String>; readonly ends: optional<Literals<readonly ["completed", "failed"]>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly plugin: String; readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly value: Codec<Json, Json, never, never>; readonly version: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly followUpId: String; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: Literal<"github">; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn", "generation"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly errorMessage: optional<String>; readonly errorDetails: optional<Struct<{ readonly message: optional<String>; readonly statusCode: optional<optional<Int>>; readonly statusText: optional<optional<String>>; readonly provider: optional<optional<String>>; readonly classification: optional<optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>>; readonly requestId: optional<optional<String>>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; }>>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly model: String; readonly instruction: String; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"externalInquiry">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly question: String; readonly threadId: decodeTo<String, String, never, never>; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; readonly sessionLinks: optional<NullOr<$Array<Trim>>>; readonly transcript: optional<NullOr<$Array<Union<readonly [Struct<{ readonly kind: Literal<"open">; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly kind: Literal<"answered">; readonly answer: String; readonly answeredAt: String; readonly sessionLinks: optional<NullOr<$Array<Trim>>>; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>]>>>>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting", "halted"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly parentId: optional<NullOr<String>>; readonly kind: optional<NullOr<Literals<readonly ["run", "session", "script"]>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly phase: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: String; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cacheReadInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheCreationInputTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly elapsedTime: optional<Number>; readonly toolUseTokens: optional<Int>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>
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

## ErrorRow

```ts
interface ErrorRow extends TranscriptRowBase {
  readonly kind: 'error';
  /** The failure headline. */
  readonly summary: TranscriptText;
  /** Canonical detail field set, in display order. */
  readonly details: readonly ErrorRowDetail[];
  /** The detail block as one text, for copy affordances and full-output
   *  readers. */
  readonly detailText: TranscriptText;
}
```

## ErrorRowDetail

One `key: value` line of an error's detail block, pre-stringified so both
hosts show the same rendering of the same field.

```ts
interface ErrorRowDetail {
  readonly key: keyof ErrorLogData;
  readonly value: string;
}
```

## EventInputSchema

The read that delivered a durable row: the cold listing, one
aggregate's history, or the tail. Only a tail row advances `cursor`.

```ts
const EventInputSchema: Struct<{ readonly _tag: Literal<"event">; readonly read: Literals<readonly ["listing", "aggregate", "all"]>; readonly event: Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly userFollowUpSupport: Enum<{ readonly UNSUPPORTED: "unsupported"; readonly NATIVE_INTERACTIVE: "nativeInteractive"; readonly TERMINAL_BACKED: "terminalBacked"; }>; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly callId: NullOr<String>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly parentCard: optional<NullOr<String>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.model">; readonly model: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly message: optional<String>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["abort", "disk-full", "result-lost"]>; }>, Struct<{ readonly message: optional<String>; readonly statusCode: optional<optional<Int>>; readonly statusText: optional<optional<String>>; readonly provider: optional<optional<String>>; readonly classification: optional<optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>>; readonly requestId: optional<optional<String>>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["context-window", "missing-api-key", "unexpected"]>; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: withDecodingDefault<String, never>; readonly files: withDecodingDefault<$Array<String>, never>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"conversation.progress">; readonly progress: Struct<{ readonly toolCallCount: Number; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.fact">; readonly fact: Struct<{ readonly key: Literal<"plan">; readonly plan: NullOr<Struct<{ readonly objective: String; }>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"child.park">; readonly phase: Literals<readonly ["parked", "resumed", "paused"]>; readonly resumeId: optional<String>; readonly heldFor: optional<String>; readonly ends: optional<Literals<readonly ["completed", "failed"]>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly plugin: String; readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly value: Codec<Json, Json, never, never>; readonly version: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly followUpId: String; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: Literal<"github">; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn", "generation"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly errorMessage: optional<String>; readonly errorDetails: optional<Struct<{ readonly message: optional<String>; readonly statusCode: optional<optional<Int>>; readonly statusText: optional<optional<String>>; readonly provider: optional<optional<String>>; readonly classification: optional<optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>>; readonly requestId: optional<optional<String>>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; }>>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly model: String; readonly instruction: String; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"externalInquiry">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly question: String; readonly threadId: decodeTo<String, String, never, never>; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; readonly sessionLinks: optional<NullOr<$Array<Trim>>>; readonly transcript: optional<NullOr<$Array<Union<readonly [Struct<{ readonly kind: Literal<"open">; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly kind: Literal<"answered">; readonly answer: String; readonly answeredAt: String; readonly sessionLinks: optional<NullOr<$Array<Trim>>>; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>]>>>>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting", "halted"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly parentId: optional<NullOr<String>>; readonly kind: optional<NullOr<Literals<readonly ["run", "session", "script"]>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly phase: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: String; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cacheReadInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheCreationInputTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly elapsedTime: optional<Number>; readonly toolUseTokens: optional<Int>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>; }>
```

## EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS

Default `executions wait` timeout (seconds) when the model omits `timeout`.

```ts
const EXECUTIONS_WAIT_DEFAULT_TIMEOUT_SECONDS: 300
```

## executionsWaitTimeoutSeconds

The `executions wait` timeout the tool will actually honour, in seconds.
Sole owner of the clamp: the tool's own input schema normalizes through it,
and both transcript surfaces read it back so no host can invent a different
number than the one the wait enforces.

```ts
function executionsWaitTimeoutSeconds(timeout: unknown): number
```

## ExistenceReconciliation

```ts
type ExistenceReconciliation =
  (typeof ExistenceReconciliationSchema)['Type'];
```

## ExistenceReconciliationSchema

Current ownership for exactly the scope a finite read checked: a checked
aggregate with no claim entry no longer exists.

```ts
const ExistenceReconciliationSchema: Struct<{ readonly checkedAggregateIds: $Array<brand<String, "AggregateId">>; readonly claims: $Array<Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly ownerId: NullOr<String>; }>>; }>
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

## formatCompactDuration

Compact duration capped at two units (`45s`, `3m 5s`, `1h 1m`).

Backed by `pretty-ms` with whole-second flooring,
but renders zero / negative / sub-second durations as `0s` (used by elapsed
displays that start from zero, e.g. goal timings and server uptime).

```ts
function formatCompactDuration(durationMs: number): string
```

## formatCompactTokenCount

Format token counts for compact usage displays.

Token displays intentionally stay raw until they exceed 4096, the common
small-context threshold where an abbreviated number starts buying space. Once
k-format rounding would print `1000k`, switch to `M` instead.

```ts
function formatCompactTokenCount(tokens: number): string
```

## formatCostUsd

Format a USD cost value as a display string with three decimal places.
e.g. `0.012` → `'$0.012'`

```ts
function formatCostUsd(cost: number): string
```

## formatResultCount

Format a result count with proper pluralization.
Example: formatResultCount(3, 'result') returns "3 results"

```ts
function formatResultCount(
  count: number,
  singular: string,
  plural?: string,
): string
```

## formatScriptDeliverySummary

Collapse a parsed workflow delivery summary to its transcript lines. The
tick is earned only by a run whose every call succeeded; a completed run
with a failed, stopped, or unreached call says so in its marker too.

```ts
function formatScriptDeliverySummary(
  summary: ScriptDeliverySummary,
): string
```

## isMcpToolName

True for an MCP tool call: the harness's `mcp__<server>__<tool>` or an
external agent's `mcp:<server>/<tool>`.

```ts
function isMcpToolName(toolName: string): boolean
```

## LoadedMediaRef

A file that came through the media pipeline as visual/audio model input.

```ts
interface LoadedMediaRef {
  readonly path: string;
  readonly media: LoadedMediaMetadata;
}
```

## LocalRuntimeStateSchema

Process-local liveness evidence: self, explicitly proved-dead owners, and
unreadable runs. A current claimant absent from these verdicts is
unprovable and remains held until a probe establishes otherwise. Beside
it, the runs a resume found blocked: `retry` when one was asked for, so
the run continues once what it needs is back.

```ts
const LocalRuntimeStateSchema: Struct<{ readonly self: $Array<String>; readonly dead: $Array<String>; readonly unreadable: $Array<Struct<{ readonly runId: brand<String, "RunId">; readonly reason: Literals<readonly ["damaged", "earlierBuild"]>; }>>; readonly resumeBlocked: $Array<Struct<{ readonly runId: brand<String, "RunId">; readonly reason: Struct<{ readonly kind: Literals<readonly ["agentMissing", "pluginOff", "pluginUntrusted"]>; readonly name: String; }>; readonly retry: Boolean; }>>; }>
```

## LogRow

A plain log line: a `default` row, a row with no message type, or a
group heading on a stream that keeps its lifecycle inline.

```ts
interface LogRow extends TranscriptRowBase {
  readonly kind: 'log';
  readonly text: TranscriptText;
}
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

## pluralize

Return the singular or plural form of `singular` based on `count`.

```ts
function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string
```

## ProgressStatusRow

```ts
interface ProgressStatusRow extends TranscriptRowBase {
  readonly kind: 'progressStatus';
  readonly summary: TranscriptText;
  readonly detail?: TranscriptText;
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
    readonly subscribe: (
      port: string,
      set: readonly TranscriptSubscription[],
    ) => Effect.Effect<void>;
  }
>()('@texra-ai/harness/session/RemoteSessionView')
```

## ResumeBlocker

```ts
type ResumeBlocker = typeof ResumeBlockerSchema.Type;
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
  readonly phase: string | null;
  /** `drafter · gpt-5 · retried · a.md · 1m 12s · $0.31` */
  readonly facts: readonly string[];
  readonly detail?: { readonly kind: 'error' | 'note'; readonly text: string };
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
  /** The row's one line: its `detail`, else a finished agent's answer, else
   *  what its child last said, each cut to its first line. Never the
   *  delivery envelope or the instruction's later paragraphs. */
  readonly summary?: string;
}
```

## ScriptPhaseView

```ts
interface ScriptPhaseView {
  /** The guest's `phase()` title; null before its first. */
  readonly title: string | null;
  /** The phase's calls, in issue order. */
  readonly calls: readonly ScriptCallView[];
}
```

## scriptStages

The script stages of a run's transcript, oldest first: one per `script`
call that issued a call, its calls in issue order (first appearance) and
grouped by phase.

```ts
function scriptStages(
  run: RunView,
  view: Pick<SessionView, 'runs' | 'requests'>,
): ScriptStageView[]
```

## ScriptStageView

```ts
interface ScriptStageView {
  /** The stage's id; its calls' cards carry it as their group. */
  readonly id: string;
  readonly status: TaskGroup['status'];
  /** Every call, in issue order. */
  readonly calls: readonly ScriptCallView[];
  readonly phases: readonly ScriptPhaseView[];
  /** `3 agents · 1 needs you · $0.840`: what the collapsed card says. */
  readonly summary: string;
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
}
```

## summarizeEmbeddedSubagentFollowups

```ts
function summarizeEmbeddedSubagentFollowups(text: string): string
```

## summarizeSubagentFollowup

Collapse a subagent follow-up XML block into a one-line (or, for results,
status + response) human-readable summary. Returns `text` unchanged when it
is not a subagent block. Malformed non-string payloads render as a visible
placeholder instead of crashing status surfaces.

```ts
function summarizeSubagentFollowup(text: unknown): string
```

## taskGroupDisplayStatus

The status a task group RENDERS as, given the outcome its run ended with
(`undefined` while the run has not ended).

A group is closed by the `GROUP_END` row its producer writes, and a session
close ending a run past its budget closes whatever is still open in the
same lease-fenced window that writes the run's outcome. A group left
`running` is a lie only once nothing can still close it. The view's
`durableOutcome` says that, with a value rather than a bit: the outcome
the run's `run.end` row wrote, until a follow-up's `run.activate` starts
the run again.

That value, not a constant: the drain closes an open group with the outcome
the run's finalize left standing, so a run that COMPLETED with a group open
reads `completed` after the drain. Painting `cancelled` here would make
the same group read one way before the host exits and another way after.

Display only: nothing here is written back to the log.

```ts
function taskGroupDisplayStatus(
  group: Pick<TaskGroup, 'status'>,
  runDurableOutcome: RunOutcome | undefined,
): TaskGroupStatus
```

## TextBudget

Head/tail line budget a host chooses for one paint.

```ts
interface TextBudget {
  readonly headLines: number;
  readonly tailLines: number;
}
```

## TextChunk

```ts
type TextChunk = typeof TextChunkSchema.Type;
```

## TextChunkSchema

A live text delta for one row, carrying its own offsets into the row's
in-flight text: the transient analogue of `seq`.
The view ignores a chunk whose `to` is not past the text it holds,
otherwise truncates at `from` and appends, so a redelivery in any order is
a no-op, a `from: 0` chunk replaces the row, and two adjacent chunks merge
into one exactly. Never durable, never a seq.

```ts
const TextChunkSchema: Struct<{ readonly _tag: Literal<"chunk">; readonly runId: brand<String, "RunId">; readonly rowId: String; readonly from: Int; readonly to: Int; readonly text: String; }>
```

## ToolBadgesSection

A section of short badges.

```ts
interface ToolBadgesSection extends ToolSectionBase {
  readonly kind: 'badges';
  readonly badges: readonly string[];
}
```

## ToolCallFacts

What a card's `tool.start` says of its call beyond the tool and input:
a script's call's phase, and the attempt from the second on.

```ts
interface ToolCallFacts {
  readonly phase?: string;
  readonly attempt?: number;
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
interface ToolRow extends TranscriptRowBase, ToolCallFacts {
  readonly kind: 'tool';
  readonly toolUse: NormalizedToolUse;
  readonly model: ToolRowModel;
  /** The decoded durable payload the row was built from, without live
   *  output: what a conversation export formats. */
  readonly log: ToolUseLog;
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

A section stating the call's status in words.

```ts
interface ToolStatusSection extends ToolSectionBase {
  readonly kind: 'status';
  readonly status: string;
}
```

## ToolTextSection

```ts
interface ToolTextSection extends ToolSectionBase {
  readonly kind: 'text';
  readonly text: TranscriptText;
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
  readonly groupId?: string;
  /** Source vocabulary. Absent on the one row with no message type of its
   *  own, `compactionActivity` (a projection). */
  readonly messageType?: MessageType;
  /** Present when a host synthesized this row rather than the fold building
   *  it from an event: a local notice the run itself never recorded. Such a
   *  row is immutable from birth, carries the host's own id, and anchors into
   *  the merged order through the {@link seqNo}/{@link settlementSeqNo} the
   *  host captured when it appended it. */
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

## UserRow

```ts
interface UserRow extends TranscriptRowBase {
  readonly kind: 'user';
  /** The message exactly as delivered, including any delivery envelope. */
  readonly text: TranscriptText;
  /** Collapsed presentation of a subagent/workflow delivery. Derived, never a
   *  truncation of `text`: hosts choose which of the two to paint. */
  readonly summary: TranscriptText;
  readonly scriptSummary?: ReadonlyDeep<ScriptDeliverySummary>;
  /** Media that was sent to the model beside the text, by kind (no bytes). */
  readonly attachments?: readonly MediaAttachmentKind[];
  /** The files a follow-up attached, which "Fork from here" carries. */
  readonly mediaFiles?: readonly string[];
  /** The settled point "Fork from here" cuts at: the `seq` of the park the
   *  run stood at before it took this message. Absent on the first message,
   *  which no park precedes. */
  readonly forkAt?: number;
}
```

## viewDiagnosticsLayer

The logger of a view's runtime, which builds no process diagnostics layer:
each entry takes the log sink's write path, redacted unless a host marked
the sink trusted, instead of Effect's default console logger.

ERROR/FATAL are written as WARN: a view has no host log channel, and
Electron's smoke harness treats `console.error` (the console sink's ERROR
path) as a failed view. Fork-failure reports and fold defects still show
in DevTools after redaction.

```ts
const viewDiagnosticsLayer: Layer.Layer<never>
```

## WebSearchRow

```ts
interface WebSearchRow extends TranscriptRowBase {
  readonly kind: 'webSearch';
  /** `Web Search: "quantum error correction"` */
  readonly label: string;
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
