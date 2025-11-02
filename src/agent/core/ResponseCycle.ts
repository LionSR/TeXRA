// Local imports - agent components
import { AgentStateGlobal, AgentStateRound } from './AgentState';
import { ToolState } from './ToolState';

// Local imports - flow orchestration
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from './flows/ResponseCycleFlow';

// Local imports - option helpers
import type { AgentCycleBaseOptions } from './AgentCycleOptions';

// Local imports - model handler types
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';

// Local imports - agent configuration
import type { AgentConfig } from './AgentConfig';

export interface ResponseCycleOptions<C = unknown>
  extends AgentCycleBaseOptions<C> {
  agentConfig: AgentConfig;
}

export interface ResponseCycleContext<C = unknown> {
  options: ResponseCycleOptions<C>;
  messages: ProviderMessage[];
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  outputFile: string;
}

export interface ResponseCycleResult {
  stateRound: AgentStateRound;
  stateGlobal: AgentStateGlobal;
  toolState: ToolState;
  endTurn: boolean;
}

export async function runResponseCycle<C = unknown>(
  context: ResponseCycleContext<C>,
): Promise<ResponseCycleResult> {
  // Create structured shared store with explicit slices
  const store = {
    persistent: {
      messages: context.messages,
      stateRound: context.stateRound,
      stateGlobal: context.stateGlobal,
      toolState: context.toolState,
      outputFile: context.outputFile,
    },
    runtime: {
      endTurn: false,
      shouldStop: false,
      outputExists: false,
    },
    debug: {
      systemPrompt: undefined,
      debugContext: undefined,
      debugFileOptions: undefined,
    },
    model: {
      startTime: undefined,
      responseObject: undefined,
      responseTime: undefined,
      stopReason: undefined,
      processedResponse: undefined,
    },
  };

  // Legacy cycle accessor for backward compatibility
  const legacyCycle: ResponseCycleState = {
    get messages() {
      return store.persistent.messages;
    },
    set messages(val) {
      store.persistent.messages = val;
    },
    get stateRound() {
      return store.persistent.stateRound;
    },
    set stateRound(val) {
      store.persistent.stateRound = val;
    },
    get stateGlobal() {
      return store.persistent.stateGlobal;
    },
    set stateGlobal(val) {
      store.persistent.stateGlobal = val;
    },
    get toolState() {
      return store.persistent.toolState;
    },
    set toolState(val) {
      store.persistent.toolState = val;
    },
    get outputFile() {
      return store.persistent.outputFile;
    },
    set outputFile(val) {
      store.persistent.outputFile = val;
    },
    get endTurn() {
      return store.runtime.endTurn;
    },
    set endTurn(val) {
      store.runtime.endTurn = val;
    },
    get shouldStop() {
      return store.runtime.shouldStop;
    },
    set shouldStop(val) {
      store.runtime.shouldStop = val;
    },
    get outputExists() {
      return store.runtime.outputExists;
    },
    set outputExists(val) {
      store.runtime.outputExists = val;
    },
    get systemPrompt() {
      return store.debug.systemPrompt;
    },
    set systemPrompt(val) {
      store.debug.systemPrompt = val;
    },
    get debugContext() {
      return store.debug.debugContext;
    },
    set debugContext(val) {
      store.debug.debugContext = val;
    },
    get debugFileOptions() {
      return store.debug.debugFileOptions;
    },
    set debugFileOptions(val) {
      store.debug.debugFileOptions = val;
    },
    get startTime() {
      return store.model.startTime;
    },
    set startTime(val) {
      store.model.startTime = val;
    },
    get responseObject() {
      return store.model.responseObject;
    },
    set responseObject(val) {
      store.model.responseObject = val;
    },
    get responseTime() {
      return store.model.responseTime;
    },
    set responseTime(val) {
      store.model.responseTime = val;
    },
    get stopReason() {
      return store.model.stopReason;
    },
    set stopReason(val) {
      store.model.stopReason = val;
    },
    get processedResponse() {
      return store.model.processedResponse;
    },
    set processedResponse(val) {
      store.model.processedResponse = val;
    },
  };

  const shared: ResponseCycleShared<C> = {
    options: context.options,
    store,
    cycle: legacyCycle as ResponseCycleState,
  };

  const flow = createResponseCycleFlow<C>();
  await flow.run(shared);

  return {
    stateRound: store.persistent.stateRound,
    stateGlobal: store.persistent.stateGlobal,
    toolState: store.persistent.toolState,
    endTurn: store.runtime.endTurn,
  };
}
