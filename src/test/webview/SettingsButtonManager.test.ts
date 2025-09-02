import * as assert from 'assert';
import * as sinon from 'sinon';
import { SettingsButtonManager } from '../../webview/modules/uiManagers/SettingsButtonManager';
import { MAIN_VIEW_COMMANDS } from '../../common/webview/commands';

suite('SettingsButtonManager', () => {
  let manager: SettingsButtonManager;
  let vscodeStub: any;
  let addListenerStub: sinon.SinonStub;
  
  setup(() => {
    vscodeStub = {
      postMessage: sinon.stub()
    };
    
    manager = new SettingsButtonManager(vscodeStub, null, null, null);
    addListenerStub = sinon.stub(manager, 'addListener');
  });

  teardown(() => {
    sinon.restore();
  });

  test('should handle disabled option selection correctly', () => {
    // Setup mock event handlers
    let focusHandler: Function;
    let changeHandler: Function;
    
    addListenerStub.callsFake((id, event, handler) => {
      if (id === 'model' && event === 'focus') focusHandler = handler;
      if (id === 'model' && event === 'change') changeHandler = handler;
    });
    
    manager._setupDropdowns();
    
    // Simulate focus event to store previous value
    const focusEvent = { target: { value: 'claude-3-opus' } };
    focusHandler(focusEvent);
    
    // Simulate change event with disabled option
    const changeEvent = {
      target: {
        value: 'gpt-4',
        selectedIndex: 1,
        options: [{}, {
          disabled: true,
          dataset: { provider: 'openai' }
        }]
      }
    };
    
    changeHandler(changeEvent);
    
    // Verify that value was reverted
    assert.strictEqual(changeEvent.target.value, 'claude-3-opus');
    
    // Verify that API key setup was triggered
    assert.ok(vscodeStub.postMessage.calledWith({
      command: MAIN_VIEW_COMMANDS.OPEN_SET_API_KEY
    }));
    
    // Verify that banner was shown with provider
    assert.ok(vscodeStub.postMessage.calledWith({
      command: MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER,
      provider: 'openai'
    }));
  });

  test('should handle OpenRouter provider specially', () => {
    let changeHandler: Function;
    
    addListenerStub.callsFake((id, event, handler) => {
      if (id === 'model' && event === 'change') changeHandler = handler;
    });
    
    manager._setupDropdowns();
    
    const changeEvent = {
      target: {
        value: 'gpt-4',
        selectedIndex: 0,
        options: [{
          disabled: true,
          dataset: { provider: 'openrouter' }
        }]
      }
    };
    
    changeHandler(changeEvent);
    
    // Verify OpenRouter uses the guide command
    assert.ok(vscodeStub.postMessage.calledWith({
      command: MAIN_VIEW_COMMANDS.OPEN_API_KEY_GUIDE
    }));
  });

  test('should handle valid model selection normally', () => {
    let changeHandler: Function;
    
    addListenerStub.callsFake((id, event, handler) => {
      if (id === 'model' && event === 'change') changeHandler = handler;
    });
    
    manager._setupDropdowns();
    
    const changeEvent = {
      target: {
        value: 'claude-3-opus',
        selectedIndex: 0,
        options: [{
          disabled: false,
          dataset: { provider: 'anthropic' }
        }]
      }
    };
    
    changeHandler(changeEvent);
    
    // Verify normal model selection flow
    assert.ok(vscodeStub.postMessage.calledWith({
      command: MAIN_VIEW_COMMANDS.MODEL_SELECTED,
      model: 'claude-3-opus'
    }));
  });
});