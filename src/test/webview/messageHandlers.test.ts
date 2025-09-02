import * as assert from 'assert';
import * as sinon from 'sinon';
import { MainViewMessageHandler } from '../../webview/modules/messageHandlers';
import { MAIN_VIEW_COMMANDS } from '../../common/webview/commands';

suite('MainViewMessageHandler', () => {
  let handler: MainViewMessageHandler;
  let getElementStub: sinon.SinonStub;
  let clock: sinon.SinonFakeTimers;

  setup(() => {
    handler = new MainViewMessageHandler();
    getElementStub = sinon.stub(handler as any, '_getElement');
    clock = sinon.useFakeTimers();
  });

  teardown(() => {
    sinon.restore();
    clock.restore();
  });

  test('should capitalize provider name in API key banner', () => {
    const mockElement = {
      querySelector: sinon.stub().returns({
        textContent: ''
      }),
      style: {
        setProperty: sinon.stub()
      }
    };
    
    getElementStub.returns(mockElement);
    
    const handlers = (handler as any)._handlers;
    handlers[MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]({ provider: 'anthropic' });
    
    const textSpan = mockElement.querySelector.returnValues[0];
    assert.strictEqual(textSpan.textContent, 'Missing Anthropic API key.');
  });

  test('should prevent concurrent retry attempts for model options', () => {
    const consoleWarnStub = sinon.stub(console, 'warn');
    const handlers = (handler as any)._handlers;
    
    // First call - starts retry
    handlers[MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]({ options: '<option>Test</option>' });
    
    // Second call - should be blocked
    handlers[MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]({ options: '<option>Test2</option>' });
    
    assert.ok(consoleWarnStub.calledWith('SET_MODEL_OPTIONS: Retry already in progress'));
  });

  test('should reset retry flag after successful model options update', () => {
    const mockSelect = {
      innerHTML: '',
      value: 'previous',
      options: []
    };
    
    sinon.stub(document, 'getElementById').returns(null).onSecondCall().returns(mockSelect as any);
    
    const handlers = (handler as any)._handlers;
    handlers[MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]({ options: '<option>Test</option>' });
    
    // Advance time to trigger first retry
    clock.tick(100);
    
    assert.strictEqual((handler as any)._modelOptionsRetryInProgress, false);
  });
});