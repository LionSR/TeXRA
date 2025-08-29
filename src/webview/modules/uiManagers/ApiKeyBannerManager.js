// Local imports - webview
import { BaseUIManager } from './BaseUIManager.js';
import { ELEMENT_IDS } from '../constants.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';
import { safeGetElementById } from '@common/domUtils.js';

export class ApiKeyBannerManager extends BaseUIManager {
  constructor(vscodeInstance = vscode) {
    super();
    this.vscode = vscodeInstance;
    this.bannerEl = null;
  }

  setup() {
    this.bannerEl = safeGetElementById(ELEMENT_IDS.API_KEY_BANNER);
    this.addListener(ELEMENT_IDS.SET_API_KEY_BUTTON, 'click', () => {
      this.vscode.postMessage({ command: MAIN_VIEW_COMMANDS.SET_API_KEY });
    });
    this.addListener(ELEMENT_IDS.DISMISS_API_KEY_BANNER, 'click', () =>
      this.hide(),
    );
  }

  show() {
    if (this.bannerEl) {
      this.bannerEl.style.display = 'flex';
    }
  }

  hide() {
    if (this.bannerEl) {
      this.bannerEl.style.display = 'none';
    }
  }
}
