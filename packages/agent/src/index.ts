// Local imports - types
import type { AgentEvent } from '@agent/trace';
import type { AgentRunHandle as RuntimeAgentRunHandle } from '@agent/runtime/ExecutionHandle';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { HostInteractions as RuntimeHostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { ITool } from '@agent/core/tools/ToolTypes';

// Local imports - runtime
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { loadAgents, resolveAgent } from '@agent/index/agentRegistry';
import { SessionHandle as RuntimeSessionHandle } from '@agent/runtime/SessionHandle';
import { runAgent as runValidatedAgent } from '@agent/runtime/runAgent';
import type { Platform } from '@platform/platform';
import { StreamLogStore } from '@transcript/StreamLogStore';
import {
  PACKAGE_RUNTIME_INITIALIZER,
  type PackageRuntimePlatform,
} from './runtimeInitializer.js';

export type { AgentEvent } from '@agent/trace';
export type { ITool, IToolRegistry } from '@agent/core/tools/ToolTypes';
export { MapToolRegistry } from '@agent/core/tools/ToolTypes';
export { defineTool } from '@tools/core/define';
export type { DefinedToolClass } from '@tools/core/define';
export type {
  AgentFlowResult,
  ToolUseFlowResult,
  WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';

/** Select pending host interactions to cancel. */
export interface HostInteractionCancelSelector {
  readonly streamId?: string | null;
  readonly kind?:
    | 'toolEdit'
    | 'bash'
    | 'plan'
    | 'proposal'
    | 'retry'
    | 'userQuestion'
    | 'externalInquiry';
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

/** A running agent's event stream and eventual terminal result. */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  readonly result: Promise<AgentFlowResult>;
  interrupt(): void;
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
  private failed = false;
  private failure: unknown;
  private interruptPending = false;
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
    if (this.interruptPending) handle.interrupt();
  }

  attachEvents(session: SessionHandle, streamId: string): void {
    this.detachEvents = session.events.subscribe(
      (event) => {
        if (event.scope === 'run') this.push(event.event);
      },
      { scope: 'run', streamId },
    );
  }

  interrupt(): void {
    if (this.liveHandle) {
      this.liveHandle.interrupt();
    } else {
      this.interruptPending = true;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: () => {
        const event = this.events.shift();
        if (event) return Promise.resolve({ done: false, value: event });
        if (this.failed) return Promise.reject(this.failure);
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve, reject) =>
          this.readers.push({ resolve, reject }),
        );
      },
    };
  }

  private push(event: AgentEvent): void {
    const reader = this.readers.shift();
    if (reader) {
      reader.resolve({ done: false, value: event });
    } else {
      this.events.push(event);
    }
  }

  private end(failure?: { readonly error: unknown }): void {
    this.ended = true;
    this.failed = failure !== undefined;
    this.failure = failure?.error;
    this.detachEvents?.();
    this.detachEvents = undefined;
    for (const reader of this.readers.splice(0)) {
      if (this.failed) reader.reject(this.failure);
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
    const { initPlatform, tryPlatform } = await import('@platform/platform');
    const activePlatform = tryPlatform();
    if (activePlatform && activePlatform !== input.platform) {
      throw new Error(
        'The agent package is already using another platform in this process.',
      );
    }
    if (!activePlatform) initPlatform(input.platform);
    const packagePlatform = input.platform as PackageRuntimePlatform;
    packagePlatform[PACKAGE_RUNTIME_INITIALIZER]?.();

    const session = new RuntimeSessionHandle({
      transcripts: StreamLogStore.ephemeral('npm package consumer'),
    });
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
      const config = AgentConfigSchema.parse({
        agent: resolved.resolvedName,
        agentCategory: resolved.entry.category,
        agentSource: resolved.entry.source,
        instruction: input.instruction,
        ...(input.model ? { model: input.model } : {}),
      });
      return await runValidatedAgent(
        { config },
        {
          approvalPromptsUnavailable: true,
          onRun: (handle) => stream.attachHandle(handle),
          onStreamResolved: (streamId) =>
            stream.attachEvents(session, streamId),
          session,
          stopAfterCycle: true,
          tools: input.tools,
        },
      );
    } finally {
      detachInteractions();
      session.dispose();
    }
  });
}
