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
    this.activeStream = '';
    this.isToolAgentActive = false;
    this._handleAction = this._handleAction.bind(this);
    this._handleToggle = this._handleToggle.bind(this);
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
    addEventListenerSafely(this.container, 'change', this._handleToggle, true);
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
    } else {
      entry.data = { ...entry.data, ...request };
    }

    this._updateRequestElement(entry.element, entry.data);
    this._syncVisibleEntries();
  }

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

  cleanup() {
    if (this.container) {
      this.container.removeEventListener('click', this._handleAction, true);
      this.container.removeEventListener('change', this._handleToggle, true);
    }
    this.requests.clear();
    this.container = null;
    this.list = null;
    this.isBypassActive = false;
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
        >Open diff</vscode-toolbar-button>
        <vscode-toolbar-button
          icon="check"
          label="Approve"
          data-action="approve"
          data-request-id="${request.requestId}"
        >Approve</vscode-toolbar-button>
        <vscode-toolbar-button
          icon="close"
          label="Reject"
          data-action="reject"
          data-request-id="${request.requestId}"
        >Reject</vscode-toolbar-button>
        <vscode-toolbar-button
          icon="shield"
          label="Approve &amp; Yolo this session"
          data-action="approveAll"
          data-request-id="${request.requestId}"
          data-toggle-action="resumeApprovals"
          toggleable
        >Approve &amp; Yolo this session</vscode-toolbar-button>
      </vscode-toolbar-container>
    `;
    this._updateRequestElement(element, request);
    return element;
  }

  _updateRequestElement(element, request) {
    const pathElem = element.querySelector('.approval-request__path');
    const metaElem = element.querySelector('.approval-request__meta');
    const bypassButton = element.querySelector('[data-action="approveAll"]');
    element.dataset.streamId = request.streamId || '';
    if (pathElem) {
      pathElem.textContent = request.relativePath || request.path || '';
    }
    if (metaElem) {
      const toolSummary = request.sourceTool
        ? `Requested by ${request.sourceTool}`
        : '';
      const added = Number.isFinite(request.addedLines)
        ? Math.max(0, Number(request.addedLines))
        : 0;
      const removed = Number.isFinite(request.removedLines)
        ? Math.max(0, Number(request.removedLines))
        : 0;

      metaElem.textContent = '';

      if (toolSummary) {
        metaElem.append(document.createTextNode(toolSummary));
      }

      const diffContainer = document.createElement('span');
      diffContainer.className = 'approval-request__diff';

      const summaryParts = [];
      if (added > 0) {
        const addedSpan = document.createElement('span');
        addedSpan.className = 'approval-request__diff-added';
        addedSpan.textContent = `+${added}`;
        diffContainer.appendChild(addedSpan);
        summaryParts.push(`+${added}`);
      }

      if (removed > 0) {
        const removedSpan = document.createElement('span');
        removedSpan.className = 'approval-request__diff-removed';
        removedSpan.textContent = `-${removed}`;
        diffContainer.appendChild(removedSpan);
        summaryParts.push(`-${removed}`);
      }

      const total = added + removed;
      const labelSpan = document.createElement('span');
      labelSpan.className = 'approval-request__diff-label';
      labelSpan.textContent = `${total} ${total === 1 ? 'line' : 'lines'}`;
      diffContainer.appendChild(labelSpan);

      diffContainer.title =
        summaryParts.length > 0
          ? `${summaryParts.join(' / ')} ${
              total === 1 ? 'line' : 'lines'
            } changed`
          : 'No line changes';

      if (toolSummary && diffContainer.childElementCount > 0) {
        metaElem.append(document.createTextNode(' • '));
      }

      metaElem.appendChild(diffContainer);
    }
    if (bypassButton) {
      const allowBypass = request.allowBypass !== false;
      bypassButton.toggleAttribute('disabled', !allowBypass);
      bypassButton.checked = Boolean(this.isBypassActive);
    }
  }

  setSessionBypassActive(isActive) {
    this.isBypassActive = Boolean(isActive);
    this.requests.forEach((entry) => {
      this._updateRequestElement(entry.element, entry.data);
    });
    this._syncVisibleEntries();
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
    const button = event.target.closest('[data-request-id][data-action]');
    if (!button) {
      return;
    }

    if (button.hasAttribute('data-toggle-action')) {
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

  _handleToggle(event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const button = event.target.closest(
      '[data-request-id][data-action][data-toggle-action]',
    );
    if (!button) {
      return;
    }

    const requestId = button.dataset.requestId;
    if (!requestId) {
      return;
    }

    const primaryAction = button.dataset.action;
    const toggleAction = button.dataset.toggleAction;
    const action = button.checked ? primaryAction : toggleAction;

    if (!action) {
      return;
    }

    vscode.postMessage({
      command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId,
      action,
    });
  }
}
