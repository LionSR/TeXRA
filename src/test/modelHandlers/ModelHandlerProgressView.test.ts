// Standard library imports
import { strict as assert } from 'assert';

// Local imports - agent
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/modelHandlerGoogleGenAI';

// Local imports - event bus
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - model config
import { DEFAULT_MODEL_CAPABILITIES, ModelProvider } from '@model/ModelConfig';

class TestModelHandlerGoogleGenAI extends ModelHandlerGoogleGenAI {
  public createThinkingStreamPublic() {
    return this.createThinkingStream();
  }
}

describe('ModelHandler progress view flag', () => {
  const handlerConfig = {
    name: 'test-google-model',
    fullName: 'google/test',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 4096,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    openRouterOnly: false,
  };

  let handler: TestModelHandlerGoogleGenAI;
  let disposeAdd: () => void;
  let disposeUpdate: () => void;
  let addEvents: unknown[];
  let updateEvents: unknown[];

  beforeEach(() => {
    handler = new TestModelHandlerGoogleGenAI(handlerConfig);
    handler.setLogger(new AgentLogger('ProgressViewTest'));

    // Flush any buffered events from other tests
    const flushAdd = bus.on('addLogMessage', () => {});
    flushAdd();
    const flushUpdate = bus.on('updateLogMessage', () => {});
    flushUpdate();

    addEvents = [];
    updateEvents = [];

    disposeAdd = bus.on('addLogMessage', (payload) => addEvents.push(payload));
    disposeUpdate = bus.on('updateLogMessage', (payload) =>
      updateEvents.push(payload),
    );
  });

  afterEach(() => {
    disposeAdd?.();
    disposeUpdate?.();
  });

  it('prevents progress events when disabled', () => {
    handler.setProgressViewEnabled(false);

    const stream = handler.createThinkingStreamPublic();
    stream.append('Partial output ');
    const finalText = stream.finalize('Final output');

    assert.equal(finalText, 'Final output');
    assert.equal(addEvents.length, 0);
    assert.equal(updateEvents.length, 0);
  });
});
