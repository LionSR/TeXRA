// Local imports - progress view
import { COMMANDS } from '../constants.js';

// Local imports - common helpers
import { addEventListenerSafely } from '@common/domUtils.js';
import { vscode } from '@common/webviewContext.js';

export class ApprovalRequests {
  constructor() {
    this.container = null;
    this.list = null;
    this.requests = new Map();
    this._handleAction = this._handleAction.bind(this);
  }

  setup() {
    if (this.container && this.list) {
      return;
    }

    this.container = document.getElementById('approvalRequests');
    this.list =
      this.container?.querySelector('.approval-requests__list') ?? null;

    if (!this.container || !this.list) {
      return;
    }

    addEventListenerSafely(this.container, 'click', this._handleAction, true);
  }

  show(request) {
    if (!request || !request.requestId) {
      return;
    }

    if (!this.container || !this.list) {
      this.setup();
      if (!this.container || !this.list) {
        return;
      }
    }

    let element = this.requests.get(request.requestId);
    if (!element) {
      element = this._createRequestElement(request);
      this.requests.set(request.requestId, element);
      this.list.appendChild(element);
    } else {
      this._updateRequestElement(element, request);
    }

    this._toggleVisibility();
  }

  resolve(requestId) {
    if (!requestId) {
      return;
    }

    const element = this.requests.get(requestId);
    if (element?.parentElement) {
      element.parentElement.removeChild(element);
    }
    this.requests.delete(requestId);
    this._toggleVisibility();
  }

  cleanup() {
    if (this.container) {
      this.container.removeEventListener('click', this._handleAction, true);
    }
    this.requests.clear();
    this.container = null;
    this.list = null;
  }

  _toggleVisibility() {
    if (!this.container) {
      return;
    }
    const shouldShow = this.requests.size > 0;
    this.container.classList.toggle('is-visible', shouldShow);
    this.container.toggleAttribute('hidden', !shouldShow);
  }

  _createRequestElement(request) {
    const element = document.createElement('div');
    element.className = 'approval-request';
    element.dataset.requestId = request.requestId;
    element.innerHTML = `
      <div class="approval-request__details">
        <div class="approval-request__path"></div>
        <div class="approval-request__meta"></div>
      </div>
      <div class="approval-request__actions">
        <vscode-button
          appearance="secondary"
          data-action="open"
          data-request-id="${request.requestId}"
        >Open diff</vscode-button>
        <vscode-button
          appearance="primary"
          data-action="approve"
          data-request-id="${request.requestId}"
        >Approve</vscode-button>
        <vscode-button
          appearance="secondary"
          data-action="reject"
          data-request-id="${request.requestId}"
        >Reject</vscode-button>
      </div>
    `;
    this._updateRequestElement(element, request);
    return element;
  }

  _updateRequestElement(element, request) {
    const pathElem = element.querySelector('.approval-request__path');
    const metaElem = element.querySelector('.approval-request__meta');
    if (pathElem) {
      pathElem.textContent = request.relativePath || request.path || '';
    }
    if (metaElem) {
      metaElem.textContent = request.sourceTool
        ? `Requested by ${request.sourceTool}`
        : '';
    }
  }

  _handleAction(event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    const button = event.target.closest('[data-request-id][data-action]');
    if (!button) {
      return;
    }

    const requestId = button.dataset.requestId;
    const action = button.dataset.action;
    if (!requestId || !action) {
      return;
    }

    if (action === 'open') {
      vscode.postMessage({
        command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId,
        action: 'openDiff',
      });
      return;
    }

    if (action === 'approve') {
      vscode.postMessage({
        command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId,
        action: 'approve',
      });
      return;
    }

    if (action === 'reject') {
      vscode.postMessage({
        command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId,
        action: 'reject',
      });
    }
  }
}
