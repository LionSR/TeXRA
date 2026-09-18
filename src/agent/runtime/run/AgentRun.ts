/**
 * The per-run service: everything one run owns, provided once at the
 * `executeAgent` boundary for the run's lifetime (injection step 6, Q3). Run
 * identity and the parent edge, the launch configuration, the resolved tool
 * registry, the trace emitter, the owning session's interaction and retry
 * ports, and the bound llm `Model` in a synchronized cell a mid-run switch
 * replaces. Nothing here is threaded through node fields or a services bag;
 * the loop and the invoker take it from context.
 */
import { Context, Effect, Layer, Scope, SynchronizedRef } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type {
  RuntimeTool as ITool,
  RuntimeToolRegistry as IToolRegistry,
} from '@agent/runtime/ToolServices';
import type { AgentTrace, StageHandle } from '@agent/trace';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import type { ToolInjections } from '@agent/runtime/toolInjection';
import type { UsageMonitor } from '@agent/runtime/UsageMonitor';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { LanguageModel } from '@platform/languageModel';
import {
  AgentCategory,
  DeclinableUsageRouteSchema,
  type AgentDelegationScope,
  type DeclinableUsageRoute,
  type JsonValue,
  type RunId,
  type SubagentProgressUpdate,
  type UserVariableChannels,
} from '@shared/schemas';
import { RunLedger } from '@shared/session/runLedger';
import { getDefaultToolRegistry } from '@tools/registry';
import {
  buildOverlayToolRegistry,
  buildTerminalTool,
} from '@tools/structuredOutput';
import { ensureError } from '@utils/errors/errorMessage';
import { RunFileService } from '@utils/files/runStorage';

import { bindModel, type BoundModel } from './modelBinding';
import type { HttpClient } from 'effect/unstable/http';
import type { AgentLaunchContext } from '../AgentLaunchContext';
import type { SessionHandle } from '../SessionHandle';

/**
 * The routes a launch declines before it has any ledger state: an
 * own-API-key fallback turns away from every subscription route, since the
 * user answered a quota prompt by choosing to pay with their own key.
 */
function launchDeclinedRoutes(
  ctx: AgentLaunchContext,
): readonly DeclinableUsageRoute[] {
  return ctx.ownApiKeyFallback ? DeclinableUsageRouteSchema.options : [];
}

/**
 * Immutable per-run tool policy, resolved by the launch and read from the
 * run's `AgentRun` service.
 *
 * A frozen value the loop takes from context runs without an
 * `AsyncLocalStorage` frame — the property an SDK embedder wants.
 */
export interface ToolPolicy {
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Hide tools unavailable because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Stop a tool-use run after one model/tool cycle instead of waiting. */
  readonly stopAfterCycle?: boolean;
}

interface RunCallbacks {
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** Root-run-only: fires at every turn boundary before the follow-up wait. */
  readonly onIdle?: () => void;
  /** Fires once the run's model changed and the cell holds the new binding. */
  readonly onModelChanged: (model: string) => void;
}

export interface AgentRunShape {
  readonly runId: RunId;
  /** The launching run, or null for a root. */
  readonly parentRunId: RunId | null;
  readonly session: SessionHandle;
  readonly config: AgentConfig;
  /** The setting with the run's resolved tool list; the loop of the run's
   *  family narrows it. */
  readonly setting: AgentSetting;
  readonly prompt: AgentPrompt;
  readonly logger: AgentTrace;
  readonly parentStage: StageHandle;
  readonly toolPolicy: ToolPolicy;
  readonly workingDirectory?: string;
  readonly delegationAgentScope?: AgentDelegationScope | null;
  readonly onApprovalPolicyDenial?: () => void;
  /** The process stores the launch read; every route and credential read
   *  below the loop takes them from here. */
  readonly stores: ModelOptionStores;
  readonly userVarChannels: UserVariableChannels;
  /** Initial user row to log after the loop has inserted launch media. */
  readonly initialUserMessageForTranscript: string | undefined;
  readonly fileService: RunFileService;
  readonly tools: IToolRegistry;
  /** The synthetic terminal tool, when the config declares an output schema. */
  readonly finalToolName: string | null;
  /** The value the terminal tool captured, read by the loop at its exit. A
   *  plain slot: the tool's capture callback is synchronous. */
  readonly structured: { value: JsonValue | undefined };
  /** The run's live model binding; a mid-run switch replaces it. */
  readonly model: SynchronizedRef.SynchronizedRef<BoundModel>;
  /**
   * Subscription routes this run must not bind: the launch's own-API-key
   * fallback, plus every retry the user answered with their own key. The
   * run's opening snapshot records them and each retry appends to the
   * recorded set, so a resume rebinds under the same choice — and the user's
   * stored preferences are never rewritten to express it.
   */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  /**
   * The run's scope: a parallel-strategy child of the layer's, closed when
   * the run's layer is released. A model bound mid-run (a manual retry's
   * rebind, a host-admitted switch) is acquired into it, so an editor model
   * or uploaded file it holds retires with the run. Parallel, so a run that
   * replaced its binding repeatedly closes every retained release — each
   * already bounded — concurrently, instead of paying one release per
   * replaced binding in sequence.
   */
  readonly scope: Scope.Scope;
  /**
   * A switch the host admitted (the registry name of the next model),
   * applied by the loop at its next model boundary so the ledger rows that
   * record it are appended by the one fiber that holds the run's state. A
   * plain slot: the host's request is synchronous.
   */
  readonly pendingModelSwitch: { value: string | null };
  /**
   * Run a Promise-tier operation inside the launch's async-local frame (the
   * ambient `RunContext` and the session's workspace roots). Effect fibers
   * resume outside that frame, so every call into tool, prompt, goal or
   * storage code that reads it goes through here.
   */
  readonly inScope: <A>(operation: () => A) => A;
  readonly usageMonitor: UsageMonitor;
  readonly callbacks: RunCallbacks;
  /**
   * The run's one stop: completes the launch context's stop latch, so the
   * boundary that owns the run's program interrupts it. The run's
   * `AbortSignal` is aborted from that interruption, not from here.
   */
  readonly interrupt: () => void;
}

export class AgentRun extends Context.Service<AgentRun, AgentRunShape>()(
  '@texra/agent/AgentRun',
) {}

interface AgentRunLayerInput {
  readonly parentRunId: RunId | null;
  /** Caller-supplied tools available only to this run. */
  readonly tools?: readonly ITool[];
  /** The conditional tool injections this run resolves its tools with. */
  readonly toolInjections: ToolInjections['Service'];
  readonly callbacks: RunCallbacks;
  readonly onApprovalPolicyDenial?: () => void;
  readonly inScope: <A>(operation: () => A) => A;
}

/**
 * Build the run's service from its launch context. The model identity of a
 * resumed run comes from the latest `flow.snapshot` (the one indexed read
 * L0 provided), never from a file; a fresh run binds the launch's model
 * under the route the launch context already resolved.
 */
export const agentRunLayer = (
  ctx: AgentLaunchContext,
  input: AgentRunLayerInput,
): Layer.Layer<
  AgentRun,
  Error,
  RunLedger | LanguageModel | HttpClient.HttpClient
> =>
  Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const { runId, session } = ctx;
      const { logger, config } = ctx;
      const ledger = yield* RunLedger;
      const layerScope = yield* Effect.scope;
      // One parallel child holds every binding the run acquires: at close,
      // each replaced binding's remaining release runs concurrently under
      // its own deadline rather than one after another.
      const scope = yield* Scope.fork(layerScope, 'parallel');

      const baseRegistry = getDefaultToolRegistry();
      const { setting } = ctx;
      const resolvedTools = yield* resolveAgentTools({
        tools: setting.tools,
        registry: baseRegistry,
        logger,
        approvalPromptsUnavailable: ctx.toolPolicy.approvalPromptsUnavailable,
        runtimeUnavailableTools: ctx.toolPolicy.runtimeUnavailableTools,
        toolInjections: input.toolInjections,
        settings: session.roots,
        stores: ctx.stores,
        delegationScope: ctx.delegationAgentScope ?? undefined,
        inScope: input.inScope,
      });
      const overlayTools: ITool[] = [];
      const overlayNames = new Set<string>();
      const appendOverlayTool = (tool: ITool): void => {
        const { name } = tool.definition;
        const definitionIndex = resolvedTools.findIndex(
          (definition) => definition.name === name,
        );
        if (
          overlayNames.has(name) ||
          baseRegistry.has(name) ||
          definitionIndex !== -1
        ) {
          logger.warn(`Run-scoped tool "${name}" shadows an existing tool.`);
        }
        overlayNames.add(name);
        const definition = { ...tool.definition, forceFunctionCall: true };
        if (definitionIndex === -1) {
          resolvedTools.push(definition);
        } else {
          resolvedTools[definitionIndex] = definition;
        }
        overlayTools.push(tool);
      };
      for (const tool of input.tools ?? []) appendOverlayTool(tool);

      // Unforced structured-output floor: when the config declares an output
      // schema, a synthetic `submit_output` terminal tool joins the model
      // facing list. The model finishes by calling it; its own Zod schema
      // validates the call and `capture` records the value into the run's
      // slot, which the loop reads at exit.
      const structured: { value: JsonValue | undefined } = {
        value: undefined,
      };
      let finalToolName: string | null = null;
      const outputSchema =
        config.agentCategory === AgentCategory.ToolUse
          ? config.outputSchema
          : undefined;
      if (outputSchema) {
        const terminalTool = buildTerminalTool(outputSchema, (value) => {
          structured.value = value;
        });
        finalToolName = terminalTool.definition.name;
        appendOverlayTool(terminalTool);
      }
      const tools = overlayTools.length
        ? buildOverlayToolRegistry(baseRegistry, overlayTools)
        : baseRegistry;

      // The model of a resumed run is the one its latest snapshot names; a
      // fresh run binds the launch model under the route the launch context
      // resolved for it (including a persisted compatibility key).
      const snapshot = yield* ledger.latestSnapshot(runId);
      const persisted = snapshot === null ? null : snapshot.payload.runtime;
      const modelId = persisted?.modelId ?? config.model;
      const compatibilityKey =
        persisted !== null
          ? persisted.modelCompatibilityKey
          : ctx.modelCompatibilityKey;
      const modelConfig =
        modelId === config.model
          ? ctx.modelConfig
          : yield* resolveRuntimeModelConfig(modelId);
      if (!modelConfig) {
        return yield* Effect.fail(
          new Error(`Model ${modelId} is not registered`),
        );
      }
      // The routes this run declines: a resumed run replays the set its
      // snapshot recorded, a fresh own-API-key fallback declines every
      // subscription route from its first binding. Nothing here reads or
      // writes the user's stored preferences.
      const declinedRoutes =
        persisted?.declinedRoutes ?? launchDeclinedRoutes(ctx);
      const bound = yield* bindModel({
        config: modelConfig,
        stores: ctx.stores,
        roots: session.roots,
        compatibilityKey,
        ownApiKeyFallback: ctx.ownApiKeyFallback,
        declinedRoutes,
        agentCategory: config.agentCategory,
        temperature: setting.temperature,
        inScope: input.inScope,
      }).pipe(Scope.provide(scope));
      const model = yield* SynchronizedRef.make(bound);
      const pendingModelSwitch: { value: string | null } = { value: null };

      return {
        runId,
        parentRunId: input.parentRunId,
        session,
        config,
        setting: { ...setting, tools: resolvedTools },
        prompt: ctx.prompt,
        logger,
        parentStage: ctx.parentStage,
        toolPolicy: ctx.toolPolicy,
        workingDirectory: ctx.workingDirectory,
        delegationAgentScope: ctx.delegationAgentScope,
        onApprovalPolicyDenial: input.onApprovalPolicyDenial,
        stores: ctx.stores,
        userVarChannels: ctx.userVarChannels,
        initialUserMessageForTranscript: ctx.initialUserMessageForTranscript,
        fileService: new RunFileService(runId, session.roots),
        tools,
        finalToolName,
        structured,
        model,
        declinedRoutes,
        scope,
        pendingModelSwitch,
        usageMonitor: ctx.usageMonitor,
        callbacks: input.callbacks,
        interrupt: ctx.interrupt,
        inScope: input.inScope,
      };
    }),
  );
