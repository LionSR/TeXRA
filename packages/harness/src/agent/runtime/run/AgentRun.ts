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
import { RunHistory } from '@shared/session/runHistory';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { LanguageModel } from '@platform/languageModel';
import {
  AGENT_SOURCE,
  DeclinableUsageRouteSchema,
  type AgentDelegationScope,
  type DeclinableUsageRoute,
  type OfferedTool,
  type RunId,
  type SubagentProgressUpdate,
} from '@shared/schemas';
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

/** The tool a script's run makes its one call to. */
const SCRIPT_TOOL = 'script';

export interface AgentRunShape {
  readonly runId: RunId;
  readonly session: SessionHandle;
  readonly config: AgentConfig;
  /** The persona the run is, with the tools it declares. */
  readonly persona: Persona;
  /** The document task it runs, or null for a conversation (a task's
   *  persona called by its recipe or chatted with included). */
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
  readonly toolInputs: Omit<
    StepToolInputs,
    'approvalPromptsUnavailable' | 'hostCapabilities'
  >;
  /**
   * The run's current step: the tools it offers and the pin that holds its
   * catalog generation, replaced by each new step. A delegated child reads
   * what its parent's step offered here.
   */
  readonly steps: SynchronizedRef.SynchronizedRef<OpenStep | null>;
  /** The synthetic terminal tool, when the config declares an output schema. */
  readonly finalToolName: string | null;
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
   * Subscription routes this run's launch declined (its own-API-key
   * fallback). Its `run.config` binding records them, and the fold adds
   * every retry the user answered with their own key, so a resume rebinds
   * under the same choice and the user's stored preferences are never
   * rewritten to express it.
   */
  readonly declinedRoutes: readonly DeclinableUsageRoute[];
  /**
   * The run's scope: a parallel-strategy child of the layer's, closed when
   * the run's layer is released. What the run holds for its whole life (its
   * plugins, its step, the binding in force) is a child of it, so they close
   * together rather than one after another.
   */
  readonly scope: Scope.Scope;
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
 * Build the run's service from its launch context. A resumed run is on its
 * newest `run.config`'s model and backend, never a file's; a fresh run binds
 * the launch's model under the route the launch context already resolved.
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
      // validates the call, and its settled result is the run's structured
      // output (`RunState.structured`).
      const outputSchema = config.outputSchema ?? undefined;
      const terminalTool = outputSchema
        ? buildTerminalTool(outputSchema)
        : undefined;
      const finalToolName = terminalTool?.definition.name ?? null;
      // A script's run offers its script and exactly the tools its launch
      // names (a background script's parent's, a document task's recipe's).
      const script = config.script ?? null;
      // A plugin agent that names no tools inherits them, as a Claude Code
      // subagent does: a child every tool its parent's step offered (the
      // narrow-only rule then keeps exactly those), a top-level run the
      // standard file, shell and web tools and the installed plugins' tools.
      const inherits =
        config.agentSource === AGENT_SOURCE.PLUGIN &&
        script === null &&
        persona.tools.length === 0;
      // A persona that declares no tools writes text only: the injected
      // tools stay out, and its turns get the model's whole output budget.
      const textOnly =
        script === null && !inherits && persona.tools.length === 0;
      const parentOffered = ctx.toolPolicy.parentOffered;
      // A script run offers its script; an inheriting plugin agent what its
      // parent was offered (or the defaults); anyone else its persona's.
      let tools = persona.tools;
      if (script !== null)
        tools = [SCRIPT_TOOL, ...script.tools].map((name) => ({ name }));
      else if (inherits)
        tools = (
          parentOffered
            ?.filter(({ plugin }) => plugin !== 'run')
            .map(({ name }) => name) ?? PLUGIN_AGENT_DEFAULT_TOOLS
        ).map((name) => ({ name }));
      // The loaded plugins (MCP servers) the declared tools name, held for
      // the run's life; the read's problems reach its transcript.
      const declared = declaredToolNames(tools);
      const held = yield* (yield* LiveTools)
        .hold(declared)
        .pipe(Scope.provide(scope));
      for (const warning of held.warnings) logger.warn(warning);
      const toolInputs: AgentRunShape['toolInputs'] = {
        tools,
        host: session.roots.host,
        runTools: terminalTool
          ? [...(input.tools ?? []), terminalTool]
          : (input.tools ?? []),
        // A script's run and a text-only persona inject none. A plugin
        // agent that names its tools gets only those.
        injectTools:
          script === null &&
          !textOnly &&
          (config.agentSource !== AGENT_SOURCE.PLUGIN || inherits),
        // The installed plugins' tools reach a top-level run of any agent but
        // a plugin agent that names its tools; a child gets what it declares,
        // narrowed to its parent's.
        injectInstalled:
          script === null &&
          !textOnly &&
          parentOffered === undefined &&
          (config.agentSource !== AGENT_SOURCE.PLUGIN || inherits),
        stores: ctx.stores,
        workspaceRoot: session.roots.workspace,
        parentOffered,
        held,
      };
      // A resumed run rebinds what its rows fold to (its model is its
      // newest config's); a fresh run binds the launch model under today's
      // default route.
      const folded = yield* runHistory.load(runId);
      const backend = folded?.backend ?? undefined;
      const persisted = backend === undefined ? null : folded;
      const modelId = config.model;
      const modelConfig = ctx.modelConfig;
      // The routes this run declines: a resumed run replays the set its rows
      // record, a fresh own-API-key fallback declines every
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
        backend,
        ownApiKeyFallback: ctx.ownApiKeyFallback,
        declinedRoutes,
        textOnly,
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
        model,
        swapModel,
        declinedRoutes,
        scope,
        callbacks: input.callbacks,
      };
    }),
  );
