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

    const detailsElem = element.querySelector('.retry-request__error-details');
    if (detailsElem) {
      detailsElem.addEventListener('toggle', () => {
        const icon = detailsElem.querySelector('.toggle-icon');
        if (icon) {
          icon.className = detailsElem.open
            ? 'codicon codicon-chevron-down toggle-icon'
            : 'codicon codicon-chevron-right toggle-icon';
        }
      });
    }

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

    // Populate expandable error details if available
    const detailsElem = element.querySelector('.retry-request__error-details');
    const bodyElem = element.querySelector('.retry-request__error-body');
    if (detailsElem && bodyElem) {
      const details = request.errorDetails;
      if (
        details &&
        (details.provider != null ||
          details.statusCode != null ||
          details.rawErrorBody != null)
      ) {
        const lines = [];
        if (details.provider) lines.push(`provider: ${details.provider}`);
        if (details.statusCode != null) {
          lines.push(`statusCode: ${details.statusCode}`);
        }
        if (details.rawErrorBody) {
          const bodyStr =
            typeof details.rawErrorBody === 'object'
              ? JSON.stringify(details.rawErrorBody, null, 2)
              : String(details.rawErrorBody);
          lines.push(`rawErrorBody: ${bodyStr}`);
        }
        // Use textContent to avoid HTML injection from provider payloads.
        bodyElem.textContent = lines.join('\n');
        detailsElem.hidden = false;
      } else {
        detailsElem.open = false;
        detailsElem.hidden = true;
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

    const actionCommands = {
      retry: COMMANDS.RETRY_STREAM_REQUEST,
      dismiss: COMMANDS.CANCEL_RETRY_REQUEST,
    };

    const command = actionCommands[action];
    if (command) {
      vscode.postMessage({ command, stream: streamId });
    }
  }
}
