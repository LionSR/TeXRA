// Third-party imports
import { Effect, Stream, SubscriptionRef } from 'effect';

// Local imports - agent runtime
//
// Values, and types used only inside function bodies, come through the curated
// `@agent/runtime` barrel rather than by module path, so this package stops
// pinning the runtime's internal file layout — the same fold-in the three hosts
// took in #10011. These never reach the emitted declarations, so they carry no
// provider-type leak risk.
import type { AgentEvent, AgentTrace } from '@agent/trace';
import { loadAgents, resolveAgent } from '@agent/index';
import {
  processOwnerId,
  runAgent as runValidatedAgent,
  SessionHandle as RuntimeSessionHandle,
  type AgentRunHandle as RuntimeAgentRunHandle,
  type HostInteractions as RuntimeHostInteractions,
} from '@agent/runtime';
import type { ITool } from '@agent/core/tools/ToolTypes';

// `AgentFlowResult` is deliberately sourced from its own module rather than
// from the `@agent/runtime` barrel above. It appears in this package's PUBLIC
// declarations (`AgentRun.result`, and the re-export below), and declaration
// emit follows whichever module a public type comes from: taking it from the
// barrel pulls the barrel's whole `.d.ts` graph — model handlers included —
// into the published type surface, which trips the provider-type leak check in
// `scripts/validate-artifacts.mjs` (`@anthropic-ai/sdk`).
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';

// Local imports - config and host services
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { createLog } from '@logger/logUtils';
import { initPlatform, tryPlatform, type Platform } from '@platform/platform';
import {
  initProcessWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import { SHUTDOWN_PHASE } from '@platform/interfaces';
import { initNodeAgentRuntime } from '@platform/defaults/nodeAgentRuntime';
import type { ProgressPermissionKind as PendingInteractionKind } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import {
  claudeAgentSessionsFor,
  codexThreadsFor,
} from '@tools/agentCliSessionStores';
import { StreamLogStore } from '@transcript/StreamLogStore';

export type { AgentEvent } from '@agent/trace';
export type {
  ITool,
  IToolRegistry,
  ToolHost,
} from '@agent/core/tools/ToolTypes';
export { MapToolRegistry } from '@agent/core/tools/ToolTypes';
export { defineTool } from '@tools/core/define';
export type { DefinedToolClass } from '@tools/core/define';
export type { ProgressPermissionKind as PendingInteractionKind } from '@shared/schemas';
export type {
  AgentFlowResult,
  ToolUseFlowResult,
  WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
export type {
  SessionView,
  StreamView,
  TranscriptView,
} from '@shared/session/sessionView';

/** Select pending host interactions to cancel. */
export interface HostInteractionCancelSelector {
  readonly streamId?: string | null;
  readonly kind?: PendingInteractionKind;
  readonly cause?: string;
}

/**
 * Minimum interaction contract for an unattached package run.
 *
 * Interactive approval methods will be added here when they acquire a stable
 * package-level contract. Until then, approval-requiring tools are withheld.
 */
export interface HostInteractions {
  cancel(selector?: HostInteractionCancelSelector): void;
}

/**
 * The process platform together with the workspace roots the package's runs
 * work in. `nodePlatform()` builds both; an embedder supplying its own
 * platform names its workspace roots beside it.
 */
export interface AgentPlatform extends Platform {
  readonly roots: WorkspaceRoots;
}

/** Input accepted by the public package-level run function. */
export interface RunAgentInput {
  readonly platform: AgentPlatform;
  readonly agent: string;
  readonly instruction: string;
  readonly interactions: HostInteractions;
  readonly model?: string;
  readonly tools?: readonly ITool[];
}

/**
 * A running agent's single-consumer event stream and eventual terminal result.
 *
 * Event delivery begins with the iterator's first `next()` call. Awaiting only
 * `result` does not retain trace events, and ending iteration detaches the
 * event source while the run itself continues.
 */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly result: Promise<AgentFlowResult>;
  /**
   * The session view the run folds into (PRD one-fold-three-renderers,
   * 10.3): the same state every TeXRA host renders, so an embedder reads
   * stream status, transcript rows, and approvals from here instead of
   * re-folding the trace. Each iteration yields the current view first, then
   * every later level, and ends when the run settles or the consumer breaks.
   */
  readonly view: AsyncIterable<SessionView>;
  interrupt(): void;
}

/** The process-wide setup every run shares, done once: the node runtime
 *  features and the Effect runtime the package session's graph runs on. */
let runtimeInitialized: Promise<void> | undefined;
const logger = createLog('agentPackage');

function releaseOrWarn(message: string, release: () => void): void {
  try {
    release();
  } catch (error) {
    logger.warn(message, { data: error });
  }
}

class AgentRunStream implements AgentRun {
  private readonly events: AgentEvent[] = [];
  private readonly readers: Array<{
    readonly resolve: (result: IteratorResult<AgentEvent>) => void;
    readonly reject: (reason?: unknown) => void;
  }> = [];
  private liveHandle: RuntimeAgentRunHandle | undefined;
  private detachEvents: (() => void) | undefined;
  private ended = false;
  private iteratorClosed = false;
  private iteratorStarted = false;
  private failure: { readonly error: unknown } | undefined;
  private readonly launchAbortController = new AbortController();
  private attachSession: (session: RuntimeSessionHandle) => void = () => {};
  readonly launchSignal = this.launchAbortController.signal;
  readonly result: Promise<AgentFlowResult>;
  readonly view: AsyncIterable<SessionView>;

  constructor(start: (stream: AgentRunStream) => Promise<AgentFlowResult>) {
    const session = new Promise<RuntimeSessionHandle>((resolve) => {
      this.attachSession = resolve;
    });
    this.result = start(this);
    void this.result.then(
      () => this.end(),
      (error: unknown) => this.end({ error }),
    );
    // The session's view level, read through Effect's own async-iterable
    // destructor: `SubscriptionRef.changes` replays the current view on
    // subscribe, so no level is missed, and `interruptWhen` ends the
    // iteration once the run has settled (also when it settled before the
    // session existed). Breaking the loop closes the stream's scope.
    const settled = this.result.then(
      () => undefined,
      () => undefined,
    );
    this.view = Stream.toAsyncIterable(
      Stream.unwrap(
        Effect.map(
          Effect.promise(() => session),
          (live) => SubscriptionRef.changes(live.view),
        ),
      ).pipe(Stream.interruptWhen(Effect.promise(() => settled))),
    );
  }

  /**
   * The run's own trace is the event source: every trace event of the run,
   * durable or not, in emission order. The launcher hands the trace over
   * with the resolved stream, before the run's first trace event (the
   * instruction log, the root stage, the launch warnings), so an iteration
   * begun right after `runAgent()` misses none of them.
   */
  attachTrace(trace: AgentTrace): void {
    this.detachEvents = trace.subscribe((event) => {
      if (this.iteratorStarted) this.push(event);
    });
  }

  /** The live handle once the run is tracked: what `interrupt()` targets. */
  attachHandle(handle: RuntimeAgentRunHandle): void {
    this.liveHandle = handle;
  }

  /** The run's session once it exists: what `view` reads. */
  attachView(session: RuntimeSessionHandle): void {
    this.attachSession(session);
  }

  interrupt(): void {
    if (this.liveHandle) {
      this.liveHandle.interrupt();
    } else {
      this.launchAbortController.abort();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        this.iteratorStarted = true;
        if (this.iteratorClosed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        const event = this.events.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.failure) return Promise.reject(this.failure.error);
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) =>
          this.readers.push({ resolve, reject }),
        );
      },
      return: () => {
        this.closeIterator();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private push(event: AgentEvent): void {
    if (this.iteratorClosed) return;
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ done: false, value: event });
    } else {
      this.events.push(event);
    }
  }

  private detach(): void {
    this.detachEvents?.();
    this.detachEvents = undefined;
  }

  private closeIterator(): void {
    this.iteratorClosed = true;
    this.events.splice(0);
    this.detach();
    for (const reader of this.readers.splice(0)) {
      reader.resolve({ done: true, value: undefined });
    }
  }

  private end(failure?: { readonly error: unknown }): void {
    this.ended = true;
    this.failure = failure;
    this.detach();
    for (const reader of this.readers.splice(0)) {
      if (failure) reader.reject(failure.error);
      else reader.resolve({ done: true, value: undefined });
    }
  }
}

/**
 * Start one agent run and expose its trace as an asynchronous event stream.
 *
 * The platform and agent registry are process-wide. Applications should create
 * one platform, then reuse it for every run in that process.
 */
export function runAgent(input: RunAgentInput): AgentRun {
  return new AgentRunStream(async (stream) => {
    const approvalToolNames =
      input.tools
        ?.filter((tool) => tool.requiresApproval)
        .map((tool) => tool.definition.name) ?? [];
    if (approvalToolNames.length > 0) {
      throw new Error(
        `The agent package cannot run approval-requiring tools: ${approvalToolNames.join(', ')}`,
      );
    }

    const activePlatform = tryPlatform();
    if (activePlatform && activePlatform !== input.platform) {
      throw new Error(
        'The agent package is already using another platform in this process.',
      );
    }
    if (!activePlatform) {
      initPlatform(input.platform);
      initProcessWorkspaceRoots(input.platform.roots);
    }
    runtimeInitialized ??= (async () => {
      initNodeAgentRuntime(input.platform.lifecycle);
      // The one Effect runtime of the embedding process (PRD 7.7), for the
      // package session's graph; disposed on the embedder's shutdown path
      // after the runtime's own execution settlement.
      const runtime = installProcessRuntime(
        processOwnerId(await input.platform.processes.selfIdentity()),
      );
      input.platform.lifecycle.onShutdown(SHUTDOWN_PHASE.ON, () =>
        runtime.dispose(),
      );
    })();
    await runtimeInitialized;

    const session = new RuntimeSessionHandle({
      transcripts: StreamLogStore.ephemeral('npm package consumer'),
    });
    stream.attachView(session);
    const interactions: RuntimeHostInteractions = {
      cancel: (selector) => input.interactions.cancel(selector),
      requestRetry: async () => ({
        action: 'deny',
        reason: 'Interactive retries are unavailable in the agent package.',
      }),
    };
    const detachInteractions = session.interactions.use(interactions);
    try {
      await loadAgents({ includeRemote: false });
      const resolved = resolveAgent(input.agent);
      if (!resolved) {
        throw new Error(
          `Agent "${input.agent}" was not found in the configured agent directory.`,
        );
      }
      if (
        input.tools &&
        input.tools.length > 0 &&
        resolved.entry.category !== AgentCategory.ToolUse
      ) {
        throw new Error(
          `Custom tools are supported only for tool-use agents; "${input.agent}" is a workflow agent.`,
        );
      }
      const config = AgentConfigSchema.parse({
        agent: resolved.entry.name,
        agentCategory: resolved.entry.category,
        agentSource: resolved.entry.source,
        instruction: input.instruction,
        ...(input.model ? { model: input.model } : {}),
      });
      return await runValidatedAgent(
        { kind: 'fresh', config },
        {
          approvalPromptsUnavailable: true,
          launchSignal: stream.launchSignal,
          onRun: (handle) => stream.attachHandle(handle),
          onStreamResolved: (_streamId, trace) => stream.attachTrace(trace),
          session,
          stopAfterCycle: true,
          tools: input.tools,
        },
      );
    } finally {
      releaseOrWarn(
        'Failed to detach package host interactions',
        detachInteractions,
      );
      // The hosts kill agent-spawned children from their own shutdown
      // handlers, which no embedder of this package ever runs. The package
      // session dies with the run, so its children have nothing left to
      // outlive and are stopped here instead.
      releaseOrWarn('Failed to stop package background processes', () =>
        session.executions.killBackgroundProcesses(),
      );
      releaseOrWarn('Failed to interrupt package Codex threads', () =>
        codexThreadsFor(session).interruptAll(),
      );
      releaseOrWarn('Failed to interrupt package Claude agent sessions', () =>
        claudeAgentSessionsFor(session).interruptAll(),
      );
      releaseOrWarn('Failed to dispose package session', () =>
        session.dispose(),
      );
    }
  });
}
