/**
 * The per-run service: everything one run owns, provided once at the
 * `executeAgent` boundary for the run's lifetime (injection step 6, Q3). Run
 * identity and the parent edge, the launch configuration, the resolved tool
 * registry, the trace emitter, the owning session's interaction and retry
 * ports, and the bound llm `Model` in a synchronized cell a mid-run switch
 * replaces. Nothing here is threaded through node fields or a services bag;
 * the loop and the invoker take it from context.
 */
import { MODEL_CONFIGS } from 'llm-zoo';
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
import type { UsageMonitor } from '@agent/runtime/UsageMonitor';
import { MapToolRegistry } from '@agent/core/tools/ToolTypes';
import { withLogChannel } from '@logger/effectLog';
import type { ModelOptionStores } from '@model/computeModelOptions';
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
import type { RunState } from '@shared/session/runStateFold';
import type {
  CompositionKey,
  Compositions,
  PinnedComposition,
} from '@tools/compositions';
import { buildTerminalTool } from '@tools/structuredOutput';
import type { ToolRegistry } from '@tools/toolTable';
import { processToolHost } from '@utils/config/platformSettings';
import { RunFileService } from '@utils/files/runStorage';

import { bindModel, type BoundModel } from './modelBinding';
import { offeredToolset } from './tools';
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
 * A frozen value the loop takes from context, with no ambient frame anywhere
 * beneath it — the property an SDK embedder wants.
 */
export interface ToolPolicy {
  /** Hide tools whose approval prompts cannot be answered in this host mode. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Stop a tool-use run after one model/tool cycle instead of waiting. */
  readonly stopAfterCycle?: boolean;
  /** The composition a delegated child joins: the one its parent pinned. */
  readonly composition?: CompositionKey;
}

interface RunCallbacks {
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** Current folded state at an idle turn boundary, after child delivery. */
  readonly onIdle?: (state: RunState) => void;
}

export interface AgentRunShape {
  readonly runId: RunId;
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
  /**
   * Record that this run met an approval-policy denial: a request settled as
   * denied, or (with `withheldTools`) approval-gated tools were withheld from
   * the model when the run resolved its tools.
   */
  readonly onApprovalPolicyDenial?: (withheldTools?: readonly string[]) => void;
  /** The process stores the launch read; every route and credential read
   *  below the loop takes them from here. */
  readonly stores: ModelOptionStores;
  readonly userVarChannels: UserVariableChannels;
  /** Initial user row to log after the loop has inserted launch media. */
  readonly initialUserMessageForTranscript: string | undefined;
  readonly fileService: RunFileService;
  readonly tools: IToolRegistry;
  /**
   * The composition the run pinned (or joined, as a delegated child) for its
   * lifetime: its children join it, and its plugins' services reach its
   * tool calls.
   */
  readonly composition: PinnedComposition;
  /** The toolset the run was offered at open, which a tool-use snapshot
   *  records; a resumed run carries its recorded set forward unchanged. */
  readonly toolset: ReturnType<typeof offeredToolset>;
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
  readonly usageMonitor: UsageMonitor;
  readonly callbacks: RunCallbacks;
}

export class AgentRun extends Context.Service<AgentRun, AgentRunShape>()(
  '@texra/agent/AgentRun',
) {}

interface AgentRunLayerInput {
  /** Caller-supplied tools available only to this run. */
  readonly tools?: readonly ITool[];
  readonly callbacks: RunCallbacks;
  readonly onApprovalPolicyDenial?: AgentRunShape['onApprovalPolicyDenial'];
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
  | RunLedger
  | LanguageModel
  | HttpClient.HttpClient
  | ToolRegistry
  | Compositions
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

      const { setting } = ctx;

      // Unforced structured-output floor: when the config declares an output
      // schema, a synthetic `submit_output` terminal tool joins the run's own
      // tools. The model finishes by calling it; its own Zod schema
      // validates the call and `capture` records the value into the run's
      // slot, which the loop reads at exit.
      const structured: { value: JsonValue | undefined } = {
        value: undefined,
      };
      const outputSchema =
        config.agentCategory === AgentCategory.ToolUse
          ? config.outputSchema
          : undefined;
      const terminalTool = outputSchema
        ? buildTerminalTool(outputSchema, (value) => {
            structured.value = value;
          })
        : undefined;
      const finalToolName = terminalTool?.definition.name ?? null;
      // The composition is pinned in this layer's scope, so the run holds it
      // until its layer is released; a delegated child joins its parent's.
      const resolved = yield* resolveAgentTools({
        tools: setting.tools,
        logger,
        approvalPromptsUnavailable: ctx.toolPolicy.approvalPromptsUnavailable,
        onApprovalPolicyDenial: input.onApprovalPolicyDenial,
        host: processToolHost(),
        runTools: terminalTool
          ? [...(input.tools ?? []), terminalTool]
          : input.tools,
        // The reflection family injects none: memory and plan are tool-use
        // infrastructure.
        injectTools: setting.agentCategory === AgentCategory.ToolUse,
        stores: ctx.stores,
        workspaceRoot: session.roots.workspace,
        delegationScope: ctx.delegationAgentScope ?? undefined,
        inherited: ctx.toolPolicy.composition,
      });
      yield* Effect.logDebug(
        `Run ${runId} pinned tool composition ${resolved.pinned.key.hash}`,
      ).pipe(
        // The key's own composition, which the logged hash is over: a child's
        // is its parent's.
        Effect.annotateLogs({ data: resolved.pinned.key.composition }),
        withLogChannel('AgentRun'),
      );

      const snapshot = yield* ledger.latestSnapshot(runId);
      // A resumed tool-use run offers the tools it recorded at open that
      // still resolve, in recorded order, and never one it was not offered.
      // Each recorded tool that no longer resolves (a plugin disabled or
      // removed, a dependency gone) is named in the run's transcript; a call
      // the model still makes to it settles as `tool_unavailable`.
      const recorded =
        snapshot?.payload.family === 'toolUse'
          ? {
              offeredTools: snapshot.payload.state.offeredTools,
              toolsetHash: snapshot.payload.state.toolsetHash,
            }
          : null;
      const toolset = recorded ?? offeredToolset(resolved.definitions);
      let { definitions, registry: tools } = resolved;
      if (recorded !== null) {
        const byName = new Map(definitions.map((d) => [d.name, d]));
        definitions = recorded.offeredTools.flatMap((name) => {
          const definition = byName.get(name);
          return definition ? [definition] : [];
        });
        const kept = new Map(
          definitions.flatMap(({ name }) => {
            const tool = resolved.registry.get(name);
            return tool ? [[name, tool] as const] : [];
          }),
        );
        tools = new MapToolRegistry(kept);
        const warnings = recorded.offeredTools
          .filter((name) => !byName.has(name))
          .map(
            (name) =>
              `Tool "${name}" was offered to this run but is no longer available; the resumed run continues without it.`,
          );
        if (
          warnings.length === 0 &&
          offeredToolset(definitions).toolsetHash !== recorded.toolsetHash
        ) {
          warnings.push(
            'A tool offered to this run changed its input schema since the run opened; the resumed run offers the current schema.',
          );
        }
        // Both the process log and the run's transcript (the trace's `log`
        // row) carry each warning.
        for (const message of warnings) {
          yield* Effect.logWarning(message).pipe(withLogChannel('AgentRun'));
          logger.warn(message);
        }
      }

      // The model of a resumed run is the one its latest snapshot names; a
      // fresh run binds the launch model under the route the launch context
      // resolved for it (including a persisted compatibility key).
      const persisted = snapshot === null ? null : snapshot.payload.runtime;
      const modelId = persisted?.modelId ?? config.model;
      const compatibilityKey =
        persisted !== null
          ? persisted.modelCompatibilityKey
          : ctx.modelCompatibilityKey;
      const modelConfig =
        modelId === config.model ? ctx.modelConfig : MODEL_CONFIGS[modelId];
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
        compatibilityKey,
        ownApiKeyFallback: ctx.ownApiKeyFallback,
        declinedRoutes,
        agentCategory: config.agentCategory,
        temperature: setting.temperature,
      }).pipe(Scope.provide(scope));
      const model = yield* SynchronizedRef.make(bound);
      const pendingModelSwitch: { value: string | null } = { value: null };

      return {
        runId,
        session,
        config,
        setting: { ...setting, tools: definitions },
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
        composition: resolved.pinned,
        toolset,
        finalToolName,
        structured,
        model,
        declinedRoutes,
        scope,
        pendingModelSwitch,
        usageMonitor: ctx.usageMonitor,
        callbacks: input.callbacks,
      };
    }),
  );
