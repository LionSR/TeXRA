/**
 * Header Bar UI Manager
 */
import { vscode } from '@common/webviewContext.js';
import { SETTINGS_VIEW_COMMANDS, ELEMENT_IDS } from '../constants.js';

export class HeaderBar {
  constructor() {
    this._elements = null;
  }

  initialize() {
    this._elements = {
      header: document.getElementById(ELEMENT_IDS.SETTINGS_HEADER),
      accountInfo: document.getElementById(ELEMENT_IDS.ACCOUNT_INFO),
      userEmail: document.getElementById(ELEMENT_IDS.USER_EMAIL),
      userTier: document.getElementById(ELEMENT_IDS.USER_TIER),
      signInBtn: document.getElementById(ELEMENT_IDS.SIGN_IN_BTN),
      signOutBtn: document.getElementById(ELEMENT_IDS.SIGN_OUT_BTN),
      manageBtn: document.getElementById(ELEMENT_IDS.MANAGE_BTN),
      notLoggedInBanner: document.getElementById(ELEMENT_IDS.NOT_LOGGED_IN_BANNER),
    };

    this.attachEventListeners();
  }

  attachEventListeners() {
    const { signInBtn, signOutBtn } = this._elements;

    if (signInBtn) {
      signInBtn.addEventListener('click', () => {
        vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_IN });
      });
    }

    if (signOutBtn) {
      signOutBtn.addEventListener('click', () => {
        vscode.postMessage({ command: SETTINGS_VIEW_COMMANDS.SIGN_OUT });
      });
    }
  }

  render(state) {
    const {
      userEmail,
      userTier,
      signInBtn,
      signOutBtn,
      manageBtn,
      notLoggedInBanner,
    } = this._elements;

    if (state.authenticated) {
      // Logged in state
      if (userEmail) userEmail.textContent = state.email || 'Unknown';
      if (userTier) {
        userTier.textContent = state.tier || 'free';
        userTier.className = `user-tier badge tier-${(state.tier || 'free').toLowerCase()}`;
      }

      if (signInBtn) signInBtn.style.display = 'none';
      if (signOutBtn) signOutBtn.style.display = 'inline-flex';
      if (manageBtn) manageBtn.style.display = 'inline-flex';
      if (notLoggedInBanner) notLoggedInBanner.style.display = 'none';
    } else {
      // Not logged in state
      if (userEmail) userEmail.textContent = 'Not signed in';
      if (userTier) {
        userTier.textContent = '';
        userTier.className = 'user-tier badge';
      }

      if (signInBtn) signInBtn.style.display = 'inline-flex';
      if (signOutBtn) signOutBtn.style.display = 'none';
      if (manageBtn) manageBtn.style.display = 'none';
      if (notLoggedInBanner) notLoggedInBanner.style.display = 'flex';
    }
  }
}
