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
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { PLUGIN_AGENT_DEFAULT_TOOLS } from '@agent/index/pluginAgents';
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  declaredToolNames,
  type StepToolInputs,
} from '@agent/runtime/agentToolResolution';
import type { UsageMonitor } from '@agent/runtime/UsageMonitor';
import type { InstalledPluginLoad } from '@common/plugins/pluginTrust';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import {
  AGENT_SOURCE,
  AgentCategory,
  MESSAGE_TYPES,
  DeclinableUsageRouteSchema,
  type AgentDelegationScope,
  type DeclinableUsageRoute,
  type JsonValue,
  type OfferedTool,
  type RunId,
  type SubagentProgressUpdate,
  type UserVariableChannels,
} from '@shared/schemas';
import type { ApprovalPolicyDenial } from '@shared/approvalPolicy';
import { RunLedger } from '@shared/session/runLedger';
import { LiveTools } from '@tools/liveTools';
import { buildTerminalTool } from '@tools/structuredOutput';
import { processHost } from '@utils/config/platformSettings';
import { RunFileService } from '@utils/files/runStorage';

import { bindModel, type BoundModel } from './modelBinding';
import type { OpenStep } from '../loop/step';
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
  /** What the parent's step offered when it launched this delegated child:
   *  the child can only narrow it. */
  readonly parentOffered?: readonly OfferedTool[];
}

interface RunCallbacks {
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** An idle turn boundary, after child delivery. */
  readonly onIdle?: () => void;
}

export interface AgentRunShape {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly config: AgentConfig;
  /** The setting, with the tools the agent declares. */
  readonly setting: AgentSetting;
  readonly prompt: AgentPrompt;
  readonly logger: AgentTrace;
  readonly parentStage: StageHandle;
  readonly toolPolicy: ToolPolicy;
  readonly workingDirectory?: string;
  readonly delegationAgentScope?: AgentDelegationScope | null;
  /**
   * Record that this run met an approval-policy denial: a request settled as
   * denied, or approval-gated tools were withheld from the model when the
   * run resolved its tools.
   */
  readonly onApprovalPolicyDenial?: (denial: ApprovalPolicyDenial) => void;
  /** The process stores the launch read; every route and credential read
   *  below the loop takes them from here. */
  readonly stores: ModelOptionStores;
  readonly userVarChannels: UserVariableChannels;
  /** Initial user row to log after the loop has inserted launch media. */
  readonly initialUserMessageForTranscript: string | undefined;
  readonly fileService: RunFileService;
  /** What each step resolves its tools from (`loop/step.ts`). */
  readonly toolInputs: StepToolInputs;
  /**
   * The installed plugins that load, as the launch read them, once: the
   * agent's own check, the skill catalog and the activation's first step
   * share that one read. Every later step reads them again.
   */
  readonly installed: Effect.Effect<InstalledPluginLoad>;
  /**
   * The run's current step: the tools it offers and the pin that holds its
   * catalog generation, replaced by each new step. A delegated child reads
   * what its parent's step offered here.
   */
  readonly steps: SynchronizedRef.SynchronizedRef<OpenStep | null>;
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
  RunLedger | LanguageModel | HttpClient.HttpClient | LiveTools
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
      // The loaded plugins (MCP servers) the declared tools name, held for
      // the run's life; the read's problems reach its transcript. A
      // workflow run's rounds offer no tools, so it holds none.
      const workflow = setting.agentCategory === AgentCategory.Workflow;
      // A plugin agent that names no tools inherits them, as a Claude Code
      // subagent does: a child every tool its parent's step offered (the
      // narrow-only rule then keeps exactly those), a top-level run the
      // standard file, shell and web tools and the installed plugins' tools.
      const inherits =
        config.agentSource === AGENT_SOURCE.PLUGIN &&
        setting.agentCategory === AgentCategory.ToolUse &&
        setting.tools.length === 0;
      const parentOffered = ctx.toolPolicy.parentOffered;
      const tools = inherits
        ? (
            parentOffered
              ?.filter(({ plugin }) => plugin !== 'run')
              .map(({ name }) => name) ?? PLUGIN_AGENT_DEFAULT_TOOLS
          ).map((name) => ({ name }))
        : setting.tools;
      const declared = declaredToolNames(tools);
      const held = yield* (yield* LiveTools)
        .hold(workflow ? [] : declared)
        .pipe(Scope.provide(scope));
      for (const warning of held.warnings) logger.warn(warning);
      const toolInputs: StepToolInputs = {
        tools,
        approvalPromptsUnavailable:
          ctx.toolPolicy.approvalPromptsUnavailable === true,
        host: processHost(),
        runTools: terminalTool
          ? [...(input.tools ?? []), terminalTool]
          : (input.tools ?? []),
        // A workflow run injects none: memory and plan are tool-use
        // infrastructure.
        // A plugin agent that names its tools gets only those.
        injectTools:
          setting.agentCategory === AgentCategory.ToolUse &&
          (config.agentSource !== AGENT_SOURCE.PLUGIN || inherits),
        // The installed plugins' tools reach a top-level run of any agent but
        // a plugin agent that names its tools; a child gets what it declares,
        // narrowed to its parent's.
        injectInstalled:
          setting.agentCategory === AgentCategory.ToolUse &&
          parentOffered === undefined &&
          (config.agentSource !== AGENT_SOURCE.PLUGIN || inherits),
        stores: ctx.stores,
        workspaceRoot: session.roots.workspace,
        delegationScope: ctx.delegationAgentScope ?? undefined,
        parentOffered,
        held,
      };
      const snapshot = yield* ledger.latestSnapshot(runId);
      // A workflow agent's rounds offer no tools: a fresh run says so rather
      // than narrowing its YAML's declared `tools:` silently.
      if (workflow && snapshot === null && declared.length > 0) {
        logger.warn(
          `The workflow family advertises no tools under this release, so the tools this agent declares are not offered to the model: ${declared.join(', ')}. Run the agent in the tool-use family if it needs them.`,
          { messageType: MESSAGE_TYPES.INTERNAL },
        );
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
        setting,
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
        toolInputs,
        installed: ctx.installed,
        steps: yield* SynchronizedRef.make<OpenStep | null>(null),
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
