// Local imports - progress view
import { COMMANDS } from '../constants.js';

// Local imports - common helpers
import { addEventListenerSafely } from '@common/domUtils.js';
import { vscode } from '@common/webviewContext.js';

export class RetryRequests {
  constructor() {
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

    this.container = document.getElementById('retryRequests');
    this.list =
      this.container?.querySelector('.retry-requests__list') ?? null;

    if (!this.container || !this.list) {
      return;
    }

    addEventListenerSafely(this.container, 'click', this._handleAction, true);
  }

  show(request) {
    if (!request || !request.streamId) {
      return;
    }

    if (!this.container || !this.list) {
      this.setup();
      if (!this.container || !this.list) {
        return;
      }
    }

    let entry = this.requests.get(request.streamId);
    if (!entry) {
      const element = this._createRequestElement(request);
      entry = { element, data: { ...request } };
      this.requests.set(request.streamId, entry);
    } else {
      entry.data = { ...entry.data, ...request };
    }

    this._updateRequestElement(entry.element, entry.data);
    this._syncVisibleEntries();
  }

  resolve(streamId) {
    if (!streamId) {
      return;
    }

    const entry = this.requests.get(streamId);
    this.requests.delete(streamId);
    if (entry?.element?.parentElement) {
      entry.element.parentElement.removeChild(entry.element);
    }
    this._syncVisibleEntries();
  }

  cleanup() {
    if (this.container) {
      this.container.removeEventListener('click', this._handleAction, true);
    }
    this.requests.clear();
    this.container = null;
    this.list = null;
    this.activeStream = '';
    this.isToolAgentActive = false;
  }

  _toggleVisibility() {
    if (!this.container || !this.list) {
      return;
    }
    const hasVisibleEntries = this.list.children.length > 0;
    const shouldShow = this.isToolAgentActive && hasVisibleEntries;
    this.container.classList.toggle('is-visible', shouldShow);
    this.container.toggleAttribute('hidden', !shouldShow);
  }

  _createRequestElement(request) {
    const element = document.createElement('div');
    element.className = 'retry-request';
    element.dataset.streamId = request.streamId;
    element.innerHTML = `
      <div class="retry-request__details">
        <div class="retry-request__operation"></div>
        <div class="retry-request__meta"></div>
        <div class="retry-request__error"></div>
      </div>
      <vscode-toolbar-container class="retry-request__actions">
        <vscode-toolbar-button
          icon="refresh"
          label="Retry"
          data-action="retry"
          data-stream-id="${request.streamId}"
        >Retry</vscode-toolbar-button>
        <vscode-toolbar-button
          icon="close"
          label="Dismiss"
          data-action="dismiss"
          data-stream-id="${request.streamId}"
        >Dismiss</vscode-toolbar-button>
      </vscode-toolbar-container>
    `;
    this._updateRequestElement(element, request);
    return element;
  }

  _updateRequestElement(element, request) {
    const operationElem = element.querySelector('.retry-request__operation');
    const metaElem = element.querySelector('.retry-request__meta');
    const errorElem = element.querySelector('.retry-request__error');
    element.dataset.streamId = request.streamId || '';

    if (operationElem) {
      operationElem.textContent = request.operation
        ? `Failed: ${request.operation}`
        : 'Request failed';
    }
    if (metaElem) {
      const parts = [];
      if (request.model) {
        parts.push(`Model: ${request.model}`);
      }
      metaElem.textContent = parts.join(' \u2022 ');
    }
    if (errorElem) {
      if (request.errorMessage) {
        errorElem.textContent = request.errorMessage;
        errorElem.title = request.errorMessage;
        errorElem.hidden = false;
      } else {
        errorElem.textContent = '';
        errorElem.hidden = true;
      }
    }
  }

  setActiveStream(streamId, isToolAgent) {
    this.activeStream = streamId || '';
    this.isToolAgentActive = Boolean(isToolAgent);
    this._syncVisibleEntries();
  }

  _syncVisibleEntries() {
    if (!this.list) {
      return;
    }

    const activeStream = this.activeStream;
    const shouldDisplay =
      this.isToolAgentActive && Boolean(activeStream && activeStream.length);

    const fragment = document.createDocumentFragment();
    for (const entry of this.requests.values()) {
      const { element, data } = entry;
      if (element.parentElement) {
        element.parentElement.removeChild(element);
      }

      if (shouldDisplay && (data.streamId || '') === activeStream) {
        fragment.appendChild(element);
      }
    }

    this.list.appendChild(fragment);
    this._toggleVisibility();
  }

  _handleAction(event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    const button = event.target.closest('[data-stream-id][data-action]');
    if (!button) {
      return;
    }

    const streamId = button.dataset.streamId;
    const action = button.dataset.action;
    if (!streamId || !action) {
      return;
    }

    if (action === 'retry') {
      vscode.postMessage({
        command: COMMANDS.RETRY_STREAM_REQUEST,
        stream: streamId,
      });
      this.resolve(streamId);
      return;
    }

    if (action === 'dismiss') {
      this.resolve(streamId);
    }
  }
}
