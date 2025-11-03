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
    this.isBypassActive = false;
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

    let entry = this.requests.get(request.requestId);
    if (!entry) {
      const element = this._createRequestElement(request);
      entry = { element, data: { ...request } };
      this.requests.set(request.requestId, entry);
      this.list.appendChild(element);
    } else {
      entry.data = { ...entry.data, ...request };
    }

    this._updateRequestElement(entry.element, entry.data);

    this._toggleVisibility();
  }

  resolve(requestId) {
    if (!requestId) {
      return;
    }

    const entry = this.requests.get(requestId);
    if (entry?.element?.parentElement) {
      entry.element.parentElement.removeChild(entry.element);
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
    this.isBypassActive = false;
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
      <vscode-toolbar-container class="approval-request__actions">
        <vscode-toolbar-button
          icon="diff"
          label="Open diff"
          data-action="open"
          data-request-id="${request.requestId}"
        ></vscode-toolbar-button>
        <vscode-toolbar-button
          icon="check"
          label="Approve"
          data-action="approve"
          data-request-id="${request.requestId}"
        ></vscode-toolbar-button>
        <vscode-toolbar-button
          icon="close"
          label="Reject"
          data-action="reject"
          data-request-id="${request.requestId}"
        ></vscode-toolbar-button>
        <vscode-toolbar-button
          icon="shield"
          label="Approve &amp; skip approvals this session"
          data-action="approveAll"
          data-request-id="${request.requestId}"
        ></vscode-toolbar-button>
      </vscode-toolbar-container>
    `;
    this._updateRequestElement(element, request);
    return element;
  }

  _updateRequestElement(element, request) {
    const pathElem = element.querySelector('.approval-request__path');
    const metaElem = element.querySelector('.approval-request__meta');
    const bypassButton = element.querySelector('[data-action="approveAll"]');
    if (pathElem) {
      pathElem.textContent = request.relativePath || request.path || '';
    }
    if (metaElem) {
      metaElem.textContent = request.sourceTool
        ? `Requested by ${request.sourceTool}`
        : '';
    }
    if (bypassButton) {
      const allowBypass =
        request.allowBypass !== false && this.isBypassActive !== true;
      bypassButton.toggleAttribute('hidden', !allowBypass);
      bypassButton.toggleAttribute('disabled', !allowBypass);
    }
  }

  setSessionBypassActive(isActive) {
    this.isBypassActive = Boolean(isActive);
    this.requests.forEach((entry) => {
      this._updateRequestElement(entry.element, entry.data);
    });
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

    if (action === 'approveAll') {
      vscode.postMessage({
        command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId,
        action: 'approveAll',
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
