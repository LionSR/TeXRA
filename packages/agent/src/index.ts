// Local imports - types
import type { AgentEvent } from '@agent/trace';
import type { AgentRunHandle as RuntimeAgentRunHandle } from '@agent/runtime/ExecutionHandle';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ITool } from '@agent/core/tools/ToolTypes';

// Local imports - runtime
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { loadAgents, resolveAgent } from '@agent/index/agentRegistry';
import {
  defaultSession,
  initializeDefaultSession,
  tryDefaultSession,
} from '@agent/runtime/SessionHandle';
import { runAgent as runValidatedAgent } from '@agent/runtime/runAgent';
import type { Platform } from '@platform/platform';
import { StreamLogStore } from '@transcript/StreamLogStore';

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
  private readonly readers: Array<
    (result: IteratorResult<AgentEvent>) => void
  > = [];
  private liveHandle: RuntimeAgentRunHandle | undefined;
  private detachTrace: (() => void) | undefined;
  private ended = false;
  private interruptPending = false;
  readonly result: Promise<AgentFlowResult>;

  constructor(start: (stream: AgentRunStream) => Promise<AgentFlowResult>) {
    this.result = start(this).finally(() => this.end());
  }

  attach(handle: RuntimeAgentRunHandle): void {
    this.liveHandle = handle;
    this.detachTrace = handle.trace?.subscribe((event) => this.push(event));
    if (this.interruptPending) handle.interrupt();
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
        if (this.ended) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }

  private push(event: AgentEvent): void {
    const reader = this.readers.shift();
    if (reader) {
      reader({ done: false, value: event });
    } else {
      this.events.push(event);
    }
  }

  private end(): void {
    this.ended = true;
    this.detachTrace?.();
    this.detachTrace = undefined;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
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

    if (!tryDefaultSession()) {
      initializeDefaultSession({
        transcripts: StreamLogStore.ephemeral('npm package consumer'),
      });
    }
    const session = defaultSession();
    const detachInteractions = session.useHostInteractions(input.interactions);
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
          onRun: (handle) => stream.attach(handle),
          session,
          stopAfterCycle: true,
          tools: input.tools,
        },
      );
    } finally {
      detachInteractions();
    }
  });
}
