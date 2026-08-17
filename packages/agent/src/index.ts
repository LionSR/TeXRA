// Local imports - agent runtime
//
// Values, and types used only inside function bodies, come through the curated
// `@agent/runtime` barrel rather than by module path, so this package stops
// pinning the runtime's internal file layout — the same fold-in the three hosts
// took in #10011. These never reach the emitted declarations, so they carry no
// provider-type leak risk.
import type { AgentEvent } from '@agent/trace';
import { loadAgents, resolveAgent } from '@agent/index';
import {
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
import { createLog } from '@logger/logUtils';
import { initPlatform, tryPlatform, type Platform } from '@platform/platform';
import { initNodeAgentRuntime } from '@platform/defaults/nodeHost';
import type { ProgressPermissionKind as PendingInteractionKind } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import {
  ClaudeAgentSessions,
  CodexThreads,
} from '@tools/agentCliSessionStores';
import { StreamLogStore } from '@transcript/StreamLogStore';

export type { AgentEvent } from '@agent/trace';
export type {
  ITool,
  IToolRegistry,
  ToolHost,
  ToolHostExclusion,
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

/** Input accepted by the public package-level run function. */
export interface RunAgentInput {
  readonly platform: Platform;
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
  interrupt(): void;
}

let runtimeInitialized = false;
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
  private streamId: string | undefined;
  private ended = false;
  private iteratorClosed = false;
  private iteratorStarted = false;
  private failure: { readonly error: unknown } | undefined;
  private readonly launchAbortController = new AbortController();
  readonly result: Promise<AgentFlowResult>;

  constructor(start: (stream: AgentRunStream) => Promise<AgentFlowResult>) {
    this.result = start(this);
    void this.result.then(
      () => this.end(),
      (error: unknown) => this.end({ error }),
    );
  }

  attachHandle(handle: RuntimeAgentRunHandle): void {
    this.liveHandle = handle;
  }

  get launchSignal(): AbortSignal {
    return this.launchAbortController.signal;
  }

  attachEvents(session: RuntimeSessionHandle): void {
    this.detachEvents = session.events.subscribe(
      (event) => {
        if (
          event.scope === 'run' &&
          event.streamId === this.streamId &&
          this.iteratorStarted
        ) {
          this.push(event.event);
        }
      },
      { scope: 'run' },
    );
  }

  selectStream(streamId: string): void {
    this.streamId = streamId;
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
        ?.filter((tool) => tool.requiresApproval === true)
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
    if (!activePlatform) initPlatform(input.platform);
    if (!runtimeInitialized) {
      initNodeAgentRuntime(input.platform.lifecycle);
      runtimeInitialized = true;
    }

    const session = new RuntimeSessionHandle({
      transcripts: StreamLogStore.ephemeral('npm package consumer'),
    });
    stream.attachEvents(session);
    const interactions: RuntimeHostInteractions = {
      cancel: (selector) => input.interactions.cancel(selector),
      requestRetry: async () => ({
        action: 'deny',
        reason: 'Interactive retries are unavailable in the agent package.',
      }),
    };
    const detachInteractions = session.useHostInteractions(interactions);
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
          onStreamResolved: (streamId) => stream.selectStream(streamId),
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
        CodexThreads.interruptAll(session.executions),
      );
      releaseOrWarn('Failed to interrupt package Claude agent sessions', () =>
        ClaudeAgentSessions.interruptAll(session.executions),
      );
      releaseOrWarn('Failed to dispose package session', () =>
        session.dispose(),
      );
    }
  });
}
