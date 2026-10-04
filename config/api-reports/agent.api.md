# `@texra-ai/agent` API report

Generated from `packages/agent/src/index.ts` by `node scripts/check-core-quality.mjs --update`; do not edit. A diff here is a change to the public surface.

Exports: 37

- `AgentEvent` — `type AgentEvent = TraceArm<'log' | 'stage.start' | 'stage.end' | 'tool.start' | 'tool.end' | 'usage' | 'conversation.progress' | 'run.fact' | 'context.state' | 'stream.start' | 'stream.end' | 'response.finalized'> | (TraceArm<'run.config'> & { readonly runId: RunId; }) | StreamChunkEvent;`
- `AgentNotFound` — `class AgentNotFound { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, agent, cause, message, name, pipe, stack, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `AgentPlatform` — `interface AgentPlatform { readonly agentDirectories: AgentDirectoriesPort; readonly toolMissingHandler?: ToolMissingHandler; readonly roots: WorkspaceRoots; readonly secrets: PlatformSecrets; readonly languageModel: LanguageModelPort; readonly mcpConfigPath: string; }`
- `aggregateId` — `function aggregateId: { (kind: "run", logicalId: string & $brand<"RunId">): string & $brand<"AggregateId">; (kind: "inquiry", logicalId: LogicalId): string & $brand<"AggregateId">; }`
- `AggregateId` — `type AggregateId = z.infer<typeof AggregateIdSchema>;`
- `Composition` — `interface Composition { readonly platform: AgentPlatform; readonly plugins: readonly Plugin[]; }`
- `DatabaseOpenFailed` — `class DatabaseOpenFailed { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, message, name, path, pipe, stack, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `DatabaseReadFailed` — `class DatabaseReadFailed { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, message, name, path, pipe, stack, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `DefinedTool` — `type DefinedTool<T, R = never> = Omit<ITool<Error, R>, 'call'> & { call(rawInput: unknown): Effect.Effect<ToolResult, Error, Exclude<R, Scope.Scope>>; readonly parallelSafe: boolean | undefined; readonly replay: ITool['replay']; readonly requiresApproval: ITool['requiresApproval']; readonly slow: boolean | undefined; readonly unavailableHosts: readonly SettingHost[] | undefined; readonly guard: ToolGuard<T, R> | undefined; readonly describe: ITool['describe']; };`
- `defineTool` — `function defineTool: <T, R = never>(def: DefineToolOptions<T, R>) => DefinedTool<T, R>`
- `ITool` — `interface ITool<E = Error, R = never> { readonly definition: ToolDefinition; readonly unavailableHosts?: readonly SettingHost[]; readonly parallelSafe?: boolean; readonly ownsConcurrency?: boolean; readonly scriptGlobal?: { readonly positional: string; }; readonly replay?: 'safe' | 'unsafe'; readonly requiresApproval?: boolean | 'inBody'; readonly slow?: boolean; readonly guard?: ToolGuard<never, R>; readonly describe?: (declared: readonly Pick<ITool, 'definition' | 'scriptGlobal'>[]) => string; call(rawInput: unknown): Effect.Effect<ToolResult, E, R>; }`
- `IToolRegistry` — `interface IToolRegistry<E = Error, R = never> { get(name: string): ITool<E, R> | undefined; has(name: string): boolean; }`
- `LaunchError` — `type LaunchError = AgentNotFound | ToolsRefused;`
- `MapToolRegistry` — `class MapToolRegistry { static: ; instance: get, has, tools }`
- `Outcome` — `type Outcome = z.infer<typeof OutcomeSchema>;`
- `PlatformConflict` — `class PlatformConflict { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, message, name, pipe, stack, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `Plugin` — `interface Plugin { readonly id: string; readonly name: string; readonly category: ToolCategory; readonly description: string; readonly tools?: Readonly<Record<string, RuntimeTool>>; readonly availability?: ToolAvailabilityChecks; readonly hidden?: boolean; readonly unavailableHosts?: readonly SettingHost[]; readonly settings?: readonly (readonly [ key: string, label: string ])[]; readonly injectedWhen?: Readonly<Record<string, string | true>>; readonly toggleable?: boolean; readonly onByDefault?: true; readonly continuation?: Continuation; readonly prompt?: PromptSection; readonly rounds?: RoundMode; readonly processLayer?: ProcessPluginLayer; readonly sessionLayer?: SessionPluginLayer; readonly skills?: true; readonly agents?: true; readonly setup?: ToolPluginSetup; }`
- `RequestError` — `type RequestError = NotOwner | Unavailable | Cancelled | Rejected | Internal;`
- `Run` — `interface Run { readonly runId: RunId; readonly result: Effect.Effect<RunEndResult, RunFailure>; readonly view: Stream.Stream<SessionView>; readonly events: Stream.Stream<AgentEvent, RunFailure>; readonly interrupt: Effect.Effect<void>; }`
- `RunEndResult` — `type RunEndResult = z.infer<typeof RunEndResultSchema>;`
- `RunFailure` — `class RunFailure { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, message, name, pipe, stack, toJSON, toString, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `RunId` — `type RunId = z.infer<typeof RunIdSchema>;`
- `RuntimeRequest` — `type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;`
- `RunView` — `type RunView = ReadonlyDeep<RuntimeRunView>;`
- `Session` — `interface Session { readonly roots: WorkspaceRoots; readonly start: (input: StartInput) => Effect.Effect<Run, LaunchError | RunFailure>; readonly request: (request: RuntimeRequest) => Effect.Effect<Outcome, RequestError>; readonly view: { readonly changes: Stream.Stream<SessionView>; }; readonly subscribe: (interests: readonly TranscriptSubscription[]) => Effect.Effect<void, never, Scope.Scope>; }`
- `SessionCloseReport` — `type SessionCloseReport = z.infer<typeof SessionCloseReportSchema>;`
- `SessionOpenError` — `type SessionOpenError = DatabaseOpenFailed | DatabaseReadFailed;`
- `Sessions` — `class Sessions { static: Identifier, Service, __@NodeInspectSymbol@116, __@ignoreSymbol@710, __@iterator@97, __@typeSymbol@706, __@unifySymbol@708, context, key, layer, of, pipe, toJSON, toString, use, useSync, ~effect/Context/Service, ~effect/Effect; instance: Service, key, ~effect/Context/Service }`
- `SessionView` — `type SessionView = ReadonlyDeep<RuntimeSessionView>;`
- `SettingHost` — `type SettingHost = (typeof SETTING_HOSTS)[number];`
- `StartInput` — `interface StartInput { readonly agent: string; readonly instruction: string; readonly model?: string; readonly tools?: readonly ITool[]; }`
- `ToolGuard` — `interface ToolGuard<T, R = never> { readonly writes?: (input: T) => readonly string[]; readonly bash?: (input: T) => Effect.Effect<string, Error, R>; readonly cwd?: 'workspace' | 'unknown'; }`
- `ToolsRefused` — `class ToolsRefused { static: ; instance: __@NodeInspectSymbol@116, __@iterator@97, _tag, cause, message, name, pipe, stack, toJSON, toString, tools, ~effect/Effect, ~effect/ErrorReporter/attributes, ~effect/ErrorReporter/ignore, ~effect/ErrorReporter/severity, ~effect/Runtime/errorExitCode, ~effect/Runtime/errorReported }`
- `ToolUseRunEndResult` — `type ToolUseRunEndResult = z.infer<typeof ToolUseRunEndResultSchema>;`
- `TranscriptSubscription` — `type TranscriptSubscription = z.infer<typeof TranscriptSubscriptionSchema>;`
- `TranscriptView` — `type TranscriptView = ReadonlyDeep<RuntimeTranscriptView>;`
- `WorkflowRunEndResult` — `type WorkflowRunEndResult = z.infer<typeof WorkflowRunEndResultSchema>;`
