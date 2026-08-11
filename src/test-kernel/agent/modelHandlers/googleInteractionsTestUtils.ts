// Third-party imports
import type { Interactions } from '@google/genai';
import { ModelProvider } from 'llm-zoo';

// Local imports
import type { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';

/**
 * The model every offline Google Interactions suite runs against. Pass the
 * capabilities a suite depends on as `buildTestModelConfig`'s second argument
 * so the meaningful override stays visible at the call site.
 */
export const GOOGLE_INTERACTIONS_TEST_CONFIG = Object.freeze({
  name: 'test-google-interactions',
  label: 'Test Google Interactions',
  fullName: 'gemini-3-pro-test',
  shortName: 'gemini-3-pro-test',
  provider: ModelProvider.GOOGLE,
  contextWindow: 4096,
});

/** Handler pinned to the streaming SSE path (the production default). */
export class StreamingGoogleInteractionsHandler extends ModelHandlerGoogleInteractions {
  override getStreamingConfig(): boolean {
    return true;
  }
}

export function userStep(text: string): Interactions.Step {
  return { type: 'user_input', content: [{ type: 'text', text }] };
}

/**
 * Minimal workspace stub exposing the reasoning cache + reset hooks the
 * handler touches during a tool round-trip.
 */
export function fakeWorkspace(): AgentWorkspaceState {
  const reasoning = { thinkingBlocks: [] } as {
    thinkingBlocks: Array<{ thinking?: string; signature?: string }>;
  };
  return {
    reasoning,
    resetServerToolContent: () => undefined,
    resetReasoning: () => {
      reasoning.thinkingBlocks = [];
    },
  } as unknown as AgentWorkspaceState;
}
