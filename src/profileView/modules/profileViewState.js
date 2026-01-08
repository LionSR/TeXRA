// Local imports - common
import { WebviewStateManager } from '@common/webviewState.js';

/**
 * State management for the profile view.
 * Uses composition with WebviewStateManager following the pattern of other views.
 */
class ProfileViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    this._authenticated = false;
    this._user = null;
    this._tier = 'free';
    this._remoteAgents = [];
  }

  /**
   * Initialize state from persisted storage.
   */
  initialize() {
    const saved = this.stateManager.getState();
    this._authenticated = saved.authenticated ?? false;
    this._user = saved.user ?? null;
    this._tier = saved.tier ?? 'free';
    this._remoteAgents = saved.remoteAgents ?? [];
  }

  /**
   * Save current state to persisted storage.
   */
  save() {
    this.stateManager.update({
      authenticated: this._authenticated,
      user: this._user,
      tier: this._tier,
      remoteAgents: this._remoteAgents,
    });
  }

  get authenticated() {
    return this._authenticated;
  }

  set authenticated(value) {
    this._authenticated = value;
    this.save();
  }

  get user() {
    return this._user;
  }

  set user(value) {
    this._user = value;
    this.save();
  }

  get tier() {
    return this._tier;
  }

  set tier(value) {
    this._tier = value;
    this.save();
  }

  get remoteAgents() {
    return this._remoteAgents;
  }

  set remoteAgents(value) {
    this._remoteAgents = value;
    this.save();
  }

  /**
   * Update profile data from message.
   */
  updateProfile(data) {
    this._authenticated = data.authenticated;
    this._user = data.user;
    this._tier = data.tier;
    this._remoteAgents = data.remoteAgents ?? [];
    this.save();
  }
}

export const profileViewState = new ProfileViewState();
