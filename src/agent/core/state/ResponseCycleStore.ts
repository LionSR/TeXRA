// Local imports - conversation state
import { RoundMetricsState, SessionUsageState } from './ConversationState';
import {
  DocumentAssetState,
  ReasoningTraceState,
  ResponseDraftState,
  type ToolResponseState,
  createToolResponseState,
} from './ToolResponseState';

// Local imports - provider types
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ProviderStopReason } from '@agent/modelHandlers/types/StopReasonTypes';

export interface ResponseDebugContext {
  logger: unknown;
  modelName: string;
  executionId?: unknown;
}

export interface ResponseDebugFileOptions {
  continuationCount: number;
  outputFile: string;
}

export interface ResponseCycleRuntimeState {
  endTurn: boolean;
  shouldStop: boolean;
  outputExists: boolean;
  systemPrompt?: string;
  debugContext?: ResponseDebugContext;
  debugFileOptions?: ResponseDebugFileOptions;
  startTime?: number;
  responseObject?: unknown;
  responseTime?: number;
  stopReason?: ProviderStopReason;
  processedResponse?: string;
}

export interface ResponseCycleStore {
  messages: ProviderMessage[];
  outputFile: string;
  round: RoundMetricsState;
  session: SessionUsageState;
  tool: ToolResponseState;
  runtime: ResponseCycleRuntimeState;
}

export function createResponseCycleStore(options: {
  messages: ProviderMessage[];
  outputFile: string;
  round: RoundMetricsState;
  session: SessionUsageState;
  toolState?: ToolResponseState;
}): ResponseCycleStore {
  const toolState = options.toolState ?? createToolResponseState();
  return {
    messages: options.messages,
    outputFile: options.outputFile,
    round: options.round,
    session: options.session,
    tool: toolState,
    runtime: {
      endTurn: false,
      shouldStop: false,
      outputExists: false,
    },
  };
}

export function resetResponseCycleRuntime(runtime: ResponseCycleRuntimeState): void {
  runtime.shouldStop = false;
  runtime.endTurn = false;
  runtime.responseObject = undefined;
  runtime.responseTime = undefined;
  runtime.stopReason = undefined;
  runtime.processedResponse = undefined;
}

export { DocumentAssetState, ReasoningTraceState, ResponseDraftState };
