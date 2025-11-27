// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { addEventListenerSafely } from '@common/domUtils.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Manages approval request popups for tool edits.
 * @extends BaseUIRequestManager
 */
export class ApprovalRequests extends BaseUIRequestManager {
  constructor() {
    super({
      containerId: 'approvalRequests',
      listSelector: '.approval-requests__list',
      idAttribute: 'requestId',
    });
    this.isBypassActive = false;
    this._handleToggle = this._handleToggle.bind(this);
  }

  /** @override */
  _setupAdditionalListeners() {
    if (this.container) {
      addEventListenerSafely(
        this.container,
        'change',
        this._handleToggle,
        true,
      );
    }
  }

  /** @override */
  _cleanupAdditionalListeners() {
    if (this.container) {
      this.container.removeEventListener('change', this._handleToggle, true);
    }
  }

  /** @override */
  cleanup() {
    super.cleanup();
    this.isBypassActive = false;
  }

  /**
   * Set whether session bypass is active.
   * @param {boolean} isActive
   */
  setSessionBypassActive(isActive) {
    this.isBypassActive = Boolean(isActive);
    this.requests.forEach((entry) => {
      this._updateRequestElement(entry.element, entry.data);
    });
    this._syncVisibleEntries();
  }

  /** @override */
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
        >Appr. &amp; Yolo</vscode-toolbar-button>
      </vscode-toolbar-container>
    `;
    this._updateRequestElement(element, request);
    return element;
  }

  /** @override */
  _updateRequestElement(element, request) {
    const pathElem = element.querySelector('.approval-request__path');
    const metaElem = element.querySelector('.approval-request__meta');
    const bypassButton = element.querySelector('[data-action="approveAll"]');
    element.dataset.streamId = request.streamId || '';

    if (pathElem) {
      pathElem.textContent = request.relativePath || request.path || '';
    }

    if (metaElem) {
      this._updateMetaElement(metaElem, request);
    }

    if (bypassButton) {
      const allowBypass = request.allowBypass !== false;
      bypassButton.toggleAttribute('disabled', !allowBypass);
      bypassButton.checked = Boolean(this.isBypassActive);
    }
  }

  /**
   * Update the meta element with diff information.
   * @private
   */
  _updateMetaElement(metaElem, request) {
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
        ? `${summaryParts.join(' / ')} ${total === 1 ? 'line' : 'lines'} changed`
        : 'No line changes';

    if (toolSummary && diffContainer.childElementCount > 0) {
      metaElem.append(document.createTextNode(' • '));
    }

    metaElem.appendChild(diffContainer);
  }

  /** @override */
  _handleAction(event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    const button = event.target.closest('[data-request-id][data-action]');
    if (!button) {
      return;
    }

    // Skip toggle buttons - handled by _handleToggle
    if (button.hasAttribute('data-toggle-action')) {
      return;
    }

    const requestId = button.dataset.requestId;
    const action = button.dataset.action;
    if (!requestId || !action) {
      return;
    }

    const actionMap = {
      open: 'openDiff',
      approve: 'approve',
      approveAll: 'approveAll',
      reject: 'reject',
    };

    const mappedAction = actionMap[action];
    if (mappedAction) {
      vscode.postMessage({
        command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        requestId,
        action: mappedAction,
      });
    }
  }

  /**
   * Handle toggle button changes.
   * @private
   */
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
