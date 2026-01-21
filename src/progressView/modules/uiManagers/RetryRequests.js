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

    // Check if this is a relay error
    const isRelayError = request.errorDetails?.isRelayError === true;
    const retryable = request.errorDetails?.retryable !== false; // Default to true for retry requests

    // Update element class for styling
    element.classList.toggle('retry-request--relay', isRelayError);

    if (operationElem) {
      // Add [Relay] prefix for relay errors
      const prefix = isRelayError ? '[Relay] ' : '';
      operationElem.textContent = request.operation
        ? `${prefix}Failed: ${request.operation}`
        : `${prefix}Request failed`;
    }

    if (metaElem) {
      const parts = [];
      if (request.model) {
        parts.push(`Model: ${request.model}`);
      }
      // Add source indicator
      if (isRelayError) {
        parts.push('Source: Relay');
      }
      // Add retryable status
      parts.push(retryable ? 'Retryable: Yes' : 'Retryable: No');
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
      const detailsText = this._formatErrorDetails(request.errorDetails);
      if (detailsText) {
        // Use textContent to avoid HTML injection from provider payloads.
        bodyElem.textContent = detailsText;
        detailsElem.hidden = false;
      } else {
        detailsElem.open = false;
        detailsElem.hidden = true;
      }
    }
  }

  /**
   * Formats error details into a displayable string.
   * Uses all fields from ProviderError schema (single source of truth).
   * @param {Object|undefined} details - Error details object (ProviderError)
   * @returns {string|null} Formatted details string, or null if no details
   */
  _formatErrorDetails(details) {
    if (!details) return null;

    // Fields to display in order (strings/numbers shown as-is, booleans explicitly)
    const formatBody = (body) =>
      typeof body === 'object' ? JSON.stringify(body, null, 2) : String(body);

    const lines = [
      details.message && `message: ${details.message}`,
      details.provider && `provider: ${details.provider}`,
      details.statusCode != null && `statusCode: ${details.statusCode}`,
      details.statusText && `statusText: ${details.statusText}`,
      details.isRelayError != null && `isRelayError: ${details.isRelayError}`,
      details.retryable != null && `retryable: ${details.retryable}`,
      details.requestId && `requestId: ${details.requestId}`,
      details.rawErrorBody != null &&
        `rawErrorBody: ${formatBody(details.rawErrorBody)}`,
    ].filter(Boolean);

    // Add stream diagnostics if present (Anthropic streaming errors)
    if (details.streamDiagnostics) {
      const diag = details.streamDiagnostics;
      lines.push('--- Stream Diagnostics ---');
      lines.push(`  thinkingChars: ${diag.thinkingChars}`);
      lines.push(`  textChars: ${diag.textChars}`);
      lines.push(`  toolInputChars: ${diag.toolInputChars}`);
      lines.push(`  blockTypesSeen: [${diag.blockTypesSeen?.join(', ') || ''}]`);
      lines.push(`  eventsProcessed: ${diag.eventsProcessed}`);
      lines.push(`  lastEventType: ${diag.lastEventType ?? 'null'}`);
      lines.push(`  elapsedSecs: ${diag.elapsedSecs}`);
      lines.push(`  secsSinceLastEvent: ${diag.secsSinceLastEvent}`);
      lines.push(`  finalized: ${diag.finalized}`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
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
