// Local imports - common helpers
import {
  addEventListenerSafely,
  setVisibilityState,
} from '@common/domUtils.js';

/**
 * Base class for UI request managers (approvals, retries, etc.)
 * Provides common functionality for showing/resolving/managing request popups.
 *
 * @abstract
 */
export class BaseUIRequestManager {
  /**
   * @param {Object} config
   * @param {string} config.containerId - DOM ID of the container element
   * @param {string} config.listSelector - CSS selector for the list within container
   * @param {string} config.idAttribute - Data attribute name for request ID (e.g., 'requestId', 'streamId')
   * @param {boolean} [config.requireToolAgent=true] - Whether to only show for tool agent streams
   */
  constructor(config) {
    this._config = {
      requireToolAgent: true, // Default: only show for tool agents
      ...config,
    };
    this.container = null;
    this.list = null;
    this.requests = new Map();
    this.activeStream = '';
    this.isToolAgentActive = false;
    this._handleAction = this._handleAction.bind(this);
  }

  setup() {
    if (this.container && this.list) {
      return;
    }

    this.container = document.getElementById(this._config.containerId);
    this.list =
      this.container?.querySelector(this._config.listSelector) ?? null;

    if (!this.container || !this.list) {
      return;
    }

    addEventListenerSafely(this.container, 'click', this._handleAction, true);
    this._setupAdditionalListeners();
  }

  /**
   * Override to add additional event listeners during setup.
   * @protected
   */
  _setupAdditionalListeners() {
    // Subclasses can override
  }

  /**
   * Get the ID from a request object.
   * @param {Object} request
   * @returns {string|undefined}
   * @protected
   */
  _getRequestId(request) {
    return request?.[this._config.idAttribute];
  }

  /**
   * Show a request in the UI.
   * @param {Object} request - The request data
   */
  show(request) {
    const requestId = this._getRequestId(request);
    if (!requestId) {
      return;
    }

    if (!this.container || !this.list) {
      this.setup();
      if (!this.container || !this.list) {
        return;
      }
    }

    let entry = this.requests.get(requestId);
    if (!entry) {
      const element = this._createRequestElement(request);
      entry = { element, data: { ...request } };
      this.requests.set(requestId, entry);
    } else {
      entry.data = { ...entry.data, ...request };
    }

    this._updateRequestElement(entry.element, entry.data);
    this._syncVisibleEntries();
  }

  /**
   * Resolve/remove a request from the UI.
   * @param {string} requestId
   */
  resolve(requestId) {
    if (!requestId) {
      return;
    }

    const entry = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (entry?.element?.parentElement) {
      entry.element.parentElement.removeChild(entry.element);
    }
    this._syncVisibleEntries();
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    if (this.container) {
      this.container.removeEventListener('click', this._handleAction, true);
      this._disposeAdditionalListeners();
    }
    this.requests.clear();
    this.container = null;
    this.list = null;
    this.activeStream = '';
    this.isToolAgentActive = false;
  }

  /**
   * Override to dispose additional event listeners.
   * @protected
   */
  _disposeAdditionalListeners() {
    // Subclasses can override
  }

  /**
   * Set the active stream and visibility state.
   * @param {string} streamId
   * @param {boolean} isToolAgent
   */
  setActiveStream(streamId, isToolAgent) {
    this.activeStream = streamId || '';
    this.isToolAgentActive = Boolean(isToolAgent);
    this._syncVisibleEntries();
  }

  /**
   * Toggle container visibility based on entries.
   * @protected
   */
  _toggleVisibility() {
    if (!this.container || !this.list) {
      return;
    }
    const hasVisibleEntries = this.list.children.length > 0;
    // Only require tool agent check if configured (default true for backward compat)
    const agentCheck = this._config.requireToolAgent
      ? this.isToolAgentActive
      : true;
    const shouldShow = agentCheck && hasVisibleEntries;
    setVisibilityState(this.container, shouldShow);
  }

  /**
   * Sync visible entries based on active stream.
   * @protected
   */
  _syncVisibleEntries() {
    if (!this.list) {
      return;
    }

    const activeStream = this.activeStream;
    // Only require tool agent check if configured (default true for backward compat)
    const agentCheck = this._config.requireToolAgent
      ? this.isToolAgentActive
      : true;
    const shouldDisplay =
      agentCheck && Boolean(activeStream && activeStream.length);

    const fragment = document.createDocumentFragment();
    for (const entry of this.requests.values()) {
      const { element, data } = entry;
      if (element.parentElement) {
        element.parentElement.removeChild(element);
      }

      if (shouldDisplay && this._matchesActiveStream(data, activeStream)) {
        fragment.appendChild(element);
      }
    }

    this.list.appendChild(fragment);
    this._toggleVisibility();
  }

  /**
   * Check if request data matches the active stream.
   * @param {Object} data - Request data
   * @param {string} activeStream - Active stream ID
   * @returns {boolean}
   * @protected
   */
  _matchesActiveStream(data, activeStream) {
    return (data.streamId || '') === activeStream;
  }

  /**
   * Create DOM element for a request.
   * @abstract
   * @param {Object} request
   * @returns {HTMLElement}
   * @protected
   */
  _createRequestElement(_request) {
    throw new Error('Subclass must implement _createRequestElement');
  }

  /**
   * Update DOM element with request data.
   * @abstract
   * @param {HTMLElement} element
   * @param {Object} request
   * @protected
   */
  _updateRequestElement(_element, _request) {
    throw new Error('Subclass must implement _updateRequestElement');
  }

  /**
   * Handle click actions on request elements.
   * @abstract
   * @param {Event} event
   * @protected
   */
  _handleAction(_event) {
    throw new Error('Subclass must implement _handleAction');
  }
}
