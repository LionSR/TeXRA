// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { addEventListenerSafely } from '@common/domUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';
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
  dispose() {
    super.dispose();
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
    const element = createFromTemplate('approvalRequestTemplate');
    if (!element) {
      console.error('ApprovalRequests: approvalRequestTemplate not found');
      return document.createElement('div');
    }

    // Set request ID on element and all action buttons
    element.dataset.requestId = request.requestId;
    element.querySelectorAll('[data-action]').forEach((btn) => {
      btn.dataset.requestId = request.requestId;
    });

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
    const toCount = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);
    const added = toCount(request.addedLines);
    const removed = toCount(request.removedLines);
    const total = added + removed;
    const lineLabel = total === 1 ? 'line' : 'lines';

    const parts = [];
    if (request.sourceTool) {
      parts.push(`Requested by ${request.sourceTool}`);
    }

    // Build diff summary
    const diffParts = [];
    if (added > 0) diffParts.push(`+${added}`);
    if (removed > 0) diffParts.push(`-${removed}`);
    const tooltip =
      diffParts.length > 0
        ? `${diffParts.join(' / ')} ${lineLabel} changed`
        : 'No line changes';

    metaElem.textContent = parts.join(' • ');
    if (parts.length > 0) metaElem.append(' • ');

    const diffContainer = document.createElement('span');
    diffContainer.className = 'approval-request__diff';
    diffContainer.title = tooltip;

    if (added > 0) {
      const span = document.createElement('span');
      span.className = 'approval-request__diff-added';
      span.textContent = `+${added}`;
      diffContainer.appendChild(span);
    }
    if (removed > 0) {
      const span = document.createElement('span');
      span.className = 'approval-request__diff-removed';
      span.textContent = `-${removed}`;
      diffContainer.appendChild(span);
    }

    const labelSpan = document.createElement('span');
    labelSpan.className = 'approval-request__diff-label';
    labelSpan.textContent = `${total} ${lineLabel}`;
    diffContainer.appendChild(labelSpan);

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
