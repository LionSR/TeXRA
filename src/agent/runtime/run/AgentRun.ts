/**
 * The per-run service: everything one run owns, provided once at the
 * `executeAgent` boundary for the run's lifetime (injection step 6, Q3). Run
 * identity and the parent edge, the launch configuration, the resolved tool
 * registry, the trace emitter, the owning session's interaction and retry
 * ports, and the bound llm `Model` in a synchronized cell a mid-run switch
 * replaces. Nothing here is threaded through node fields or a services bag;
 * the loop and the invoker take it from context.
 */
import { Context, Effect, Exit, Layer, Scope, SynchronizedRef } from 'effect';

import { selectModel } from '@texra-ai/llm';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type {
  DocumentTask,
  Persona,
} from '@agent/core/definition/AgentDataclass';
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { PLUGIN_AGENT_DEFAULT_TOOLS } from '@agent/index/pluginAgents';
import type { AgentTrace, StageHandle } from '@agent/trace';
import {
  declaredToolNames,
  type StepToolInputs,
} from '@agent/runtime/agentToolResolution';
import type { TemplateOpening } from '@agent/prompt/templateInputs';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import {
  AGENT_SOURCE,
  AgentCategory,
  DeclinableUsageRouteSchema,
  type AgentDelegationScope,
  type DeclinableUsageRoute,
  type JsonValue,
  type OfferedTool,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
import { RunHistory } from '@shared/session/runHistory';
import { LiveTools } from '@tools/liveTools';
import { buildTerminalTool } from '@tools/structuredOutput';
import { RunFileService } from '@utils/files/runStorage';

import { bindModel, type BoundModel } from './modelBinding';
import type { OpenStep } from '../loop/step';
import type { HttpClient } from 'effect/http';
import type { AgentLaunchContext } from '../AgentLaunchContext';
import type { SessionHandle } from '../SessionHandle';

/**
 * Immutable per-run tool policy, resolved by the launch and read from the
 * run's `AgentRun` service.
 *
 * A frozen value the loop takes from context, with no ambient frame anywhere
 * beneath it — the property an SDK embedder wants.
 */
export interface ToolPolicy {
  /** The host cannot answer an approval prompt: the gates deny what they
   *  would present. Which tools a step offers reads the session live. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Stop a tool-use run after one model/tool cycle instead of waiting. */
  readonly stopAfterCycle?: boolean;
  /** What the parent's step offered when it launched this delegated child:
   *  the child can only narrow it. */
  readonly parentOffered?: readonly OfferedTool[];
}

interface RunCallbacks {
  /** Fires on meaningful progress: plan changes, tool call milestones. */
  readonly onProgress?: (update: SubagentProgressUpdate) => void;
  /** An idle turn boundary, after child delivery. */
  readonly onIdle?: () => void;
}

export interface AgentRunShape {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly config: AgentConfig;
  /** The persona the run is, with the tools it declares. */
  readonly persona: Persona;
  /** The document task it runs, or null for a conversation. */
  readonly task: DocumentTask | null;
  readonly logger: AgentTrace;
  readonly parentStage: StageHandle;
  readonly toolPolicy: ToolPolicy;
  readonly workingDirectory?: string;
  readonly delegationAgentScope?: AgentDelegationScope | null;
  /** The process stores the launch read; every route and credential read
   *  below the loop takes them from here. */
  readonly stores: ModelOptionStores;
  /** What the run opens from; null for a tool-use run whose rows hold its
   *  opening, which a resume never renders again. */
  readonly opening: TemplateOpening | null;
  /** Initial user row to log after the loop has inserted launch media. */
  readonly initialUserMessageForTranscript: string | undefined;
  readonly fileService: RunFileService;
  /** What each step resolves its tools from (`loop/step.ts`). */
  readonly toolInputs: Omit<StepToolInputs, 'approvalPromptsUnavailable'>;
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
  /** The run's live model binding; replaced only through `swapModel`. */
  readonly model: SynchronizedRef.SynchronizedRef<BoundModel>;
  /**
   * Replace the binding: `next` binds into a scope of its own, forked from
   * the run's, and the binding it returns goes into force; the retired
   * binding's scope closes at once, releasing its socket, ping fiber and
   * uploads. `next` returning the binding it was handed keeps it, and a
   * failure or interruption closes the fork and leaves the binding as it
   * was. The one writer of `model`: a switch, a manual retry's rebind and a
   * reacquired connection all come through here.
   */
  readonly swapModel: <E, R>(
    next: (current: BoundModel) => Effect.Effect<BoundModel, E, R>,
  ) => Effect.Effect<BoundModel, E, Exclude<R, Scope.Scope>>;
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
   * the run's layer is released. What the run holds for its whole life (its
   * plugins, its step, the binding in force) is a child of it, so they close
   * together rather than one after another.
   */
  readonly scope: Scope.Scope;
  /**
   * A switch the host admitted (the registry name of the next model),
   * applied by the loop at its next model boundary so the run history rows that
   * record it are appended by the one fiber that holds the run's state. A
   * plain slot: the host's request is synchronous.
   */
  readonly pendingModelSwitch: { value: string | null };
  readonly callbacks: RunCallbacks;
}

export class AgentRun extends Context.Service<AgentRun, AgentRunShape>()(
  '@texra/agent/AgentRun',
) {}

interface AgentRunLayerInput {
  /** Caller-supplied tools available only to this run. */
  readonly tools?: readonly ITool[];
  readonly callbacks: RunCallbacks;
}

/**
 * Build the run's service from its launch context. The model identity of a
 * resumed run comes from the latest `run.snapshot` (the one indexed read
 * L0 provided), never from a file; a fresh run binds the launch's model
 * under the route the launch context already resolved.
 */
export const agentRunLayer = (
  ctx: AgentLaunchContext,
  input: AgentRunLayerInput,
): Layer.Layer<
  AgentRun,
  Error,
  RunHistory | LanguageModel | HttpClient.HttpClient | LiveTools
> =>
  Layer.effect(
    AgentRun,
    Effect.gen(function* () {
      const { runId, session } = ctx;
      const { logger, config } = ctx;
      const runHistory = yield* RunHistory;
      const layerScope = yield* Effect.scope;
      // One parallel child holds what the run holds for its life; at close
      // each release runs concurrently under its own deadline.
      const scope = yield* Scope.fork(layerScope, 'parallel');

      const { persona, task } = ctx;

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
      const workflow = task !== null;
      // A plugin agent that names no tools inherits them, as a Claude Code
      // subagent does: a child every tool its parent's step offered (the
      // narrow-only rule then keeps exactly those), a top-level run the
      // standard file, shell and web tools and the installed plugins' tools.
      const inherits =
        config.agentSource === AGENT_SOURCE.PLUGIN &&
        !workflow &&
        persona.tools.length === 0;
      const parentOffered = ctx.toolPolicy.parentOffered;
      const tools = inherits
        ? (
            parentOffered
              ?.filter(({ plugin }) => plugin !== 'run')
              .map(({ name }) => name) ?? PLUGIN_AGENT_DEFAULT_TOOLS
          ).map((name) => ({ name }))
        : persona.tools;
      const declared = declaredToolNames(tools);
      const held = yield* (yield* LiveTools)
        .hold(workflow ? [] : declared)
        .pipe(Scope.provide(scope));
      for (const warning of held.warnings) logger.warn(warning);
      const toolInputs: AgentRunShape['toolInputs'] = {
        tools,
        host: session.roots.host,
        runTools: terminalTool
          ? [...(input.tools ?? []), terminalTool]
          : (input.tools ?? []),
        // A workflow run injects none: memory and plan are tool-use
        // infrastructure.
        // A plugin agent that names its tools gets only those.
        injectTools:
          !workflow && (config.agentSource !== AGENT_SOURCE.PLUGIN || inherits),
        // The installed plugins' tools reach a top-level run of any agent but
        // a plugin agent that names its tools; a child gets what it declares,
        // narrowed to its parent's. A background script's run is its
        // parent's agent with its parent's tools, installed ones included.
        injectInstalled:
          !workflow &&
          (parentOffered === undefined ||
            (config.agentCategory === AgentCategory.ToolUse &&
              config.backgroundScript != null)) &&
          (config.agentSource !== AGENT_SOURCE.PLUGIN || inherits),
        stores: ctx.stores,
        workspaceRoot: session.roots.workspace,
        parentOffered,
        held,
      };
      const snapshot = yield* runHistory.latestSnapshot(runId);
      // The model and route of a resumed run are the ones its latest snapshot
      // names; a fresh run binds the launch model under today's default route.
      const persisted = snapshot === null ? null : snapshot.payload.runtime;
      const modelId = persisted?.modelId ?? config.model;
      const compatibilityKey = persisted?.modelCompatibilityKey ?? null;
      const selected = selectModel(modelId);
      const modelConfig =
        modelId === config.model ? ctx.modelConfig : selected?.config;
      if (!modelConfig) {
        return yield* Effect.fail(
          new Error(`Model ${modelId} is not registered`),
        );
      }
      // The routes this run declines: a resumed run replays the set its
      // snapshot recorded, a fresh own-API-key fallback declines every
      // subscription route from its first binding (the user answered a quota
      // prompt by choosing to pay with their own key). Nothing here reads or
      // writes the user's stored preferences.
      const declinedRoutes: readonly DeclinableUsageRoute[] =
        persisted?.declinedRoutes ??
        (ctx.ownApiKeyFallback ? DeclinableUsageRouteSchema.options : []);
      // Each binding owns a scope forked from the run's; only the one in
      // force is open. `bindingScope` is written only inside the ref's
      // update, which serializes every swap.
      let bindingScope = yield* Scope.fork(scope);
      const bound = yield* bindModel({
        modelId,
        config: modelConfig,
        stores: ctx.stores,
        compatibilityKey,
        ownApiKeyFallback: ctx.ownApiKeyFallback,
        declinedRoutes,
        agentCategory: config.agentCategory,
        temperature: persona.temperature,
      }).pipe(Scope.provide(bindingScope));
      const model = yield* SynchronizedRef.make(bound);
      const swapModel: AgentRunShape['swapModel'] = (next) =>
        SynchronizedRef.updateAndGetEffect(model, (current) =>
          Effect.gen(function* () {
            const fork = yield* Scope.fork(scope);
            const replacement = yield* next(current).pipe(
              Scope.provide(fork),
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) && exit.value !== current
                  ? Effect.void
                  : Scope.close(fork, Exit.void),
              ),
            );
            if (replacement === current) return current;
            const retired = bindingScope;
            bindingScope = fork;
            yield* Scope.close(retired, Exit.void);
            return replacement;
          }),
        );
      const pendingModelSwitch: { value: string | null } = { value: null };

      return {
        runId,
        session,
        config,
        persona,
        task,
        logger,
        parentStage: ctx.parentStage,
        toolPolicy: ctx.toolPolicy,
        workingDirectory: ctx.workingDirectory,
        delegationAgentScope: ctx.delegationAgentScope,
        stores: ctx.stores,
        opening: ctx.opening,
        initialUserMessageForTranscript: ctx.initialUserMessageForTranscript,
        fileService: new RunFileService(runId, session.roots),
        toolInputs,
        steps: yield* SynchronizedRef.make<OpenStep | null>(null),
        finalToolName,
        structured,
        model,
        swapModel,
        declinedRoutes,
        scope,
        pendingModelSwitch,
        callbacks: input.callbacks,
      };
    }),
  );
