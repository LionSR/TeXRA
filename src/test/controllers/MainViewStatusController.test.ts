// Standard library imports
import { strict as assert } from 'assert';

// Local imports - common
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';

// Local imports - controllers
import { MainViewStatusController } from '../../controllers/mainView/MainViewStatusController';

describe('MainViewStatusController', () => {
  it('projects the active theme into webview messages', () => {
    const controller = new MainViewStatusController();

    assert.deepEqual(controller.getThemeMessage(true), {
      command: MAIN_VIEW_COMMANDS.THEME_SET,
      theme: 'dark',
    });
    assert.deepEqual(controller.getThemeMessage(false), {
      command: MAIN_VIEW_COMMANDS.THEME_SET,
      theme: 'light',
    });
  });

  it('projects debug mode into webview messages', () => {
    const controller = new MainViewStatusController();

    assert.deepEqual(controller.getDebugModeMessage(true), {
      command: MAIN_VIEW_COMMANDS.DEBUG_MODE_SET,
      debugMode: true,
    });
  });

  it('hides the login banner only after successful sign-in', () => {
    const controller = new MainViewStatusController();

    assert.deepEqual(controller.getPostSignInMessage({ authenticated: true }), {
      command: MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER,
    });
    assert.equal(
      controller.getPostSignInMessage({ authenticated: false }),
      null,
    );
  });
});
