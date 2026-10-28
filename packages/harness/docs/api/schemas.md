# `@texra-ai/harness/schemas`

<!-- Generated from `packages/harness/src/schemas.ts` by `npm run docgen`; do not edit. -->

Browser-safe Effect Schemas, derived types, and pure read helpers for
`@texra-ai/harness`.

> **Guide:** Read [Views, Transcripts & Renderers](/api/views-and-transcripts)
> and [Durable Protocol & Recovery](/api/durable-protocol) for how views,
> runtime requests, and approval policies work.

- **Session & run views**: [`SessionView`](#sessionview), [`RunView`](#runview),
  [`TranscriptView`](#transcriptview), [`PendingRequest`](#pendingrequest),
  and pure queries ([`acceptsFollowUp`](#acceptsfollowup),
  [`attentionOf`](#attentionof), [`sessionActivity`](#sessionactivity),
  [`isLiveRun`](#isliverun), [`isWorkingRun`](#isworkingrun),
  [`descendantRuns`](#descendantruns), [`runActionRefusal`](#runactionrefusal)).
- **Commands & approvals**: [`RuntimeRequestSchema`](#runtimerequestschema)
  ([`RuntimeRequest`](#runtimerequest)), [`RequestDecision`](#requestdecision),
  [`OutcomeSchema`](#outcomeschema), [`RequestErrorSchema`](#requesterrorschema),
  [`ApprovalPolicySchema`](#approvalpolicyschema), [`resolveBypass`](#resolvebypass).
- **Agent definitions & run outcomes**: [`AgentConfigSchema`](#agentconfigschema),
  [`InlinePersonaSchema`](#inlinepersonaschema), [`RunEndSchema`](#runendschema),
  [`RunEndResult`](#runendresult), [`RunIdSchema`](#runidschema),
  [`RunOutcomeSchema`](#runoutcomeschema).
- **Settings & trace export**: [`settingsCatalog`](#settingscatalog),
  [`configTreeRows`](#configtreerows), [`GlobalStateKey`](#globalstatekey),
  [`WorkspaceStateKey`](#workspacestatekey), [`TraceDocumentSchema`](#tracedocumentschema).

## acceptsFollowUp

Whether a run takes a follow-up at all, the one rule every host reads (it
decides whether the composer shows). A run with no follow-up support and a
run this process may not act on take none; a run still going or waiting
takes one, as does a stopped native one with saved steps, which admission
resumes from its history. A terminal-backed run (an agent CLI such as
codex) reads its messages from the same inbox as any other run, so every
host delivers to it alike.

```ts
function acceptsFollowUp(run: ReadRunView): boolean
```

## ActiveSkillSourceScope

```ts
type ActiveSkillSourceScope =
  (typeof ActiveSkillSourceScopeSchema)['Type'];
```

## ActiveSkillSourceScopeSchema

Canonical skill-source scope vocabulary, shared with the skills loader
and the persisted disabled-source setting, so
a scope added here is representable everywhere.

```ts
const ActiveSkillSourceScopeSchema: Literals<readonly ["bundled", "user", "project", "interop", "custom"]>
```

## AGENT_MODE_PRESETS

Built-in agent teams.

Agent names listed here are matched by name (not source:name key)
so custom agents that override a built-in are included automatically.

```ts
const AGENT_MODE_PRESETS: AgentModePreset[]
```

## AGENT_SKILLS_CONFIG_KEY

```ts
const AGENT_SKILLS_CONFIG_KEY: "texra.skills.enabled"
```

## AGENT_SOURCE

```ts
const AGENT_SOURCE: { readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }
```

## AgentConfig

```ts
type AgentConfig = typeof AgentConfigSchema.Type;
```

## AgentConfigInput

```ts
type AgentConfigInput = typeof AgentConfigObjectSchema.Encoded;
```

## AgentConfigPayload

Partial agent configuration accepted before launch-time normalization.

```ts
type AgentConfigPayload = Partial<AgentConfig> &
  Pick<AgentConfig, 'agent' | 'model'>;
```

## AgentConfigSchema

Canonical configuration: at most as many outputs as text/media inputs, and
a persona exactly when the agent is inline, named as the agent is.

```ts
const AgentConfigSchema: Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>
```

## agentFileName

The agent name in an identifier as one file-name segment: a plugin
agent's `<plugin>:<name>` becomes `<plugin>__<name>`, since `:` is not a
file-name character on every platform. Run packs, run directories and
copy stems derive their names through this alone.

```ts
function agentFileName(key: string): string
```

## agentKey

Canonical key format: disambiguates agents with same name across sources.

```ts
function agentKey(source: string, name: string): string
```

## agentKeyOf

Canonical key for an agent-like record. Single source for the "entry → key"
mapping so the dozen-plus call sites don't each spell out
`agentKey(x.source, x.name)`.

```ts
function agentKeyOf(entry: { source: string; name: string }): string
```

## agentMatchesIdentifier

Match bare names by name and source-qualified keys by exact identity.

```ts
function agentMatchesIdentifier(
  entry: { source: string; name: string },
  identifier: string,
): boolean
```

## AgentModePreset

```ts
type AgentModePreset = typeof AgentModePresetSchema.Type;
```

## AgentModePresetSchema

Schema for a single agent team: its members, by name.

```ts
const AgentModePresetSchema: Struct<{ readonly id: String; readonly name: String; readonly description: String; readonly icon: Literals<readonly ["bookmark", "rocket", "diagram-project", "cube", "hashtag", "screwdriver-wrench"]>; readonly agents: $Array<String>; }>
```

## agentName

The agent name in an identifier: a source-qualified key's name
("plugin:paper:review" → "paper:review", "custom:x" → "x"), or the
identifier itself when it names no source ("paper:review", or a URL).

```ts
function agentName(key: string): string
```

## AgentOptionData

```ts
type AgentOptionData = typeof AgentOptionDataSchema.Type;
```

## AgentOptionDataSchema

```ts
const AgentOptionDataSchema: Struct<{ readonly value: String; readonly label: String; readonly isOrchestrator: optional<Boolean>; readonly source: optional<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>; }>
```

## AgentProposal

```ts
type AgentProposal = typeof AgentProposalSchema.Type;
```

## AgentProposalPermission

```ts
type AgentProposalPermission =
  (typeof AgentProposalPermissionSchema)['Type'];
```

## AgentScanIssue

```ts
type AgentScanIssue = typeof AgentScanIssueSchema.Type;
```

## AgentScanIssueSchema

A custom-agent YAML file the registry found but could not load.

```ts
const AgentScanIssueSchema: Struct<{ readonly path: String; readonly message: String; }>
```

## AgentSource

```ts
type AgentSource = typeof AgentSourceSchema.Type;
```

## AgentSourceSchema

Single source of truth for agent source identifiers.

```ts
const AgentSourceSchema: Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>
```

## AggregateClaim

The current claim on one aggregate, its owner's liveness proved in the same
call (`self` is this process; a null owner is unclaimed or absent): what a
resume gate and the run listing ask, never the fold, whose prober watches
only owners of runs already resident in the view.

```ts
interface AggregateClaim {
  readonly ownerId: OwnerId | null;
  readonly liveness: OwnerLiveness | 'self' | null;
}
```

## AggregateKind

The kind separates lifecycles even when their logical ids coincide:
`run` is keyed by the run id, `plugin` (one a plugin owns) `<plugin>:<key>`.

```ts
type AggregateKind = typeof AggregateKindSchema.Type;
```

## AggregateState

```ts
type AggregateState = typeof AggregateStateSchema.Type;
```

## AnsweredInquiryTurn

```ts
type AnsweredInquiryTurn = typeof AnsweredInquiryTurnSchema.Type;
```

## APPROVAL_POLICIES

```ts
const APPROVAL_POLICIES: readonly ["never", "ask", "yolo"]
```

## APPROVAL_POLICY_CONFIG_KEY

Canonical persisted spelling in `.texra/config.json` for every host.

```ts
const APPROVAL_POLICY_CONFIG_KEY: "texra.approvalPolicy"
```

## APPROVAL_POLICY_DEFAULT

```ts
const APPROVAL_POLICY_DEFAULT: ApprovalPolicy
```

## APPROVAL_POLICY_NO_INPUT_DEFAULT

The policy a `--no-input` run falls back to. Deliberately divergent from
{@link APPROVAL_POLICY_DEFAULT}: a run that cannot present a prompt
denies instead of hanging, and `buildCliContext` narrows the candidate list
to the explicit `--approval-policy` flag alone — a persisted or env-provided
`yolo` must not silently auto-approve a headless run that nobody is watching.
Changing that requires changing headless discipline, not just this constant.

```ts
const APPROVAL_POLICY_NO_INPUT_DEFAULT: ApprovalPolicy
```

## ApprovalBypassKind

```ts
type ApprovalBypassKind = (typeof APPROVAL_BYPASS_KINDS)[number];
```

## ApprovalGrants

```ts
type ApprovalGrants = typeof ApprovalPolicySnapshotSchema.Type;
```

## ApprovalGrantSource

The rows a bypass is read from: each run's parent edge and grants, as
the session view folds them.

```ts
interface ApprovalGrantSource<Id> {
  readonly runs: ReadonlyMap<Id, { readonly parentId: Id | null }>;
  readonly policy: ReadonlyMap<Id, ApprovalGrants>;
}
```

## ApprovalPolicy

```ts
type ApprovalPolicy = typeof ApprovalPolicySchema.Type;
```

## ApprovalPolicyDenial

What an approval-policy denial closed, as the session reports it to its
host: a command, edit or plan, a delegation proposal, the approval-gated
tools withheld from the model when the run resolved its tools, the human
retry permit after a model error, or a question the model asked the user;
and the policy that closed it, which a host names in what it says.

```ts
type ApprovalPolicyDenial = {
  readonly policy: ApprovalPolicy;
} & (
  | { readonly kind: 'executable' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'proposal' }
  | { readonly kind: 'withheldTools'; readonly tools: readonly string[] }
  | {
      readonly kind: 'retry';
      readonly deny: Exclude<RetryApprovalDecision, 'present'>['deny'];
    }
  | {
      readonly kind: 'humanInput';
      readonly deny: Exclude<HumanInputDecision, 'present'>['deny'];
    }
);
```

## approvalPolicyDenialMessage

```ts
function approvalPolicyDenialMessage(
  decision: 'deny-policy' | 'deny-unpresentable',
): string
```

## ApprovalPolicySchema

```ts
const ApprovalPolicySchema: Literals<readonly ["never", "ask", "yolo"]>
```

## AttachedMemoryMiss

An attached memory the opening could not read ({@link AttachedMemoryMissSchema}).

```ts
type AttachedMemoryMiss = typeof AttachedMemoryMissSchema.Type;
```

## Attention

What wants this window: the requests it can answer, in view order (the
badge), and those `previous` could not (none without it: history).

```ts
interface Attention<Request> {
  readonly requests: readonly Request[];
  readonly arrived: readonly Request[];
}
```

## attentionOf

The one attention rule every host reads (the extension's sidebar badge and
reveal, the desktop's dock badge, notifications, and rail): a request
wants the user exactly when this window can answer it, whatever its kind.
A request on a run another process holds, or one waiting for its run's
resume, is shown on its card but asks nothing of this window.

```ts
function attentionOf<View extends ReadSessionView>(
  view: View,
  previous?: ReadSessionView,
): Attention<View['requests'][number]>
```

## BASH_APPROVAL_CONFIG_KEY

```ts
const BASH_APPROVAL_CONFIG_KEY: "texra.toolUse.requireBashApproval"
```

## BashPermission

```ts
type BashPermission = typeof BashPermissionSchema.Type;
```

## Cancelled

The user cancelled the operation. No refusal notice is needed.

```ts
class Cancelled extends Schema.TaggedError<Cancelled>()(
  'Cancelled',
  {},
)
```

## CHATGPT_CODEX_CONTEXT_WINDOW_SETTING

Bounds and copy for the ChatGPT-subscription input budget; unset, each
model takes the window the Codex backend grants it.

The stored unit is **thousands of tokens**, and the key says so. Every
budget in play is a round multiple of 1000 (272K, 400K, 872K), so a raw
token count is three zeros nobody wants to type and an off-by-1000 typo
lands inside the valid range instead of being rejected: `872` entered for
872,000 is a legal 872-token budget that puts every request over the limit,
and the failure then names a number the user never meant to set.

```ts
const CHATGPT_CODEX_CONTEXT_WINDOW_SETTING: Readonly<{ readonly configKey: "texra.chatgptCodex.contextWindowK"; readonly tokensPerUnit: 1000; readonly min: 1; readonly max: 872; readonly unitLabel: "K tokens"; readonly description: "Input token budget for ChatGPT-subscription (Codex) routing, in thousands of tokens, mirroring Codex CLI's model_context_window. Unset, each model takes the window the Codex backend grants it (500 for GPT-6.1 Sol, 272 for the others); a value overrides it for every model, up to 872 (872,000 tokens). Automatic compaction may run earlier according to the separate compaction threshold. The model's output budget is added when displaying the total context window. The OpenAI backend enforces the real per-account limit — values above what your subscription allows fail and trigger compaction recovery."; }>
```

## CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY

Canonical config key for the per-session child-run concurrency budget.

```ts
const CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY: "texra.childRunConcurrencyBudget"
```

## CHILD_RUN_CONCURRENCY_BUDGET_SETTING

Bounds, default, and copy for `childRunConcurrencyBudget`. The value caps the
number of live native child model conversations one session runs at once.
Shared by the catalog row and the runtime reader so the two cannot disagree
about the range.

```ts
const CHILD_RUN_CONCURRENCY_BUDGET_SETTING: Readonly<{ readonly auto: 0; readonly defaultValue: 0; readonly min: 0; readonly max: 100; readonly description: "Maximum number of agents one task may run at once in the background; a script's agent() calls also run at most this many at once. 0 (the default) sizes it to this machine's CPU count. Agents beyond the budget wait for a slot to free."; }>
```

## CompactionActivityData

```ts
type CompactionActivityData =
  (typeof CompactionActivityDataSchema)['Type'];
```

## CompactionActivityOutcome

```ts
type CompactionActivityOutcome = Exclude<
  CompactionActivityData['state'],
  'started'
>;
```

## ConfigInspection

One key's stored values, by the scope that holds each.

```ts
type ConfigInspection<T = unknown> = Partial<
  Record<'globalValue' | 'workspaceValue', T>
>;
```

## ConfigTarget

Where a config write lands. `workspace` is the project's committable
`.texra/config.json`, which a cloned repository controls; `local` is this
user's private file for the workspace, under the storage root and never in
the project; `global` is the user's file for every workspace.

```ts
type ConfigTarget = 'global' | 'workspace' | 'local';
```

## configTreeRows

Config-file-backed rows from a record keyed by dotted path under `texra.`:
the key and the uniform `config` slot are derived, not restated. The
record's declaration order is the catalog order.

```ts
function configTreeRows(
  rows: Readonly<Record<string, Omit<StateSettingEntry, 'key' | 'slot'>>>,
): StateSettingEntry[]
```

## ContextManagementData

```ts
type ContextManagementData = typeof ContextManagementDataSchema.Type;
```

## ContextStateData

```ts
type ContextStateData = typeof ContextStateDataSchema.Type;
```

## countLines

Count the number of lines in a string.
Handles both Unix (\n) and Windows (\r\n) line endings.
A trailing newline does not count as an extra line.

- `@example` countLines('a\nb\nc') // 3
  countLines('a\nb\nc\n') // 3 (trailing newline ignored)
  countLines('') // 0

```ts
function countLines(text: string): number
```

## CredentialSwitchSchema

The move onto the user's own credential a failed model request offers,
decided once by the retry owner (`ModelInvoker`) from the recorded failure
and the route the failed model was bound on. Hosts render it; none of them
re-derives it from the error.

```ts
const CredentialSwitchSchema: Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>
```

## DatabaseClaimError

A claiming transaction's refusals: the claim's, a writer's, or the write.

```ts
type DatabaseClaimError =
  DatabaseNotOwner | DatabaseClaimRefused | DatabaseWriteFailed;
```

## DatabaseClaimRefused

A claim the deletion policy refuses: its owner is alive, or unproven dead.

```ts
class DatabaseClaimRefused extends Schema.TaggedError<DatabaseClaimRefused>()(
  'DatabaseClaimRefused',
  {
    ownerId: OwnerIdSchema,
    verdict: Schema.Literals(['alive', 'unprovable']),
  },
)
```

## DatabaseNotOwner

A batch member targets an aggregate this process does not hold open;
nothing was written. Ownership, not the disk, so it is never wrapped in
`DatabaseWriteFailed`.

```ts
class DatabaseNotOwner extends Schema.TaggedError<DatabaseNotOwner>()(
  'DatabaseNotOwner',
  {
    aggregateId: AggregateIdSchema,
    /** The holder and closure at refusal time, read in the refusing transaction. */
    ownerId: Schema.NullOr(OwnerIdSchema),
    closed: Schema.Boolean,
  },
)
```

## DeclinableUsageRoute

```ts
type DeclinableUsageRoute = typeof DeclinableUsageRouteSchema.Type;
```

## DEFAULT_AGENT_MODEL

Default model used when a new agent run / proposal omits one. Single source of
truth shared by the agent config schema,
the main-view persisted state, and the progress-view proposal reconstruction —
so a change here propagates to all three instead of drifting per call site.
`DEFAULT_MODELS` leads with this model, so it must not be a Gemini id.

```ts
const DEFAULT_AGENT_MODEL: "openai/gpt-6.1-sol"
```

## DEFAULT_WORKFLOW_AGENT

Agent selected when launch input names none.

```ts
const DEFAULT_WORKFLOW_AGENT: "correct"
```

## DeletionMode

```ts
type DeletionMode = typeof DeletionModeSchema.Type;
```

## descendantRuns

Every run under `rootRunId`, parents first: the topology `childIds`
(root to leaf) and `ancestors` (leaf to root) already state on every row,
so a host walks the view's own facts instead of re-deriving them.

```ts
function descendantRuns(
  view: Pick<ReadSessionView, 'runs'>,
  rootRunId: RunId | undefined,
  { includeRoot }: { includeRoot: boolean },
): readonly RunId[]
```

## DiffStats

```ts
type DiffStats = typeof DiffStatsSchema.Type;
```

## DiffStatsSchema

Schema for diff statistics where one side may be absent.

```ts
const DiffStatsSchema: Struct<{ readonly added: optional<Int>; readonly removed: optional<Int>; }>
```

## DispatchFacts

```ts
type DispatchFacts = typeof DispatchFactsSchema.Type;
```

## DisplaySessionEvent

```ts
type DisplaySessionEvent = typeof DisplaySessionEventSchema.Type;
```

## emptyRunEndOutput

The output of a run that ended before its flow produced one.

```ts
function emptyRunEndOutput(): RunEndOutput
```

## ensureError

Coerce any thrown value to an Error instance.

```ts
function ensureError(err: unknown): Error
```

## ErrorLogData

```ts
type ErrorLogData = typeof ErrorLogDataSchema.Type;
```

## escapeAttr

Escape for use inside a double-quoted HTML/XML attribute value.

```ts
function escapeAttr(s: string): string
```

## escapeText

Escape XML/HTML text content (element bodies).

```ts
function escapeText(s: string): string
```

## ExhaustionReason

```ts
type ExhaustionReason = typeof ExhaustionReasonSchema.Type;
```

## ExternalFileLocation

```ts
type ExternalFileLocation = typeof ExternalFileLocationSchema.Type;
```

## ExternalInquiryPermission

```ts
type ExternalInquiryPermission =
  (typeof ExternalInquiryPermissionSchema)['Type'];
```

## ExternalInquiryTurnRecordSchema

```ts
const ExternalInquiryTurnRecordSchema: Union<readonly [Struct<{ readonly kind: Literal<"open">; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly kind: Literal<"answered">; readonly answer: String; readonly answeredAt: String; readonly sessionLinks: optional<NullOr<$Array<Trim>>>; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>]>
```

## extractErrorMessage

Extract error message from Error objects or strings.
Returns `undefined` if the value is neither an Error nor a non-empty string.

Use this when you need optional extraction. For a guaranteed string, use
{@link toErrorMessage}.

```ts
function extractErrorMessage(err: unknown): string | undefined
```

## FileListEntry

```ts
type FileListEntry = typeof FileListEntrySchema.Type;
```

## FileLocation

```ts
type FileLocation = typeof FileLocationSchema.Type;
```

## fileLocationAddressPath

How a location is addressed in text that leaves the UI — copied run context,
follow-up prompts, subagent results. A run-storage location carries the
run that owns it, so its `/executions/...` route resolves without the
caller supplying one; every other kind reads as its display path.

```ts
function fileLocationAddressPath(location: FileLocation): string
```

## fileLocationDisplayPath

How a location reads as a path: workspace and run-storage files by their
relative path — that is how the user and the agent's file tools refer to
them — and external files by their absolute path, the only path they have.

This doubles as a location's comparable identity: two locations naming the
same file agree here, so output-to-base maps key on it.

```ts
function fileLocationDisplayPath(location: FileLocation): string
```

## FileLocationSchema

Discriminated union of all file location types

```ts
const FileLocationSchema: Union<readonly [Struct<{ readonly kind: Literal<"workspace">; readonly absolutePath: String; readonly relativePath: String; }>, Struct<{ readonly kind: Literal<"runStorage">; readonly absolutePath: String; readonly relativePath: String; readonly runId: brand<String, "RunId">; }>, Struct<{ readonly kind: Literal<"external">; readonly absolutePath: String; }>]>
```

## fileLocationShortDisplayPath

Like {@link fileLocationDisplayPath} but collapses an external location to
its basename, so a long absolute path (e.g. a run-storage file resolved as
external because it sits outside the workspace root) cannot dominate a UI
row or a prompt line. The full path stays on `absolutePath`.

```ts
function fileLocationShortDisplayPath(location: FileLocation): string
```

## FollowUpContent

```ts
type FollowUpContent = typeof FollowUpContentSchema.Type;
```

## FollowUpSender

```ts
type FollowUpSender = typeof FollowUpSenderSchema.Type;
```

## formatError

Format an error with a prefix for logging or user messages.

```ts
function formatError(prefix: string, err: unknown): string
```

## formatHunkLines

Hunks as unified-diff text lines, each preceded by its header. One header
policy: a `,1` range is omitted, the form `diff -u` and `git diff` emit.

```ts
function formatHunkLines(hunks: ToolEditContent['hunks']): string[]
```

## generateRunId

Mint a run id: 12 lowercase hex chars (48 bits of entropy). One of the
two minting sites (`deriveRunId` is the other), so the brand is
applied here and nowhere downstream.

```ts
function generateRunId(): RunId
```

## getBasename

Extract the base name (filename) from a file path.
Handles platform-specific separators (\ on Windows, / on Unix).

- `@example` getBasename('/home/user/document.pdf') // returns 'document.pdf'
  getBasename('C:\\Users\\file.txt')     // returns 'file.txt'
  getBasename('/path/to/')               // returns 'to'
  getBasename('/')                       // returns ''

```ts
function getBasename(filePath: string | undefined | null): string
```

## getFileStem

Basename without its final extension (`'notes'` for `'dir/notes.md'`).
Dotfiles keep their name (`'.gitignore'` → `'.gitignore'`).

```ts
function getFileStem(filePath: string | undefined | null): string
```

## getModelLabel

Resolve a persisted model id to its static user-facing catalogue label.

```ts
function getModelLabel(model: string): string
```

## getProposalFileGroups

```ts
function getProposalFileGroups(
  data: ProposalFileFields,
): ProposalFileGroup[]
```

## GlobalStateKey

```ts
const GlobalStateKey: Readonly<{ readonly MEMORY_ENABLED: "texra.memory.enabled"; readonly SCRIPT_ONLY: "texra.codeMode.scriptOnly"; readonly ALLOW_ORCHESTRATOR_KILL: "texra.allowOrchestratorKill"; readonly DETACH_SUBAGENTS_ON_STOP: "texra.detachSubagentsOnStop"; readonly MODEL_SELECTION: "texra.modelSelection"; readonly HELPER_MODEL: "texra.helperModel"; readonly REASONING_LEVELS: "texra.reasoningLevels"; readonly PREFER_SHORT_MODEL_NAMES: "texra.preferShortModelNames"; readonly CUSTOM_AGENT_DIR: "texra.customAgentDir"; readonly GLM_CODING_PLAN: "texra.glm.codingPlan"; readonly KIMI_CODE_PREFER: "texra.kimiCode.prefer"; readonly WEBSOCKET_OPENAI: "texra.websocket.openai"; readonly DISABLED_TOOLS: "texra.tools.disabled"; readonly MCP_REVISION_KEY: "texra.mcp.revisionKey"; readonly INSTALLED_PLUGINS: "texra.plugins.installed"; readonly ONBOARDING_DECLINED: "texra.cli.onboardingDeclined"; readonly ONBOARDING_FIRST_RUN_DONE: "texra.onboarding.firstRunDone"; readonly ONBOARDING_DEFAULT_TEAM_ID: "texra.onboarding.defaultTeamId"; }>
```

## GOAL_MAX_COST_SETTING

Bounds, default, and copy for `goal.maxCostUsd`: what a goal's rounds may
spend before it pauses instead of starting another round, and `0`
disables the cap. Read when the goal launches, into its script. Shared by
the catalog row and the goal launch so the two cannot disagree about the
range.

```ts
const GOAL_MAX_COST_SETTING: Readonly<{ readonly configKey: "texra.goal.maxCostUsd"; readonly defaultValue: 5; readonly min: 0; readonly max: 10000; readonly description: "Spend in US dollars, across its rounds, at which an autonomous goal pauses instead of starting another round. Raise it, then run the goal again to continue. Set to 0 to remove the cap (not recommended with auto-approve on your own API key)."; }>
```

## HookEvent

```ts
type HookEvent = typeof HookEventSchema.Type;
```

## HumanInputDecision

Whether a human-input request may be shown, or why it settles denied.

```ts
type HumanInputDecision =
  | 'present'
  | {
      readonly deny: 'yolo-no-human' | 'policy' | 'unpresentable';
    };
```

## InlinePersona

An inline persona as an embedder writes it (before defaults).

```ts
type InlinePersona = typeof InlinePersonaSchema.Encoded;
```

## InlinePersonaSchema

A persona an embedder passes inline (`StartInput.agent`) instead of a
file: the same definition with nothing a file alone can mean. It has no
bundled original and no plugin's block (a task is its plugin's recipe);
each is refused as an unrecognized key.

```ts
const InlinePersonaSchema: Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>
```

## InputHistoryRecord

```ts
type InputHistoryRecord = typeof InputHistoryRecordSchema.Type;
```

## InquiryThreadId

```ts
type InquiryThreadId = typeof InquiryThreadIdSchema.Type;
```

## InquiryThreadIdSchema

```ts
const InquiryThreadIdSchema: decodeTo<String, String, never, never>
```

## InstalledPluginSchema

One installed plugin, persisted as a row of the `texra.plugins.installed`
state: the one install record every host reads and writes (a CLI's
plugin command, a settings page). The plugin keeps its own manifest
(`.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`); this row is
where it lives, whether it is
enabled, the trust given to it, and what stands in for a manifest the
plugin does not have (the marketplace entry's skill directories, version
and description).

`name` takes the skill-name grammar, which also makes it a safe single path
segment for the managed `plugins/<name>` directory. `commit` is set exactly
when the harness fetched the plugin with git and owns its directory; a local
plugin is referenced in place and has none.

```ts
const InstalledPluginSchema: Struct<{ readonly name: decodeTo<String, String, never, never>; readonly source: String; readonly ref: optional<String>; readonly commit: optional<String>; readonly path: String; readonly skills: $Array<String>; readonly version: optional<String>; readonly description: optional<String>; readonly enabled: Boolean; readonly trust: optional<Struct<{ readonly version: NullOr<String>; readonly digest: String; }>>; }>
```

## INSTRUCTION_ACTION

Host-agnostic action tokens for {@link RequestShowInstructionPayload}.
The agent core emits a token; each host maps it to its own UI affordance
(the VS Code extension to a command + button title, other hosts as they see
fit). This keeps host-specific command IDs and labels out of the VS Code-free
agent core.

```ts
const INSTRUCTION_ACTION: { readonly SET_API_KEY: "set-api-key"; readonly OPEN_CONFIGURATION_GUIDE: "open-configuration-guide"; readonly OPEN_MODELS_DOC: "open-models-doc"; }
```

## InstructionAction

```ts
type InstructionAction =
  (typeof INSTRUCTION_ACTION)[keyof typeof INSTRUCTION_ACTION];
```

## Invalid

The request could not be parsed: a bridge's answer, never the runtime's.

```ts
class Invalid extends Schema.TaggedError<Invalid>()('Invalid', {
  reason: Schema.String,
})
```

## isActivePhase

```ts
function isActivePhase(phase: RunLifecycleStatus | undefined): boolean
```

## isEmptyUsage

Whether usage stats are all zeros (effectively empty).

```ts
function isEmptyUsage(usage: TokenUsageStats): boolean
```

## isInFlightPhase

```ts
function isInFlightPhase(
  phase: RunLifecycleStatus | undefined,
): boolean
```

## isLiveRun

The one reading of "live" every host shares: a run somebody holds that has
not ended. An interrupted run's durable phase may still say in flight, but
nothing is working on it, so no run list, rollup, or status bar counts it.
Not `group` alone: a spawned child that has not activated yet is `ready`
and sorts under `recent`, yet it is live.

```ts
function isLiveRun(
  run: Pick<ReadRunView, 'group' | 'status' | 'substate'>,
): boolean
```

## isLoopDriven

Whether the harness's own loop drives the run, so a resume can continue
it: a native agent's or a background script's. A process or an external CLI
drives its own run.

```ts
function isLoopDriven(identity: RunIdentity): boolean
```

## isModelOptionAvailable

Whether an option row can be run as shipped: `readModelOptions`
already resolved the access question, so a caller only has to read its
verdict. Lives with the type so delegation's model list and the CLI's
picker can never drift apart on what "available" means.

```ts
function isModelOptionAvailable(
  model: Pick<ModelOptionData, 'availability'>,
): boolean
```

## isPackagedAgentSource

True for the sources whose definitions are read in place and are not the
user's to edit: the bundled one, and an installed
plugin's. Every surface that offers to open one presents it read-only and
points edits at the custom copy; the extension additionally registers the
bundled directories `writable: false` for its file tools.

```ts
function isPackagedAgentSource(source: AgentSource): boolean
```

## isRunId

Whether a string is a run id, as {@link RunIdSchema} reads it.

```ts
const isRunId: <I>(input: I) => input is I & string & Brand<"RunId">
```

## isTaskConfig

Whether the run is a task (an agent carrying a plugin's block, run on
its recipe): its value and its children's spend are its output, its end
its record; it resumes from its checkpoint, its opening rebuilt.

```ts
const isTaskConfig: (config: { readonly agent?: string | undefined; readonly script?: { readonly kind: "background"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly timeoutMs?: number | null | undefined; } | { readonly kind: "recipe"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly block: string; readonly options: { readonly [x: string]: Json; }; readonly timeoutMs?: number | null | undefined; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly model?: string | undefined; readonly instruction?: string | undefined; readonly editedFile?: string | null | undefined; readonly inputFiles?: readonly string[] | undefined; readonly contextFiles?: readonly string[] | undefined; readonly mediaFiles?: readonly string[] | undefined; readonly outputFiles?: readonly string[] | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly asCaller?: boolean | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly displayInstruction?: string | null | undefined; readonly memories?: readonly string[] | undefined; readonly cli?: { readonly outputFile?: string | null | undefined; readonly outputDirectory?: string | null | undefined; readonly expectedOutputFiles?: readonly string[] | null | undefined; readonly teamId?: string | null | undefined; } | null | undefined; readonly delegationAgentScope?: readonly string[] | null | undefined; readonly outputSchema?: { readonly [x: string]: unknown; } | null | undefined; } | { readonly name: string; readonly instruction: string; readonly workingDirectory?: string | undefined; readonly model?: string | undefined; }) => boolean
```

## isTerminalOutcomePhase

Whether a `RunPhase` is one of the three terminal outcome phases
(COMPLETED | CANCELLED | FAILED). This is the single enumeration of that
set — hosts must consume it rather than hand-rolling their own.

```ts
function isTerminalOutcomePhase(
  phase: RunLifecycleStatus | undefined,
): phase is RunOutcome
```

## isTranscriptSettlementPhase

Whether transcript content is settled for the current turn.

```ts
function isTranscriptSettlementPhase(
  phase: RunLifecycleStatus | undefined,
): boolean
```

## isWorkingRun

A live run working right now: not a conversation waiting on its user.

```ts
function isWorkingRun(run: ReadRunView): boolean
```

## JsonValue

```ts
type JsonValue = typeof JsonValueSchema.Type;
```

## JsonValueSchema

Any JSON-serializable value. Shared home for `Schema.Json` so structured tool
output, script results, and agent run results validate the
same contract instead of re-declaring it per module.

```ts
const JsonValueSchema: Codec<Json, Json, never, never>
```

## LineCountSchema

Nonnegative line-count schema shared by tool results, approvals, and output
diff statistics.

```ts
const LineCountSchema: Int
```

## listingTypeOf

The listing types the fold keys `latest` by: every durable arm
but the transcript tier. The request pair shares one entry because it
folds to one set, the follow-up pair likewise, and the lifecycle pair (`run.start`, `run.removed`)
shares one because it folds to one existence: a tombstone's commit then
outranks a replayed `run.start` below it, which is what makes the
tombstone final under every read. `run.position` is a
listing key of its own: the phase is folded from it, so a cold listing
that dropped it would paint every parked run as ready. `stage.start` is
transcript tier alone: its display arm is a no-op and only the transcript
fold reads it over the whole aggregate, so listing it would pull the latest
one of every run into every renderer for no reader.

`run.fact` and `plugin.fact` hold several families on one type, so they
are read grouped by family as well (`listingKeyOf`, `Database`).

```ts
function listingTypeOf(
  event: Pick<SessionEvent, 'type'>,
): string | null
```

## LoadedMediaMetadata

```ts
type LoadedMediaMetadata = typeof LoadedMediaMetadataSchema.Type;
```

## LocalRuntimeState

```ts
type LocalRuntimeState = typeof LocalRuntimeStateSchema.Type;
```

## LogicalId

A logical id that is not itself an already-qualified aggregate key: the
brand key `Schema.brand` stamps on an `AggregateId` is refused here.

```ts
type LogicalId = string & {
  readonly '~effect/Brand'?: { readonly AggregateId?: never };
};
```

## LogLevel

```ts
type LogLevel = typeof LogLevelSchema.Type;
```

## McpToolOutput

The output an MCP tool call reports (`McpToolOutputSchema`).

```ts
type McpToolOutput = typeof McpToolOutputSchema.Type;
```

## MediaAttachmentKind

```ts
type MediaAttachmentKind = typeof MediaAttachmentKindSchema.Type;
```

## MemoryViewItem

```ts
type MemoryViewItem = typeof MemoryViewItemSchema.Type;
```

## MemoryViewItemSchema

```ts
const MemoryViewItemSchema: Struct<{ readonly displayPath: String; readonly storagePath: String; readonly size: Number; readonly mtime: String; readonly lineCount: optional<Number>; readonly preview: optional<String>; readonly previewError: optional<Boolean>; readonly modifiedBy: optional<String>; readonly pinned: optional<Boolean>; }>
```

## MESSAGE_TYPES

```ts
const MESSAGE_TYPES: { readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }
```

## MessageType

```ts
type MessageType = typeof MessageTypeSchema.Type;
```

## MODEL_AVAILABILITY_STATUS

What a kind means: the label a surface shows for it, whether a run can use
the model, and whether the block is a missing key. Declared once here, next
to the kind, so the answer is carried on the wire as the kind alone and
every host reads the same table instead of four pre-fanned fields.

Written with `as const satisfies` so each `available` literal survives for
`computeModelOptions`'s derivation of the unavailable kinds, while a missing
or misshapen kind is still a compile error, and frozen to the depth it is
read at: the table crosses into every host that decides whether a model can
run, and `readonly` is compile-time only.

```ts
const MODEL_AVAILABILITY_STATUS: { readonly 'provider-key': { readonly label: "API key set"; readonly available: true; readonly requiresKey: false; }; readonly 'missing-key': { readonly label: "Missing API key"; readonly available: false; readonly requiresKey: true; }; readonly 'key-unreadable': { readonly label: "API key unreadable"; readonly available: false; readonly requiresKey: false; }; readonly 'subscription-access': { readonly label: "ChatGPT subscription"; readonly available: true; readonly requiresKey: false; }; readonly 'xai-subscription-access': { readonly label: "Grok subscription"; readonly available: true; readonly requiresKey: false; }; readonly retired: { readonly label: "Retired"; readonly available: false; readonly requiresKey: false; }; readonly unserved: { readonly label: "Unavailable"; readonly available: false; readonly requiresKey: false; }; readonly 'unknown-model': { readonly label: "Unknown model"; readonly available: false; readonly requiresKey: false; }; }
```

## MODEL_COMPACTION_THRESHOLD_SETTING

Bounds, default, and copy for `model.compactionThresholdPercent`. The value
is the share of the model's context window that triggers automatic
compaction, and `0` disables it. Shared by the catalog row and the runtime
reader so the two cannot disagree about the range.

```ts
const MODEL_COMPACTION_THRESHOLD_SETTING: Readonly<{ readonly configKey: "texra.model.compactionThresholdPercent"; readonly defaultValue: 75; readonly min: 0; readonly max: 100; readonly description: "When the conversation reaches this percentage of the model's context limit, earlier messages are summarized automatically to free up space. Lower values trigger summarization sooner. Set to 0 to disable."; }>
```

## MODEL_RETRY_MAX_ATTEMPTS_SETTING

Bounds, default, and copy for `model.retry.maxAttempts`. The value is the
number of automatic retries after the initial model request. Shared by the
catalog row's schema and its copy so the two cannot disagree about the range.

```ts
const MODEL_RETRY_MAX_ATTEMPTS_SETTING: Readonly<{ readonly configKey: "texra.model.retry.maxAttempts"; readonly defaultValue: 2; readonly min: 0; readonly max: 5; readonly description: "Additional automatic retries after the initial model request (0–5). A resumed request keeps the retries it already used."; }>
```

## ModelAvailabilityFieldsSchema

Resolved per-model access. Computed once by `readModelOptions` and
shared verbatim across hosts (CLI picker, extension Models tab) so
availability and routing are never re-derived at render time: the kind is
the whole verdict, and {@link MODEL_AVAILABILITY_STATUS} words it.

```ts
const ModelAvailabilityFieldsSchema: Struct<{ readonly availability: optional<Literals<readonly ["provider-key", "missing-key", "key-unreadable", "retired", "unserved", "subscription-access", "xai-subscription-access", "unknown-model"]>>; readonly routeLabel: optional<String>; }>
```

## ModelAvailabilityKind

Why a model option can or cannot run.

```ts
type ModelAvailabilityKind = typeof ModelAvailabilityKindSchema.Type;
```

## ModelBackend

Who serves a run's conversation ({@link ModelBackendSchema}).

```ts
type ModelBackend = typeof ModelBackendSchema.Type;
```

## ModelOptionData

```ts
type ModelOptionData = typeof ModelOptionDataSchema.Type;
```

## ModelOptionDataSchema

```ts
const ModelOptionDataSchema: Struct<{ readonly value: String; readonly label: String; readonly availability: optional<Literals<readonly ["provider-key", "missing-key", "key-unreadable", "retired", "unserved", "subscription-access", "xai-subscription-access", "unknown-model"]>>; readonly routeLabel: optional<String>; readonly provider: optional<String>; readonly context: optional<String>; readonly cost: optional<String>; readonly hint: optional<String>; readonly reasoning: optional<String>; }>
```

## ModelsTabSurface

One provider's control group in the Models tab.

```ts
interface ModelsTabSurface {
  /** Canonical provider id whose expanded settings show this control. */
  readonly provider: string;
  readonly label: string;
  readonly description: string;
  readonly warning?: string;
  readonly warningUrl?: string;
  readonly warningUrlLabel?: string;
}
```

## NormalizedToolUse

The flat, renderer-friendly tool-use view `normalizeToolUse`
derives from a parsed {@link ToolUseLog}. Declared as a
plain type, not a schema: the producer builds this shape field-by-field and
nothing ever parses it, so a schema would own no boundary.

```ts
type NormalizedToolUse = {
  toolName: string;
  errorText: string;
  outputText: string;
  exitCode?: number;
  userInstructionText: string;
  input: unknown;
  isUserFeedback: boolean;
  headerSummary: string;
  status?: ToolCallStatus;
  card?: ToolCard;
};
```

## normalizeFilePath

Normalize a file path to forward slashes for consistent comparisons.

```ts
function normalizeFilePath(filePath: string): string
```

## NotOwner

Another live owner holds the run this request would act on.

```ts
class NotOwner extends Schema.TaggedError<NotOwner>()('NotOwner', {
  runId: RunIdSchema,
})
```

## NullableFileFieldsSchema

Used by AgentConfig where `editedFile` may be null.

```ts
const NullableFileFieldsSchema: Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; }>
```

## OpenInquiryTurn

```ts
type OpenInquiryTurn = typeof OpenInquiryTurnSchema.Type;
```

## OutcomeSchema

What the runtime answers with: a typed value the host renders.

```ts
const OutcomeSchema: Union<readonly [Struct<{ readonly kind: Literal<"done">; }>, Struct<{ readonly kind: Literal<"followUp">; readonly status: Literals<readonly ["sent", "queued"]>; readonly wake: optional<NullOr<Literal<"failed">>>; }>, Struct<{ readonly kind: Literal<"forked">; readonly runId: brand<String, "RunId">; }>, Struct<{ readonly kind: Literal<"preview">; readonly preview: NullOr<Struct<{ readonly originalContent: String; readonly proposedContent: String; readonly hunks: $Array<Struct<{ readonly oldStart: Int; readonly oldLines: Int; readonly newStart: Int; readonly newLines: Int; readonly lines: $Array<String>; }>>; readonly firstChangedLine: NullOr<Int>; }>>; }>, Struct<{ readonly kind: Literal<"runFiles">; readonly result: Union<readonly [Struct<{ readonly status: Literal<"done">; readonly to: optional<String>; }>, Struct<{ readonly status: Literal<"noFiles">; }>, Struct<{ readonly status: Literal<"error">; readonly error: String; }>]>; }>]>
```

## OwnerId

A process identity that may hold a claim on an aggregate.

```ts
type OwnerId = typeof OwnerIdSchema.Type;
```

## ownerIdentity

Decode an owner already validated at the event or transport boundary.

```ts
function ownerIdentity(ownerId: OwnerId): {
  hostname: string;
  pid: number;
  processStart: string | null;
}
```

## OwnerLiveness

A verdict about an owner is a proof or an admission that no proof exists.
`unprovable` means "do not touch automatically": every acquire path treats
it exactly like `alive`, and the user sees the aggregate as held. The
user's explicit deletion of the run is the one path that reaps it.

```ts
type OwnerLiveness = 'alive' | 'dead' | 'unprovable';
```

## parseAgentModePresets

```ts
function parseAgentModePresets(raw: unknown): AgentModePreset[]
```

## parseApprovalPolicy

```ts
function parseApprovalPolicy(input: string): ApprovalPolicy | undefined
```

## PendingRequest

A request a run waits on a person for, as {@link SessionView} lists it:
which run asks, the request's id, and its payload (`payload.kind` is
what is asked: a command, an edit, a plan, a retry, a question).

```ts
type PendingRequest = SessionView['requests'][number];
```

## PermissionPayload

```ts
type PermissionPayload = typeof PermissionPayloadSchema.Type;
```

## Persona

A persona with its defaults applied: what a run is offered and told.

```ts
type Persona = typeof PersonaSchema.Type;
```

## Plan

```ts
type Plan = typeof PlanSchema.Type;
```

## PlanApprovalPermission

```ts
type PlanApprovalPermission =
  (typeof PlanApprovalPermissionSchema)['Type'];
```

## planSummaryLine

One-line label for a plan document: its first line of prose. A markdown
heading (`### Objective`) names a section rather than the plan, so it
labels the plan, markers stripped, only when the plan has no prose.

```ts
function planSummaryLine(objective: string): string
```

## previewLabel

Truncate `text` to a fixed preview width. Unlike {@link truncateSummary},
this does not collapse whitespace first, so a multi-line `text` (an agent
prompt, say) keeps its embedded newlines up to the budget — every call
site here already passes text that is one line in practice.

```ts
function previewLabel(text: string): string
```

## ProgressPermissionKind

The one request kind vocabulary, read off the payload union. The
`request.opened` fact and every surface that lists pending requests key
off it, so a spelling that drifts fails to compile.

```ts
type ProgressPermissionKind = PermissionPayload['kind'];
```

## ProposalFileFields

File fields shape consumed by {@link getProposalFileGroups} — the helper
behind every proposal file list (tool-row model, ProposalRequestPanel,
CLI AgentProposal modal, approval summaries).

```ts
interface ProposalFileFields {
  readonly inputFiles?: readonly string[];
  readonly contextFiles?: readonly string[];
  readonly mediaFiles?: readonly string[];
  readonly outputFiles?: readonly string[];
  readonly memories?: readonly string[];
}
```

## ProposalFileGroup

```ts
interface ProposalFileGroup {
  label: string;
  files: readonly string[];
  /** When false, files are virtual paths that should not be opened via workspace file commands. */
  clickable: boolean;
}
```

## providerEndpointKey

The custom-endpoint setting key of a provider, if it offers one.

```ts
function providerEndpointKey(
  provider: string,
): (typeof PROVIDER_ENDPOINT_STATE_ENTRIES)[number]['endpointKey'] | undefined
```

## providerRegionSetting

The region toggle of a provider, if the provider has two platforms.

```ts
function providerRegionSetting(
  provider: string,
): (typeof PROVIDER_REGION_SETTINGS)[number] | undefined
```

## qualifyAggregateId

Qualify a logical id once. An already-qualified key is not an input.

```ts
function qualifyAggregateId(kind: 'run', logicalId: RunId): AggregateId;
```

## QueuedFollowUp

A follow-up queued for the run and not yet consumed, as its row holds it.

```ts
type QueuedFollowUp = Pick<
  Extract<SessionEvent, { type: 'followup.queued' }>,
  'followUpId' | 'content' | 'holdUntil' | 'control'
>;
```

## QuotaFallbackExhaustionReason

One switchable quota-fallback route: when its usage quota is exhausted, a
retry on the user's own credential declines this route for the run so the
same model retries on its own provider key.

Copy and detection only: whether a failure offers the switch is the retry
owner's decision (`ModelInvoker`), carried on the retry request. Keeping
this module dependency-free lets the error formatter, the invoker, and the
CLI retry copy share one catalog.

```ts
type QuotaFallbackExhaustionReason = Extract<
  ExhaustionReason,
  | 'chatgpt-subscription'
  | 'xai-subscription'
  | 'glm-coding-plan'
  | 'kimi-code-subscription'
>;
```

## QuotaFallbackRoute

```ts
interface QuotaFallbackRoute {
  readonly usageRoute: DeclinableUsageRoute;
  readonly exhaustionReason: QuotaFallbackExhaustionReason;
  readonly retryFallbackName: string;
  readonly retrySourceName: string;
}
```

## ReadonlyDeep

A runtime value as a host or an embedder holds it: read-only all the
way down, every map, array, and record included. The value itself is not copied
(the fold publishes immutable levels); the type is what keeps a write
from reaching it. A primitive stays itself, so a branded id (a `RunId`)
is still that id.

```ts
type ReadonlyDeep<T> = T extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | ((...args: never[]) => unknown)
  ? T
  : T extends ReadonlyMap<infer K, infer V>
    ? ReadonlyMap<K, ReadonlyDeep<V>>
    : T extends ReadonlySet<infer V>
      ? ReadonlySet<ReadonlyDeep<V>>
      : T extends readonly (infer E)[]
        ? readonly ReadonlyDeep<E>[]
        : T extends object
          ? { readonly [P in keyof T]: ReadonlyDeep<T[P]> }
          : T;
```

## readTraceFacts

A parsed trace with each plugin fact checked as the store checks it,
against the app's plugin arms (`appArms`): a fact
outside its arm's versions (`pluginFactFloor`), or whose value the arm's
schema rejects, throws, naming it, as does a retired built-in fact no
current plugin owns;
one whose plugin this build lacks is left out. A trace is display data and runs no upcaster, so a version an
upcaster would bring forward is rejected by the schema, never misread.

```ts
function readTraceFacts(
  document: TraceDocument,
  appArms: readonly TraceFactArm[],
): TraceDocument
```

## recipeBlockOf

The block key of the plugin whose recipe the run opened on
(`script.block`), or null for a run that is no task.

```ts
const recipeBlockOf: (config: { readonly agent?: string | undefined; readonly script?: { readonly kind: "background"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly timeoutMs?: number | null | undefined; } | { readonly kind: "recipe"; readonly title: string; readonly tools: readonly string[]; readonly code: string; readonly block: string; readonly options: { readonly [x: string]: Json; }; readonly timeoutMs?: number | null | undefined; } | null | undefined; readonly workingDirectory?: string | null | undefined; readonly model?: string | undefined; readonly instruction?: string | undefined; readonly editedFile?: string | null | undefined; readonly inputFiles?: readonly string[] | undefined; readonly contextFiles?: readonly string[] | undefined; readonly mediaFiles?: readonly string[] | undefined; readonly outputFiles?: readonly string[] | undefined; readonly agentSource?: "plugin" | "custom" | "builtIn" | "inline" | null | undefined; readonly persona?: { readonly name: string; readonly description?: string | undefined; readonly prompt?: string | undefined; readonly tools?: readonly string[] | undefined; readonly temperature?: number | undefined; } | null | undefined; readonly asCaller?: boolean | null | undefined; readonly rootUserInstruction?: string | null | undefined; readonly displayInstruction?: string | null | undefined; readonly memories?: readonly string[] | undefined; readonly cli?: { readonly outputFile?: string | null | undefined; readonly outputDirectory?: string | null | undefined; readonly expectedOutputFiles?: readonly string[] | null | undefined; readonly teamId?: string | null | undefined; } | null | undefined; readonly delegationAgentScope?: readonly string[] | null | undefined; readonly outputSchema?: { readonly [x: string]: unknown; } | null | undefined; } | { readonly name: string; readonly instruction: string; readonly workingDirectory?: string | undefined; readonly model?: string | undefined; }) => string | null
```

## referencedAggregates

Aggregate identities introduced by a fact and its declared lifecycle edges.

```ts
function referencedAggregates(event: SessionEvent): AggregateId[]
```

## Rejected

The runtime refused the request for a worded reason.

```ts
class Rejected extends Schema.TaggedError<Rejected>()('Rejected', {
  reason: Schema.String,
  docsPage: Schema.optional(Schema.String),
})
```

## requestAnswerability

```ts
function requestAnswerability(
  run: ReadRunView,
  payload: Pick<PermissionPayload, 'kind'>,
): RequestAnswerability
```

## RequestAnswerability

Whether this window can answer a pending request: the one rule the host's
attention badge and the request card both read, matching what
`SessionRequests.decide` accepts. A run this process may not act on
(`readOnly`) takes no answer here. A request that blocks its caller is
answered by the fiber waiting on it, so only while its run waits here; an
interrupted run has to be resumed first. An inquiry, at any other time.

```ts
type RequestAnswerability = 'answerable' | 'readOnly' | 'resume';
```

## RequestDecision

```ts
type RequestDecision = typeof RequestDecisionSchema.Type;
```

## RequestEnsureProgressViewPayload

Request the frontend to ensure the progress view is visible.
If the view cannot be opened and a fallback notification is provided,
show a toast notification as a last resort.

```ts
interface RequestEnsureProgressViewPayload {
  fallbackNotification?: {
    agentName: string;
    modelName: string;
    inputName: string;
    outputInfo: string;
  };
}
```

## RequestError

How a runtime request fails: one of the tagged errors above.

```ts
type RequestError = typeof RequestErrorSchema.Type;
```

## RequestErrorSchema

The wire form of a request's failure: the classes themselves.

```ts
const RequestErrorSchema: Union<readonly [typeof NotOwner, typeof Unavailable, typeof Cancelled, typeof Rejected, typeof Invalid, typeof Internal]>
```

## RequestOpenFilePayload

Request the frontend to open a file, and build and show it if it can.

```ts
interface RequestOpenFilePayload {
  location: FileLocation;
  preserveFocus: boolean;
}
```

## requestParksItsCaller

Whether a request parks the tool that opened it. Every kind does but the
external inquiry: its tool returns `dispatched` at once and the run carries
on, so the answer arrives as a follow-up instead of releasing a parked
fiber. Both folds read the distinction off this one predicate - the run
fold to decide which open requests a snapshot may leave unbound, the
session fold to decide which ones make a run wait on its user.

```ts
function requestParksItsCaller(
  payload: Pick<PermissionPayload, 'kind'>,
): boolean
```

## RequestShowErrorPayload

Request the frontend to show an error message via a host notification.

```ts
interface RequestShowErrorPayload {
  message: string;
  /** Docs page of the refusing request (e.g. 'file-management'); the host
   *  offers it as a guide link or action beside the message. */
  docsPage?: string;
}
```

## RequestShowInstructionPayload

Request the frontend to show a suppressible instruction message.

```ts
interface RequestShowInstructionPayload {
  key: string;
  message: string;
  /**
   * Host-agnostic action tokens rendered as buttons. The host maps each
   * token to its own UI affordance (see {@link INSTRUCTION_ACTION}).
   */
  actions?: readonly InstructionAction[];
  showSuppress?: boolean;
}
```

## resolveBypass

Who bypasses one kind's prompts for a run: the nearest run in its ancestry
(itself first) that decides the kind, by its autonomous goal's grant
(`goal`) or a human's value (`human` when on); `null` when nothing grants
it. Past a `parent` value only human values decide. The one reading of the
grants, for enforcement and every surface.

```ts
function resolveBypass<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
  kind: ApprovalBypassKind,
): 'goal' | 'human' | null
```

## ResultMeta

```ts
type ResultMeta = typeof ResultMetaSchema.Type;
```

## RESUME_ON_OPEN_SETTING

What an interactive host window does at open with the tasks a closed or
crashed process left interrupted:
`ask` lists them, `auto` continues them. Headless runs and the SDK do
neither, whatever this says.

```ts
const RESUME_ON_OPEN_SETTING: Readonly<{ readonly configKey: "texra.resumeOnOpen"; readonly values: readonly ["ask", "auto"]; readonly defaultValue: "ask"; readonly description: "On opening, when tasks stopped before they finished: list them so you can choose, or continue them all."; }>
```

## ResumeRefusal

One reason a resume is refused ({@link ResumeRefusalSchema}).

```ts
type ResumeRefusal = typeof ResumeRefusalSchema.Type;
```

## RetryApprovalDecision

```ts
type RetryApprovalDecision =
  | 'present'
  | {
      readonly deny: 'yolo-retry' | 'credential' | 'policy' | 'unpresentable';
    };
```

## RetryPermission

```ts
type RetryPermission = typeof RetryPermissionSchema.Type;
```

## rollupOf

What `children` and their descendants count toward a parent's `rollup`:
the view's count over the run tree (each child's own `rollup` below it),
and the dispatch card's over the tree it lists (`below` recurses through
the children it lists instead). A child waiting between turns (held) or
paused, nothing asked of the user, has delivered its turn: it counts as
finished, not running.

```ts
function rollupOf(
  children: readonly ReadRunView[],
  below = (child: ReadRunView) => child.rollup,
): ReadRunView['rollup']
```

## RUN_LIFECYCLE_READY

Wire-level lifecycle status of a run with no lifecycle recorded yet. `as const`
is load-bearing: a bare `const` gives a *widening* literal type, which
widens back to `string` inside an object literal.

```ts
const RUN_LIFECYCLE_READY: "ready"
```

## RUN_OUTCOME

Canonical terminal outcome of an agent run — the single fact "how did this
run end", decided exactly once at the run-lifecycle boundary. Current
production writers use these values for terminal run, group-end, and run
state.

`cancelled` is a sibling of `failed`, never folded into it — a user stop is
not an error. This is the triad `ResultEvent.outcome` carries.

```ts
const RUN_OUTCOME: { readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }
```

## RUN_PHASE

The live phase vocabulary. Membership questions are answered by the
predicates `isActivePhase`, `isInFlightPhase` and
`isTerminalOutcomePhase`.

```ts
const RUN_PHASE: { readonly RUNNING: "running"; readonly WAITING: "waiting"; readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }
```

## RUN_STATUS_KEYS

Every key of the status table, the enum `RunView.statusKey` holds.

```ts
const RUN_STATUS_KEYS: ["completed" | "cancelled" | "failed" | "paused" | "waiting" | "running" | "ready" | "starting" | "resuming" | "resultWaiting" | "interrupted" | "waitingOnUser", ...("completed" | "cancelled" | "failed" | "paused" | "waiting" | "running" | "ready" | "starting" | "resuming" | "resultWaiting" | "interrupted" | "waitingOnUser")[]]
```

## RUN_SUBSTATE

```ts
const RUN_SUBSTATE: { readonly STARTING: "starting"; readonly RESUMING: "resuming"; readonly PAUSED: "paused"; readonly RESULT_WAITING: "resultWaiting"; }
```

## RunAction

```ts
type RunAction = typeof RunActionSchema.Type;
```

## runActionRefusal

Why a run no longer takes `action`: the refusal every handler words.

```ts
function runActionRefusal(
  run: Pick<
    ReadonlyRunView,
    'readOnly' | 'group' | 'status' | 'substate' | 'label'
  >,
  action: RunAction,
): string
```

## runBypasses

Every kind's bypass for one run, as surfaces show it.

```ts
function runBypasses<Id>(
  source: ApprovalGrantSource<Id>,
  runId: Id,
): Readonly<Record<ApprovalBypassKind, boolean>>
```

## RunEndOutput

```ts
type RunEndOutput = typeof RunEndOutputSchema.Type;
```

## RunEndResult

```ts
type RunEndResult = typeof RunEndResultSchema.Type;
```

## RunEndSchema

A run's terminal result as every reader sees it. `error` is present only
on a failed outcome; `usage` once a round recorded usage, including on
failures. Cost is `usage.totalCost` and nothing else. Derived on read
(`readRunEnd`): the usage is the run history's fold of its priced response
rows, the output as {@link RunEndOutputSchema} says.

```ts
const RunEndSchema: Struct<{ readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly error: optional<Union<readonly [Struct<{ readonly message: optional<String>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["abort", "disk-full", "result-lost"]>; }>, Struct<{ readonly message: optional<String>; readonly statusCode: optional<optional<Int>>; readonly statusText: optional<optional<String>>; readonly provider: optional<optional<String>>; readonly classification: optional<optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>>; readonly requestId: optional<optional<String>>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["context-window", "missing-api-key", "unexpected"]>; }>]>>; readonly usage: optional<Struct<{ readonly firstInputTokens: withDecodingDefault<Int, never>; readonly totalInputTokens: withDecodingDefault<Int, never>; readonly totalOutputTokens: withDecodingDefault<Int, never>; readonly totalCost: withDecodingDefault<Number, never>; readonly totalCacheReadInputTokens: withDecodingDefault<Int, never>; readonly totalCacheMissInputTokens: withDecodingDefault<Int, never>; readonly totalCacheCreationInputTokens: withDecodingDefault<Int, never>; readonly totalReasoningTokens: withDecodingDefault<Int, never>; readonly totalToolUsePromptTokens: withDecodingDefault<Int, never>; }>>; readonly output: Struct<{ readonly response: withDecodingDefault<String, never>; readonly files: withDecodingDefault<$Array<String>, never>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; }>
```

## RunId

```ts
type RunId = typeof RunIdSchema.Type;
```

## RunIdentity

```ts
type RunIdentity = typeof RunIdentitySchema.Type;
```

## runIdentityDisplayName

UI label for a run identity — strips a known source prefix from agent ids.

```ts
function runIdentityDisplayName(id: RunIdentity): string
```

## runIdentityName

The identity's display name — what a listing row or tab label leads with.

```ts
function runIdentityName(id: RunIdentity): string
```

## RunIdSchema

The one id a run has: minted once at launch, assigned
at `run.start`, and the key of every fact about that run. Hex: 12 chars
when generated, 24 when derived from a checkpoint identity. Branded so a
string that was never minted as a run id cannot be passed for one.

```ts
const RunIdSchema: brand<String, "RunId">
```

## RunLifecycleStatus

```ts
type RunLifecycleStatus = RunPhase | typeof RUN_LIFECYCLE_READY;
```

## RunOutcome

```ts
type RunOutcome = typeof RunOutcomeSchema.Type;
```

## RunOutcomeSchema

```ts
const RunOutcomeSchema: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>
```

## RunPhase

```ts
type RunPhase = typeof RunPhaseSchema.Type;
```

## RunRecord

The canonical run configuration (`RunRecordFieldsSchema`, the `run.config`
row's field): a real `AgentConfig` for agent runs, the honest minimal
record for everything else. The union keeps the strict non-agent arm
first: the agent arm's decoding defaults would fabricate an agent config
out of any object.

```ts
type RunRecord = typeof RunRecordFieldsSchema.Type;
```

## RunRecordFieldsSchema

Inputs have already passed launch validation; persisted records are canonical.

```ts
const RunRecordFieldsSchema: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>
```

## RunStatusKey

How a run's status reads: one key of the status table.

```ts
type RunStatusKey = keyof typeof RUN_STATUS_TONE_OF;
```

## RunStorageFileLocation

```ts
type RunStorageFileLocation =
  (typeof RunStorageFileLocationSchema)['Type'];
```

## runStorageFilePath

Reference to a run-storage file the way an agent prompt addresses it:
`/executions/<runId>/files/<relativePath>`. The one definition of that
convention.

```ts
function runStorageFilePath(
  runId: string,
  relativePath: string,
): string
```

## RuntimeRequest

One request a surface issues to its session's runtime.

```ts
type RuntimeRequest = typeof RuntimeRequestSchema.Type;
```

## RuntimeRequestSchema

Every request a surface issues to its session's runtime, one arm per
`group.action` tag.

```ts
const RuntimeRequestSchema: Union<readonly [Struct<{ readonly detachActiveChildren: optional<NullOr<Boolean>>; readonly reason: Literals<readonly ["user", "shutdown"]>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.stop">; }>, Struct<{ readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.delete">; }>, Struct<{ readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.compact">; }>, Struct<{ readonly title: Trim; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.rename">; }>, Struct<{ readonly at: optional<NullOr<Int>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.fork">; }>, Struct<{ readonly model: String; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.model">; }>, Struct<{ readonly files: Union<readonly [Struct<{ readonly op: Literal<"copy">; readonly to: String; }>, Struct<{ readonly op: Literal<"remove">; }>]>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"run.files">; }>, Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly holdUntil: optional<NullOr<Literal<"turn">>>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"followUp.send">; }>, Struct<{ readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; readonly runId: brand<String, "RunId">; readonly kind: Literal<"request.decide">; }>, Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly kind: Literal<"request.preview">; }>, Struct<{ readonly kind: Literal<"policy.set">; readonly change: Union<readonly [Struct<{ readonly bypass: Literals<readonly ["bash", "toolEdit", "superYolo"]>; readonly enabled: Boolean; readonly exceptRequestId: optional<String>; readonly runId: brand<String, "RunId">; readonly field: Literal<"bypass">; }>, Struct<{ readonly limit: Literals<readonly ["never", "ask"]>; readonly runId: brand<String, "RunId">; readonly field: Literal<"limit">; }>]>; }>]>
```

## RunView

One stream of the {@link SessionView}.

```ts
type RunView = ReadonlyDeep<
  (typeof SessionViewSchema.Type)['runs'] extends ReadonlyMap<
    unknown,
    infer Run
  >
    ? Run
    : never
>;
```

## ScriptDeliverySummary

```ts
type ScriptDeliverySummary = typeof ScriptDeliverySummarySchema.Type;
```

## serializeFilteredConfig

Serialize a run record to pretty JSON, dropping agent-config fields
irrelevant to the resolved display category so the serialized config the
orchestrator reads stays relevant. Records without an agent execution mode
are honest by construction and serialize unchanged.

```ts
function serializeFilteredConfig(
  record: RunRecord,
  category: string | undefined,
): string
```

## sessionActivity

The paper-level activity every title and status pill shows, read from the
view and nothing else: a request this window can answer outranks a run
working right now; a conversation waiting on its user is idle.

```ts
function sessionActivity(view: ReadSessionView): SessionTitleState
```

## SessionEvent

```ts
type SessionEvent = typeof SessionEventSchema.Type;
```

## SessionEventDraft

What a publisher hands `SessionEvents.publish`: the body plus the aggregate
it lives on. The publisher stamps the rest of the envelope
(`seq`, `commit`, `origin`, `at`) under its permit; no caller passes them.
Parsing a draft removes caller-supplied envelope fields before storage.

```ts
type SessionEventDraft = typeof SessionEventDraftSchema.Type;
```

## SessionStoreMovedAside

What opening a store moved aside, whole (never read again): a store written
before 1.0, or a file SQLite reports damaged or not a database. Null when
nothing was moved. The one fact a host presents about it.

```ts
interface SessionStoreMovedAside {
  readonly path: string;
  readonly aside: string;
  readonly reason: 'pre-1.0' | 'corrupt';
}
```

## SessionTitleState

How busy a session reads in a title: idle, running, or awaiting approval.

```ts
type SessionTitleState = 'idle' | 'running' | 'approval';
```

## SessionView

One published level of the session's fold: an immutable value.

```ts
type SessionView = ReadonlyDeep<typeof SessionViewSchema.Type>;
```

## settingsCatalog

The catalog of the harness's rows, then `appRows` (an app's own, its
plugins' included). A key declared twice is a defect and throws.

```ts
function settingsCatalog(
  appRows: readonly StateSettingEntry[],
): SettingsCatalog
```

## SettingsCatalog

One settings catalog and the lookups every settings surface reads from it.

```ts
interface SettingsCatalog {
  /** Every row, in catalog order. */
  readonly rows: readonly StateSettingEntry[];
  /** Look up any row, config-file-backed or state-backed, by its key. */
  readonly byKey: (key: string) => StateSettingEntry | undefined;
  /** Look up a row the settings view's unified write path owns. */
  readonly settingsViewByKey: (
    key: string,
  ) => SettingsViewStateSettingEntry | undefined;
  /**
   * The rows one settings-view snapshot carries, in catalog order: the
   * outbound payload's schema, the backend's read loop and the webview's
   * apply step each iterate this list, so adding
   * `surfaces.settingsView: '<snapshot>'` to a row puts it on the wire.
   */
  readonly snapshotEntries: (
    snapshot: SettingsViewSnapshot,
  ) => readonly SettingsViewStateSettingEntry[];
  /** The `/config` panel's rows: `surfaces.cliConfig` is the one predicate. */
  readonly cliRows: readonly SurfacedSettingEntry[];
  /** Look up a row the CLI `/config` panel lists, and so may write. */
  readonly cliByKey: (key: string) => SurfacedSettingEntry | undefined;
  /** Keys of the config-file-backed rows: the CLI's unknown-key whitelist's catalog half. */
  readonly configSlotKeys: readonly string[];
  /** The Models tab's controls for one provider, in catalog order. */
  readonly modelsTab: (provider: string) => readonly {
    readonly entry: StateSettingEntry;
    readonly surface: ModelsTabSurface;
  }[];
  /**
   * A fresh copy of a config-file-backed row's default, or `undefined` for a
   * key no such row owns: the step every `ConfigProvider` applies between the
   * stored value and the caller's fallback. Parsed defaults are memoized
   * because this is on the read path of every absent setting; object values
   * are cloned so a caller cannot mutate the catalog's own default.
   */
  readonly configDefault: (key: string) => unknown;
}
```

## SettingStore

Storage slot a setting is read from / written to. `repoState` is shared by
every checkout of one git repository (keyed by its root in the global
database), so a repository has one value on every host and in every
worktree.

```ts
type SettingStore =
  'config' | 'workspaceState' | 'repoState' | 'globalState';
```

## SettingSurfaces

Catalog-driven UIs that render the row. Absent means no UI renders it.

```ts
interface SettingSurfaces {
  /**
   * Rendered by the extension/desktop settings view; the value names the
   * snapshot rebroadcast after a write. Presence also makes the row writable
   * through the generic `UPDATE_STATE_SETTING` boundary.
   */
  readonly settingsView?: SettingsViewSnapshot;
  /** Listed as an editable row in the CLI `/config` panel. */
  readonly cliConfig?: true;
  /** Shown as a per-provider toggle in the Models tab. */
  readonly models?: readonly ModelsTabSurface[];
}
```

## SettingsViewSnapshot

```ts
type SettingsViewSnapshot =
  | 'agents'
  | 'approval'
  | 'git-author'
  | 'latex'
  | 'memory'
  | 'models'
  | 'profile'
  | 'skills'
  | 'telemetry';
```

## SettingsViewStateSettingEntry

A row the extension/desktop settings view owns the write path for.

```ts
type SettingsViewStateSettingEntry = SurfacedSettingEntry & {
  readonly surfaces: SettingSurfaces & {
    readonly settingsView: SettingsViewSnapshot;
  };
};
```

## SettingWriteEffects

Consequences of writing a row, declared once for every write path.

```ts
interface SettingWriteEffects {
  /**
   * Writing the row changes which models are available or how they route, so
   * hosts must recompute their cached model options.
   */
  readonly invalidatesModelOptions?: true;
}
```

## ShowAgentConfigBannerPayload

Request the frontend to show the agent-config banner in the main webview,
for the agent that could not launch.

```ts
interface ShowAgentConfigBannerPayload {
  agentName: string;
}
```

## SkillDisplayIssue

```ts
type SkillDisplayIssue = typeof SkillDisplayIssueSchema.Type;
```

## SkillDisplayIssueSchema

Discovery problem safe to carry to settings UIs.

```ts
const SkillDisplayIssueSchema: Struct<{ readonly message: String; readonly path: optional<String>; }>
```

## SkillDisplayItem

```ts
type SkillDisplayItem = typeof SkillDisplayItemSchema.Type;
```

## SkillDisplayItemSchema

One discovered skill projected for host settings displays.

```ts
const SkillDisplayItemSchema: Struct<{ readonly name: String; readonly description: String; readonly scope: Literals<readonly ["bundled", "user", "project", "interop", "custom"]>; readonly label: String; readonly path: String; readonly sourcePath: String; readonly enabled: Boolean; }>
```

## SkillNameSchema

Canonical grammar for discovered and persisted skill names.

```ts
const SkillNameSchema: decodeTo<String, String, never, never>
```

## splitContentLines

Normalize line endings and split into content lines.
A trailing newline does not produce a phantom empty element.

- `@example` splitContentLines('a\nb\nc')   // ['a', 'b', 'c']
  splitContentLines('a\nb\nc\n') // ['a', 'b', 'c']
  splitContentLines('')          // []

```ts
function splitContentLines(text: string): string[]
```

## STARTER_AGENT_MODE_PRESET

Generic default team applied when the user skips the setup agent's
discipline question. Deliberately NOT part
of {@link AGENT_MODE_PRESETS}: it is not a discipline and must not appear
as a team card in the settings UI — only `apply_team` and default-team
seeding resolve it.

```ts
const STARTER_AGENT_MODE_PRESET: AgentModePreset
```

## StateSettingEntry

```ts
interface StateSettingEntry {
  /**
   * Canonical `texra.*` key — identical to the config / WorkspaceState /
   * GlobalState slot the extension already uses.
   */
  readonly key: string;
  /**
   * The row's schema, carrying both validation and the decoding default
   * applied when the key is absent: decoding `undefined` yields that default.
   */
  readonly schema: Schema.Codec<unknown, unknown>;
  /** Short label for compact settings UIs; falls back to the stripped key. */
  readonly title?: string;
  /** Human-readable description, shared across every host that renders it. */
  readonly description?: string;
  /** Grouping label for settings UIs. Required once a UI renders the row. */
  readonly category?: string;
  /** Where the value is stored, the same on every host. */
  readonly slot: SettingStore;
  /** Config-backed target, workspace when omitted; `global`/`local` skip the project file. */
  readonly configTarget?: 'global' | 'workspace' | 'local';
  /**
   * A `global` row a project file may still switch off: its project value
   * counts unless it is `true`, so a repository can opt out (telemetry) but
   * never opt in. A malformed project value counts too, and fails closed.
   */
  readonly projectMayOptOut?: true;
  /** Which catalog-driven UIs render the row. */
  readonly surfaces?: SettingSurfaces;
  /** Write-time consequences applied by every write path. */
  readonly onWrite?: SettingWriteEffects;
  /**
   * Per-value descriptions for an enum setting, aligned 1:1 with the schema's
   * enum options (a host's settings UI derives them). The option *values* are
   * derived from the schema, not restated here.
   */
  readonly enumDescriptions?: readonly string[];
  /** Display labels for enum options, aligned 1:1 with the schema options. */
  readonly enumLabels?: readonly string[];
  /**
   * Delegate editing to an existing list form (e.g. `ModelListForm`) instead of
   * the scalar read/write accessor.
   */
  readonly openForm?: string;
}
```

## stricterPolicy

The stricter of two policies (`never` < `ask` < `yolo`).

```ts
function stricterPolicy(
  a: ApprovalPolicy,
  b: ApprovalPolicy,
): ApprovalPolicy
```

## stripControlCharacters

Replace every C0/C1 control character (tab and newline included) with
`replacement`, so untrusted text cannot inject terminal escapes.

```ts
function stripControlCharacters(text: string, replacement = ''): string
```

## SUBSCRIPTION_AUTH_NAMES

Each subscription's switch, and the sign-in a lapsed session asks for: the
names a model-access failure, a quota fallback and a picker quote, and the
ones every host's account copy repeats.

```ts
const SUBSCRIPTION_AUTH_NAMES: { readonly chatgpt: { readonly subscriptionLabel: "ChatGPT subscription"; readonly signInLabel: "Sign in with ChatGPT"; }; readonly grok: { readonly subscriptionLabel: "Grok subscription"; readonly signInLabel: "Sign in with Grok"; }; }
```

## SUBSCRIPTION_AUTH_PROVIDERS

The subscription providers, as a settings view signs in and out of them:
the one spelling of a provider id everywhere.

```ts
const SUBSCRIPTION_AUTH_PROVIDERS: readonly ["chatgpt", "grok"]
```

## SubscriptionAuthProvider

```ts
type SubscriptionAuthProvider =
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number];
```

## sumUsageStats

Accumulates usage stats from an iterable into a single total. The route
and plan are kept when every nonempty item names the same one.

```ts
function sumUsageStats(
  items: Iterable<TokenUsageStats>,
): TokenUsageStats
```

## SurfacedSettingEntry

A row at least one catalog-driven UI renders, so display copy is present.

```ts
type SurfacedSettingEntry = StateSettingEntry & {
  readonly description: string;
  readonly category: string;
  readonly surfaces: SettingSurfaces;
};
```

## TaskGroup

```ts
type TaskGroup = typeof TaskGroupSchema.Type;
```

## TaskGroupStatus

```ts
type TaskGroupStatus = typeof TaskGroupStatusSchema.Type;
```

## TeamOptionData

```ts
type TeamOptionData = typeof TeamOptionDataSchema.Type;
```

## TeamOptionDataSchema

Team picker option row for the main-view "Run with: Team" target. `value`
carries the preset id (one of the built-ins in `AGENT_MODE_PRESETS` or a
user-saved custom team); hosts resolve the agent list, so the renderer only
ever sends team identity back. Availability is resolved against the full
live catalog, not just the workspace's enabled agents.

```ts
const TeamOptionDataSchema: Struct<{ readonly value: String; readonly label: String; readonly source: Literals<readonly ["built-in", "custom"]>; readonly icon: String; readonly description: withDecodingDefault<String, never>; readonly unavailableMembers: withDecodingDefault<$Array<String>, never>; readonly disabled: optional<Boolean>; readonly disabledReason: optional<NullOr<String>>; }>
```

## toErrorMessage

Normalize any thrown value into a user-friendly error message string: the
error's own message, then the messages down its `cause` chain (and an
`AggregateError`'s members), each once, joined with `: `. A wrapper
whose sentence already embeds its cause's message adds nothing, and a
wrapper with a fixed sentence no longer hides the failure under it.

```ts
function toErrorMessage(err: unknown): string
```

## toJsonValue

A value as a stored row keeps it: what `JSON.stringify` writes, read
back. The boundary where an arbitrary value enters a persisted field.

```ts
const toJsonValue: (value: unknown) => Json
```

## TokenUsageStats

```ts
type TokenUsageStats = typeof TokenUsageStatsSchema.Type;
```

## TOOL_CALL_STATUS

The one status of a tool call: carried by `tool.end`, folded onto the
card, and read by every renderer. A failed call is `failed`; there is no
side-channel error flag beside it.

```ts
const TOOL_CALL_STATUS: { readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }
```

## TOOL_EDIT_APPROVAL_CONFIG_KEY

Config keys, bounded schemas, and defaults shared by more than one reader.

The settings themselves — schema, default, copy, honoring hosts, rendering
surfaces — live as rows on the one catalog in `stateSettings.ts`. This module
holds only what a runtime reader needs to name a key or reuse a bounded
schema without importing the catalog.

```ts
const TOOL_EDIT_APPROVAL_CONFIG_KEY: "texra.toolUse.requireEditApproval"
```

## ToolCallStatus

```ts
type ToolCallStatus = typeof ToolCallStatusSchema.Type;
```

## ToolCard

A card a tool states itself (`ToolCardSchema`).

```ts
type ToolCard = typeof ToolCardSchema.Type;
```

## ToolDefinition

Tool definition type - derived from schema

```ts
type ToolDefinition = typeof ToolDefinitionSchema.Type;
```

## ToolEditContent

A pending tool edit's staged content (`request.preview`).

```ts
type ToolEditContent = typeof ToolEditContentSchema.Type;
```

## ToolEditContentSchema

What a pending tool edit would change: the original and proposed
content a host shows beside the request's path and line counts, and
the diff between them, computed once where the request is built: its
hunks and the 0-based line of the proposed text a diff view reveals
first (null when nothing changed).

```ts
const ToolEditContentSchema: Struct<{ readonly originalContent: String; readonly proposedContent: String; readonly hunks: $Array<Struct<{ readonly oldStart: Int; readonly oldLines: Int; readonly newStart: Int; readonly newLines: Int; readonly lines: $Array<String>; }>>; readonly firstChangedLine: NullOr<Int>; }>
```

## ToolEditPermission

```ts
type ToolEditPermission = typeof ToolEditPermissionSchema.Type;
```

## ToolEditPermissionSchema

```ts
const ToolEditPermissionSchema: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; }>
```

## ToolFact

A fact a tool's call states about its run (`ToolFactSchema`).

```ts
type ToolFact = typeof ToolFactSchema.Type;
```

## ToolUseLog

```ts
type ToolUseLog = typeof ToolUseLogSchema.Type;
```

## TraceDocument

```ts
type TraceDocument = Readonly<typeof TraceDocumentSchema.Type>;
```

## TraceDocumentSchema

One finished run as a static viewer replays it: the run aggregate's own
display events in commit order, the same rows the live plane delivers to a
subscriber. Nothing is projected on the way out and nothing is
reconstructed on the way in.

The export authors four facts rather than copying them (`assembleTrace`):
no owner, no parent, no checkpoint and no follow-up support, because an
exported file has no producer, no siblings and no writable host.

```ts
const TraceDocumentSchema: Struct<{ readonly runId: brand<String, "RunId">; readonly events: $Array<Union<readonly [Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.start">; readonly identity: Union<readonly [Struct<{ readonly kind: Literal<"agent">; readonly agent: String; readonly tool: optional<String>; }>, Struct<{ readonly kind: Literal<"process">; readonly tool: String; }>, Struct<{ readonly kind: Literal<"script">; readonly title: String; }>]>; readonly userFollowUpSupport: Enum<{ readonly UNSUPPORTED: "unsupported"; readonly NATIVE_INTERACTIVE: "nativeInteractive"; readonly TERMINAL_BACKED: "terminalBacked"; }>; readonly worktree: optional<NullOr<Struct<{ readonly workingDirectory: String; }>>>; readonly parent: NullOr<Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; readonly call: NullOr<Struct<{ readonly callId: String; readonly card: String; }>>; }>>; readonly provenance: NullOr<Union<readonly [Struct<{ readonly kind: Literal<"fork">; readonly from: Struct<{ readonly id: brand<String, "RunId">; readonly uid: String; }>; readonly at: Int; }>]>>; readonly approvalPolicy: optional<NullOr<Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>>>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.removed">; readonly runIds: $Array<brand<String, "RunId">>; readonly seq: Int; readonly commit: Int; readonly origin: NullOr<String>; readonly at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.activate">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.config">; readonly config: Union<readonly [Struct<{ readonly name: String; readonly instruction: String; readonly workingDirectory: optional<String>; readonly model: optional<String>; }>, Struct<{ readonly editedFile: withDecodingDefault<NullOr<String>, never>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly agent: withDecodingDefault<String, never>; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly asCaller: optional<NullOr<Boolean>>; readonly model: withDecodingDefault<String, never>; readonly instruction: withDecodingDefault<String, never>; readonly rootUserInstruction: optional<NullOr<String>>; readonly displayInstruction: optional<NullOr<String>>; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly cli: optional<NullOr<Struct<{ readonly outputFile: optional<NullOr<String>>; readonly outputDirectory: optional<NullOr<String>>; readonly expectedOutputFiles: optional<NullOr<$Array<String>>>; readonly teamId: optional<NullOr<String>>; }>>>; readonly delegationAgentScope: optional<NullOr<$Array<Trim>>>; readonly outputSchema: optional<NullOr<$Record<String, Unknown>>>; readonly script: optional<NullOr<Union<readonly [Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"background">; }>, Struct<{ readonly code: String; readonly title: String; readonly tools: $Array<String>; readonly timeoutMs: optional<NullOr<Int>>; readonly kind: Literal<"recipe">; readonly block: String; readonly options: $Record<String, Codec<Json, Json, never, never>>; }>]>>>; }>]>; readonly binding: optional<NullOr<Struct<{ readonly backend: Literals<readonly ["validation", "openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta"]>; readonly declinedRoutes: $Array<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>>; }>>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.model">; readonly model: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.detach">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.end">; readonly error: optional<Union<readonly [Struct<{ readonly message: optional<String>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["abort", "disk-full", "result-lost"]>; }>, Struct<{ readonly message: optional<String>; readonly statusCode: optional<optional<Int>>; readonly statusText: optional<optional<String>>; readonly provider: optional<optional<String>>; readonly classification: optional<optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>>; readonly requestId: optional<optional<String>>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; readonly kind: Literals<readonly ["context-window", "missing-api-key", "unexpected"]>; }>]>>; readonly outcome: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly output: Struct<{ readonly response: withDecodingDefault<String, never>; readonly files: withDecodingDefault<$Array<String>, never>; readonly structured: optional<Codec<Json, Json, never, never>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"conversation.progress">; readonly progress: Struct<{ readonly toolCallCount: Number; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.fact">; readonly fact: Struct<{ readonly key: Literal<"plan">; readonly plan: NullOr<Struct<{ readonly objective: String; }>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"child.park">; readonly phase: Literals<readonly ["parked", "resumed", "paused"]>; readonly resumeId: optional<String>; readonly heldFor: optional<String>; readonly ends: optional<Literals<readonly ["completed", "failed"]>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.description">; readonly description: String; readonly by: Literals<readonly ["model", "user"]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly kind: String; readonly parent: NullOr<brand<String, "RunId">>; readonly plugin: String; readonly stageId: optional<String>; readonly type: Literal<"plugin.fact">; readonly value: Codec<Json, Json, never, never>; readonly version: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.queued">; readonly followUpId: String; readonly content: Struct<{ readonly text: String; readonly displayText: optional<NullOr<String>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly from: Union<readonly [Struct<{ readonly kind: Literal<"user">; }>, Struct<{ readonly kind: Literal<"run">; readonly runId: brand<String, "RunId">; readonly relation: Literals<readonly ["parent", "child", "ancestor", "descendant", "sibling", "peer"]>; }>, Struct<{ readonly kind: Literal<"notification">; readonly source: Literal<"github">; }>]>; }>; readonly holdUntil: optional<Literals<readonly ["instruction", "turn", "generation"]>>; readonly control: optional<Union<readonly [Struct<{ readonly kind: Literal<"compact">; }>, Struct<{ readonly kind: Literal<"model">; readonly model: String; }>]>>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"followup.consumed">; readonly followUpId: String; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.opened">; readonly requestId: String; readonly payload: Union<readonly [Struct<{ readonly kind: Literal<"toolEdit">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly path: String; readonly relativePath: String; readonly sourceTool: String; readonly addedLines: Int; readonly removedLines: Int; }>; }>, Struct<{ readonly kind: Literal<"bash">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly command: String; readonly cwd: optional<String>; }>; }>, Struct<{ readonly kind: Literal<"retry">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly operation: String; readonly model: optional<String>; readonly errorMessage: optional<String>; readonly errorDetails: optional<Struct<{ readonly message: optional<String>; readonly statusCode: optional<optional<Int>>; readonly statusText: optional<optional<String>>; readonly provider: optional<optional<String>>; readonly classification: optional<optional<Struct<{ readonly kind: Union<readonly [Literal<"missing-api-key">, Literal<"context-window">, Literals<readonly ["upstream-credit", "chatgpt-subscription", "kimi-code-subscription", "glm-coding-plan", "xai-subscription"]>]>; }>>>; readonly requestId: optional<optional<String>>; readonly partialText: optional<optional<String>>; readonly userRetryable: optional<Boolean>; }>>; readonly credentialSwitch: optional<NullOr<Union<readonly [Struct<{ readonly kind: Literal<"decline-route">; readonly route: Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription"]>; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; readonly automatic: Boolean; }>, Struct<{ readonly kind: Literal<"new-key">; readonly provider: Literals<readonly ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope", "minimax", "glm", "meta", "kimiCode"]>; }>]>>>; }>; }>, Struct<{ readonly kind: Literal<"proposal">; readonly data: Struct<{ readonly agent: String; readonly agentSource: optional<NullOr<Enum<{ readonly CUSTOM: "custom"; readonly BUILT_IN: "builtIn"; readonly PLUGIN: "plugin"; readonly INLINE: "inline"; }>>>; readonly persona: optional<NullOr<Struct<{ readonly description: optional<String>; readonly name: Trim; readonly prompt: optional<String>; readonly temperature: optional<Number>; readonly tools: optional<$Array<String>>; }>>>; readonly model: String; readonly instruction: String; readonly memories: withDecodingDefault<$Array<String>, never>; readonly workingDirectory: optional<NullOr<String>>; readonly script: optional<NullOr<Struct<{ readonly title: NullOr<String>; readonly source: String; readonly calls: $Array<Struct<{ readonly toolName: String; readonly preview: String; }>>; }>>>; readonly inputFiles: withDecodingDefault<$Array<String>, never>; readonly contextFiles: withDecodingDefault<$Array<String>, never>; readonly mediaFiles: withDecodingDefault<$Array<String>, never>; readonly outputFiles: withDecodingDefault<$Array<String>, never>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly task: Boolean; readonly rootUserInstruction: optional<NullOr<String>>; readonly requestId: String; readonly runId: brand<String, "RunId">; }>; }>, Struct<{ readonly kind: Literal<"planApproval">; readonly data: Struct<{ readonly requestId: String; readonly runId: brand<String, "RunId">; readonly plan: Struct<{ readonly objective: String; }>; }>; }>, Struct<{ readonly kind: Literal<"externalInquiry">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly question: String; readonly threadId: decodeTo<String, String, never, never>; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; readonly sessionLinks: optional<NullOr<$Array<Trim>>>; readonly transcript: optional<NullOr<$Array<Union<readonly [Struct<{ readonly kind: Literal<"open">; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly kind: Literal<"answered">; readonly answer: String; readonly answeredAt: String; readonly sessionLinks: optional<NullOr<$Array<Trim>>>; readonly turnIndex: Int; readonly timestamp: String; readonly question: String; readonly context: optional<NullOr<String>>; readonly suggestSearch: optional<NullOr<Boolean>>; readonly attachFiles: optional<NullOr<$Array<String>>>; }>]>>>>; }>; }>, Struct<{ readonly kind: Literal<"userQuestion">; readonly data: Struct<{ readonly requestId: String; readonly allowBypass: Boolean; readonly runId: Union<readonly [brand<String, "RunId">, Literal<"">]>; readonly questions: $Array<Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>>; readonly context: optional<NullOr<String>>; }>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"request.decided">; readonly requestId: String; readonly decision: Union<readonly [Struct<{ readonly action: Literal<"approve">; readonly model: optional<NullOr<String>>; readonly agent: optional<NullOr<String>>; readonly instruction: optional<NullOr<String>>; readonly inputFiles: optional<NullOr<$Array<String>>>; readonly contextFiles: optional<NullOr<$Array<String>>>; readonly mediaFiles: optional<NullOr<$Array<String>>>; readonly options: optional<NullOr<$Record<String, Codec<Json, Json, never, never>>>>; readonly content: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"approve_and_goal">; readonly autoApproveAll: optional<NullOr<Literal<true>>>; }>, Struct<{ readonly action: Literal<"submit">; readonly answers: $Record<String, Union<readonly [String, $Array<String>]>>; }>, Struct<{ readonly action: Literal<"answer">; readonly answer: String; readonly sessionLinks: optional<NullOr<$Array<String>>>; }>, Struct<{ readonly action: Literal<"skip">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"retry">; readonly feedback: optional<NullOr<String>>; readonly credentials: optional<NullOr<Literals<readonly ["configured", "personal"]>>>; }>, Struct<{ readonly action: Literal<"reject">; readonly feedback: optional<NullOr<String>>; }>, Struct<{ readonly action: Literal<"deny">; readonly reason: String; }>, Struct<{ readonly action: Literal<"cancel">; readonly cause: optional<NullOr<String>>; }>]>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"approval.policy">; readonly snapshot: Struct<{ readonly own: $Record<Literals<readonly ["bash", "toolEdit", "superYolo"]>, optionalKey<Literals<readonly ["on", "off", "parent"]>>>; readonly goal: $Array<Literals<readonly ["bash", "toolEdit", "superYolo"]>>; readonly limit: optional<Literals<readonly ["never", "ask"]>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly aggregateId: brand<String, "AggregateId">; readonly stageId: optional<String>; readonly type: Literal<"run.position">; readonly payload: Struct<{ readonly family: Literals<readonly ["toolUse"]>; readonly at: Literals<readonly ["turn.ready", "turn.begin", "turn.end", "response.ready", "results.ready", "waiting", "halted"]>; readonly turn: optional<NullOr<Int>>; readonly outcome: optional<NullOr<Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>>>; }>; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"log">; readonly stageId: optional<String>; readonly level: Enum<{ readonly ERROR: "error"; readonly WARN: "warn"; readonly INFO: "info"; readonly DEBUG: "debug"; }>; readonly message: String; readonly data: optional<Codec<Json, Json, never, never>>; readonly messageType: optional<Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.start">; readonly stageId: optional<String>; readonly id: String; readonly label: String; readonly parentId: optional<NullOr<String>>; readonly kind: optional<NullOr<Literals<readonly ["run", "session", "script"]>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stage.end">; readonly stageId: optional<String>; readonly id: String; readonly status: Enum<{ readonly COMPLETED: "completed"; readonly CANCELLED: "cancelled"; readonly FAILED: "failed"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.start">; readonly stageId: optional<String>; readonly logId: String; readonly toolName: String; readonly input: Codec<Json, Json, never, never>; readonly phase: optional<String>; readonly attempt: optional<Int>; readonly card: optional<Struct<{ readonly title: String; readonly sections: $Array<Union<readonly [Struct<{ readonly kind: Literal<"text">; readonly label: String; readonly text: String; }>, Struct<{ readonly kind: Literal<"status">; readonly label: String; readonly status: String; }>, Struct<{ readonly kind: Literal<"identifier">; readonly label: String; readonly value: String; }>, Struct<{ readonly kind: Literal<"badges">; readonly label: String; readonly badges: $Array<String>; }>, Struct<{ readonly kind: Literal<"fileList">; readonly label: String; readonly files: $Array<Struct<{ readonly path: String; readonly note: optional<String>; }>>; }>]>>; }>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"tool.end">; readonly stageId: optional<String>; readonly logId: String; readonly status: Enum<{ readonly IN_PROGRESS: "in_progress"; readonly COMPLETED: "completed"; readonly FAILED: "failed"; }>; readonly result: optional<Codec<Json, Json, never, never>>; readonly files: optional<$Array<Struct<{ readonly path: String; readonly ok: Boolean; readonly source: optional<String>; readonly sourceDisplay: optional<String>; readonly varName: optional<String>; readonly media: optional<Union<readonly [Struct<{ readonly kind: Literal<"image">; readonly mimeType: String; readonly sizeBytes: Int; }>, Struct<{ readonly kind: Literal<"audio">; readonly mimeType: String; readonly sizeBytes: Int; }>]>>; }>>>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"usage">; readonly stageId: optional<String>; readonly usage: Struct<{ readonly inputTokens: Int; readonly outputTokens: Int; readonly cost: Number; readonly cacheReadInputTokens: optional<Int>; readonly cacheMissInputTokens: optional<Int>; readonly cacheCreationInputTokens: optional<Int>; readonly reasoningTokens: optional<Int>; readonly usageRoute: optional<Literals<readonly ["chatgpt-subscription", "xai-subscription", "kimi-code-subscription", "glm-coding-plan-subscription", "api-key"]>>; readonly usagePlan: optional<String>; readonly elapsedTime: optional<Number>; readonly toolUseTokens: optional<Int>; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"context.state">; readonly stageId: optional<String>; readonly inputTokens: Int; readonly contextWindow: Int; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.start">; readonly stageId: optional<String>; readonly id: String; readonly kind: Enum<{ readonly THINKING: "thinking"; readonly SCRATCHPAD: "scratchpad"; readonly FILE_LIST: "fileList"; readonly TOOL_USE: "toolUse"; readonly WEB_SEARCH: "webSearch"; readonly MODEL_RESPONSE: "modelResponse"; readonly USER_MESSAGE: "userMessage"; readonly PROGRESS_STATUS: "progressStatus"; readonly CONTEXT_COMPACTION_ACTIVITY: "contextCompactionActivity"; readonly ERROR: "error"; readonly CONTEXT_MANAGEMENT: "contextManagement"; readonly DEFAULT: "default"; }>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"stream.end">; readonly stageId: optional<String>; readonly id: String; readonly finalText: optional<String>; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>, Struct<{ readonly type: Literal<"response.finalized">; readonly stageId: optional<String>; readonly text: String; readonly aggregateId: brand<String, "AggregateId">; seq: Int; commit: Int; origin: NullOr<String>; at: Int; }>]>>; }>
```

## TraceFactArm

A plugin row kind as an imported trace reads it: a `Plugin` arm.

```ts
interface TraceFactArm {
  readonly plugin: string;
  readonly kind: string;
  readonly version: number;
  readonly schema: Schema.Codec<unknown, unknown>;
  readonly upcasters: readonly unknown[];
}
```

## TranscriptView

A stream's transcript slice: what hosts paint.

```ts
type TranscriptView = RunView['transcript'];
```

## truncateSummary

Collapse whitespace first, then truncate to a fixed-width one-line summary.

```ts
function truncateSummary(text: string, maxLength: number): string
```

## truncateWithEllipsis

Truncate a string to `maxLen` grapheme clusters with a trailing ellipsis (`…`).
Returns the original string unchanged if it fits within the limit.

Uses `Intl.Segmenter` so multi-codepoint graphemes (ZWJ emoji sequences like
👨‍👩‍👧, combining diacritics, …) are counted and cut as single units — no
split surrogates and no torn emoji.

- `@example` truncateWithEllipsis('short', 60)           // 'short'
  truncateWithEllipsis('a very long text', 10) // 'a very lo…'

```ts
function truncateWithEllipsis(text: string, maxLen: number): string
```

## UsageRoute

The route a request's usage is billed through.

```ts
type UsageRoute = typeof UsageRouteSchema.Type;
```

## UserQuestionAnswers

```ts
type UserQuestionAnswers = typeof UserQuestionAnswersSchema.Type;
```

## UserQuestionAnswersSchema

```ts
const UserQuestionAnswersSchema: $Record<String, Union<readonly [String, $Array<String>]>>
```

## UserQuestionPermission

```ts
type UserQuestionPermission =
  (typeof UserQuestionPermissionSchema)['Type'];
```

## UserQuestionPrompt

```ts
type UserQuestionPrompt = typeof UserQuestionPromptSchema.Type;
```

## UserQuestionPromptSchema

```ts
const UserQuestionPromptSchema: Struct<{ readonly question: String; readonly header: optional<NullOr<String>>; readonly options: $Array<Struct<{ readonly label: String; readonly description: optional<NullOr<String>>; }>>; readonly multiSelect: optional<NullOr<Boolean>>; readonly allowFreeText: optional<NullOr<Boolean>>; }>
```

## WorkspaceAgentsSelection

```ts
type WorkspaceAgentsSelection =
  (typeof WorkspaceAgentsSelectionSchema)['Type'];
```

## WorkspaceFileLocation

```ts
type WorkspaceFileLocation = typeof WorkspaceFileLocationSchema.Type;
```

## WorkspaceStateKey

The harness's workspace and global state keys. An app's keys live beside
its setting rows, and a plugin's beside the rows its `Plugin` value
declares.

The stores these keys address are the session's `roots.workspaceState`,
taken as data from the session, tool call or host command that holds it,
and the process's `AppState` service. Each host wires its own
implementation at startup.

```ts
const WorkspaceStateKey: Readonly<{ readonly WORKSPACE_AGENTS: "texra.workspaceAgents"; readonly CUSTOM_TEAMS: "texra.customTeams"; readonly HIDDEN_CUSTOM_AGENTS: "texra.hiddenCustomAgents"; readonly DISABLED_SKILLS: "texra.skills.disabled"; readonly DISABLED_SKILL_SOURCES: "texra.skills.disabledSources"; readonly GIT_MARK_COMMITS: "texra.git.markCommits"; readonly GIT_AUTHOR_NAME: "texra.git.authorName"; readonly GIT_AUTHOR_EMAIL: "texra.git.authorEmail"; readonly GIT_WORKTREE_SUPPORT: "texra.git.worktreeSupport"; readonly TOOL_PATH_PROTECTION_ENABLED: "texra.tools.restrictPathsToWorkingDirectory"; }>
```

## WorktreeInfo

```ts
type WorktreeInfo = typeof WorktreeInfoSchema.Type;
```
