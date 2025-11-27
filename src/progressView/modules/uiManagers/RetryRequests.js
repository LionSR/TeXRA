// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { vscode } from '@common/webviewContext.js';

/**
 * Manages retry request popups for failed API calls.
 * @extends BaseUIRequestManager
 */
export class RetryRequests extends BaseUIRequestManager {
  constructor() {
    super({
      containerId: 'retryRequests',
      listSelector: '.retry-requests__list',
      requestClass: 'retry-request',
      idAttribute: 'streamId',
    });
  }

  /** @override */
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

  /** @override */
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

  /** @override */
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
