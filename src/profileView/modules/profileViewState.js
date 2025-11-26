// Local imports - common
import { WebviewState } from '@common/webviewState.js';

/**
 * State management for the profile view.
 */
class ProfileViewState extends WebviewState {
  constructor() {
    super('profileView');
    this._authenticated = false;
    this._user = null;
    this._tier = 'free';
    this._remoteAgents = [];
  }

  get authenticated() {
    return this._authenticated;
  }

  set authenticated(value) {
    this._authenticated = value;
    this.saveState();
  }

  get user() {
    return this._user;
  }

  set user(value) {
    this._user = value;
    this.saveState();
  }

  get tier() {
    return this._tier;
  }

  set tier(value) {
    this._tier = value;
    this.saveState();
  }

  get remoteAgents() {
    return this._remoteAgents;
  }

  set remoteAgents(value) {
    this._remoteAgents = value;
    this.saveState();
  }

  /**
   * Update profile data from message
   */
  updateProfile(data) {
    this._authenticated = data.authenticated;
    this._user = data.user;
    this._tier = data.tier;
    this._remoteAgents = data.remoteAgents || [];
    this.saveState();
  }

  getStateForSave() {
    return {
      authenticated: this._authenticated,
      user: this._user,
      tier: this._tier,
      remoteAgents: this._remoteAgents,
    };
  }

  restoreFromState(state) {
    if (state) {
      this._authenticated = state.authenticated ?? false;
      this._user = state.user ?? null;
      this._tier = state.tier ?? 'free';
      this._remoteAgents = state.remoteAgents ?? [];
    }
  }
}

export const profileViewState = new ProfileViewState();
