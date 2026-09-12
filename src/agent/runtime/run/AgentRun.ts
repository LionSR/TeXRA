/**
 * The per-run service: everything one run owns, provided once at the
 * `executeAgent` boundary for the run's lifetime (injection step 6, Q3). Run
 * identity and the parent edge, the launch configuration, the resolved tool
 * registry, the trace emitter, the owning session's interaction and retry
 * ports, and the bound llm `Model` in a synchronized cell a mid-run switch
 * replaces. Nothing here is threaded through node fields or a services bag;
 * the loop and the invoker take it from context.
 */
import { Context, Data, Effect, Layer, SynchronizedRef } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
import type { AgentTrace, StageHandle } from '@agent/trace';
import { activeModelHandlerCompatibilityKey } from '@agent/runtime/ModelFactory';
import { resolveAgentTools } from '@agent/runtime/agentToolResolution';
import type { ToolInjections } from '@agent/runtime/toolInjection';
import type { UsageMonitor } from '@agent/runtime/UsageMonitor';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import {
  AgentCategory,
  type JsonValue,
  type RetryErrorInfo,
  type RunId,
  type RunOutcome,
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
import { TaskRunFileService } from '@utils/files/taskRunStorage';

import { bindModel, type BoundModel } from './modelBinding';
import type { AgentLaunchContext, ToolPolicy } from '../AgentLaunchContext';
import type { SessionHandle } from '../SessionHandle';

/**
 * The loop's typed halt: the run ends without a completed turn. `cancelled`
 * is a stop or a declined retry; `failed` carries the provider error the run
 * reports on its `run.end` row.
 */
export class RunHalted extends Data.TaggedError('RunHalted')<{
  readonly runId: RunId;
  readonly outcome: Extract<RunOutcome, 'cancelled' | 'failed'>;
  readonly error?: RetryErrorInfo;
}> {}

interface RunCallbacks {
  /** Fires on meaningful progress: todo changes, tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** Root-run-only: fires at every turn boundary before the follow-up wait. */
  readonly onIdle?: () => void;
  /** Fires after a queued user batch reached the conversation. */
  readonly onFollowUpConsumed?: () => void;
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
  /** The process stores the launch read; every route and credential read
   *  below the loop takes them from here. */
  readonly stores: ModelOptionStores;
  readonly userVarChannels: UserVariableChannels;
  /** Initial user row to log after the loop has inserted launch media. */
  readonly initialUserMessageForTranscript: string | undefined;
  readonly fileService: TaskRunFileService;
  readonly tools: IToolRegistry;
  /** The synthetic terminal tool, when the config declares an output schema. */
  readonly finalToolName: string | null;
  /** The value the terminal tool captured, read by the loop at its exit. A
   *  plain slot: the tool's capture callback is synchronous. */
  readonly structured: { value: JsonValue | undefined };
  /** The run's live model binding; a mid-run switch replaces it. */
  readonly model: SynchronizedRef.SynchronizedRef<BoundModel>;
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
  /** Abort the run's sticky signal: the host stop that interrupts the loop. */
  readonly interrupt: () => void;
}

export class AgentRun extends Context.Service<AgentRun, AgentRunShape>()(
  '@texra/agent/AgentRun',
) {}

export interface AgentRunLayerInput {
  readonly setting: AgentSetting;
  readonly parentRunId: RunId | null;
  /** Caller-supplied tools available only to this run. */
  readonly tools?: readonly ITool[];
  /** The conditional tool injections this run resolves its tools with. */
  readonly toolInjections: ToolInjections['Service'];
  readonly callbacks: RunCallbacks;
  readonly copilotRouteOverride?: CopilotRouteOverride;
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
): Layer.Layer<AgentRun, Error, RunLedger> =>
  Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const { runId, session } = ctx.runScope;
      const { logger, config } = ctx;
      const ledger = yield* RunLedger;

      const baseRegistry = getDefaultToolRegistry();
      const resolvedTools = yield* Effect.tryPromise({
        try: () =>
          input.inScope(() =>
            resolveAgentTools({
              tools: input.setting.tools,
              registry: baseRegistry,
              logger,
              approvalPromptsUnavailable:
                ctx.toolPolicy.approvalPromptsUnavailable,
              runtimeUnavailableTools: ctx.toolPolicy.runtimeUnavailableTools,
              toolInjections: input.toolInjections,
              stores: ctx.stores,
            }),
          ),
        catch: ensureError,
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
      const launchKey = activeModelHandlerCompatibilityKey(
        ctx.modelCell.handler,
      );
      const persisted = snapshot === null ? null : snapshot.payload.runtime;
      const modelId = persisted?.modelId ?? config.model;
      const compatibilityKey =
        persisted !== null
          ? persisted.modelHandlerCompatibilityKey
          : (launchKey ?? null);
      const modelConfig =
        modelId === config.model
          ? ctx.modelCell.handler.config
          : yield* Effect.tryPromise({
              try: () => resolveRuntimeModelConfig(modelId),
              catch: ensureError,
            });
      if (!modelConfig) {
        return yield* Effect.fail(
          new Error(`Model ${modelId} is not registered`),
        );
      }
      const bound = yield* bindModel({
        config: modelConfig,
        stores: ctx.stores,
        compatibilityKey,
        copilotRouteOverride: input.copilotRouteOverride,
        agentCategory: config.agentCategory,
        temperature: input.setting.temperature,
        inScope: input.inScope,
      });
      const model = yield* SynchronizedRef.make(bound);
      const pendingModelSwitch: { value: string | null } = { value: null };

      return {
        runId,
        parentRunId: input.parentRunId,
        session,
        config,
        setting: { ...input.setting, tools: resolvedTools },
        prompt: ctx.prompt,
        logger,
        parentStage: ctx.parentStage,
        toolPolicy: ctx.toolPolicy,
        stores: ctx.stores,
        userVarChannels: ctx.userVarChannels,
        initialUserMessageForTranscript: ctx.initialUserMessageForTranscript,
        fileService: new TaskRunFileService(runId),
        tools,
        finalToolName,
        structured,
        model,
        pendingModelSwitch,
        usageMonitor: ctx.usageMonitor,
        callbacks: input.callbacks,
        interrupt: ctx.interrupt,
        inScope: input.inScope,
      };
    }),
  );
