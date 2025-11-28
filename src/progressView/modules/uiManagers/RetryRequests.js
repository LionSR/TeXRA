// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { createFromTemplate } from '@common/templateUtils.js';
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
      idAttribute: 'streamId',
      requireToolAgent: false, // Show for all stream types (workflow, tool-use, etc.)
    });
  }

  /** @override */
  _createRequestElement(request) {
    const element = createFromTemplate('retryRequestTemplate');
    if (!element) {
      console.error('RetryRequests: retryRequestTemplate not found');
      return document.createElement('div');
    }

    // Set stream ID on element and all action buttons
    element.dataset.streamId = request.streamId;
    element.querySelectorAll('[data-action]').forEach((btn) => {
      btn.dataset.streamId = request.streamId;
    });

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

    // Send command to backend - UI resolution happens via resolveRetryRequest event
    if (action === 'retry') {
      vscode.postMessage({
        command: COMMANDS.RETRY_STREAM_REQUEST,
        stream: streamId,
      });
      return;
    }

    if (action === 'dismiss') {
      vscode.postMessage({
        command: COMMANDS.CANCEL_RETRY_REQUEST,
        stream: streamId,
      });
    }
  }
}
