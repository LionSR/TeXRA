// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { createFromTemplate } from '@common/templateUtils.js';
import { vscode } from '@common/webviewContext.js';

/** Manages approval request popups for bash command execution. */
export class BashApprovalRequests extends BaseUIRequestManager {
  constructor() {
    super({
      containerId: 'bashApprovalRequests',
      listSelector: '.bash-approval-requests__list',
      idAttribute: 'requestId',
    });
  }

  _createRequestElement(request) {
    const element = createFromTemplate('bashApprovalRequestTemplate');
    if (!element) {
      console.error('BashApprovalRequests: template not found');
      return document.createElement('div');
    }

    this._setRequestId(
      [element, ...element.querySelectorAll('[data-action]')],
      request.requestId,
    );

    this._updateRequestElement(element, request);
    return element;
  }

  _updateRequestElement(element, request) {
    const commandElem = element.querySelector(
      '.bash-approval-request__command',
    );
    element.dataset.streamId = request.streamId || '';

    if (commandElem) {
      // Display command in a code-like format
      const code = document.createElement('code');
      code.textContent = request.command || '';
      commandElem.textContent = '';
      commandElem.appendChild(code);
    }
  }

  _handleAction(event) {
    if (!(event.target instanceof Element)) return;

    const button = event.target.closest('[data-request-id][data-action]');
    if (!button) return;

    const { requestId, action } = button.dataset;
    if (!requestId || !action) return;

    const validActions = ['approve', 'reject'];
    if (!validActions.includes(action)) return;

    vscode.postMessage({
      command: COMMANDS.BASH_APPROVAL_ACTION,
      requestId,
      action,
    });
  }

  _setRequestId(elements, requestId) {
    elements.forEach((el) => el && (el.dataset.requestId = requestId));
  }
}
