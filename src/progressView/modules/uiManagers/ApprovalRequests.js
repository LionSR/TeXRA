// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import {
  addEventListenerSafely,
  setElementCheckedState,
} from '@common/domUtils.js';
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
    this._handleDropdownToggle = this._handleDropdownToggle.bind(this);
    this._handleClickOutside = this._handleClickOutside.bind(this);
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
      addEventListenerSafely(
        this.container,
        'click',
        this._handleDropdownToggle,
        true,
      );
    }
    // Listen for clicks outside to close dropdown menus
    document.addEventListener('click', this._handleClickOutside, true);
  }

  /** @override */
  _disposeAdditionalListeners() {
    if (this.container) {
      this.container.removeEventListener('change', this._handleToggle, true);
      this.container.removeEventListener(
        'click',
        this._handleDropdownToggle,
        true,
      );
    }
    document.removeEventListener('click', this._handleClickOutside, true);
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
    const mainDiffButton = element.querySelector('.diff-main-button');
    const dropdownTrigger = element.querySelector('.diff-dropdown-trigger');
    const dropdownMenu = element.querySelector('.diff-dropdown-menu');
    const previewMenuItem = element.querySelector('.preview-menu-item');
    const latexdiffMenuItem = element.querySelector('.latexdiff-menu-item');
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
      setElementCheckedState(bypassButton, Boolean(this.isBypassActive));
    }

    if (mainDiffButton) {
      mainDiffButton.dataset.requestId = request.requestId;
    }

    // Show/hide dropdown trigger and set requestIds on menu items for LaTeX files
    if (dropdownTrigger) {
      dropdownTrigger.toggleAttribute('hidden', !request.isLatex);
      dropdownTrigger.setAttribute('aria-expanded', 'false');
    }
    if (dropdownMenu) {
      dropdownMenu.show = false;
      if (Array.isArray(dropdownMenu.data) && dropdownMenu.data.length === 0) {
        dropdownMenu.data = undefined;
        dropdownMenu.requestUpdate?.();
      }
    }
    if (previewMenuItem) {
      previewMenuItem.dataset.requestId = request.requestId;
    }
    if (latexdiffMenuItem) {
      latexdiffMenuItem.dataset.requestId = request.requestId;
    }
  }

  /** @private */
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

    const diffParts = [
      ...(added > 0 ? [`+${added}`] : []),
      ...(removed > 0 ? [`-${removed}`] : []),
    ];
    const tooltip =
      diffParts.length > 0
        ? `${diffParts.join(' / ')} ${lineLabel} changed`
        : 'No line changes';

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

    // Build final meta content
    metaElem.textContent = '';
    if (parts.length > 0) {
      metaElem.append(parts.join(' • '));
      if (diffContainer.childElementCount > 0) {
        metaElem.append(' • ');
      }
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

    const mappedAction = action === 'open' ? 'openDiff' : action;
    const validActions = new Set([
      'openDiff',
      'approve',
      'approveAll',
      'reject',
      'showLatexdiff',
      'previewProposed',
    ]);

    if (!validActions.has(mappedAction)) {
      return;
    }

    if (
      mappedAction === 'showLatexdiff' ||
      mappedAction === 'previewProposed'
    ) {
      this._closeAllDropdowns();
    }

    vscode.postMessage({
      command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId,
      action: mappedAction,
    });
  }

  /** @private */
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

  /** @private */
  _handleDropdownToggle(event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const trigger = event.target.closest('.diff-dropdown-trigger');
    if (!trigger) {
      return;
    }

    event.stopPropagation();

    const menu = trigger
      .closest('.diff-dropdown')
      ?.querySelector('.diff-dropdown-menu');
    if (!menu) {
      return;
    }

    const wasExpanded = trigger.getAttribute('aria-expanded') === 'true';
    this._closeAllDropdowns();

    if (!wasExpanded) {
      // Workaround: vscode-context-menu constructor sets _data=[] which prevents slot rendering.
      // See: node_modules/@vscode-elements/elements/dist/vscode-context-menu/vscode-context-menu.js
      // render() returns this.data ? data.map(...) : <slot>, so empty array skips slot.
      if (Array.isArray(menu.data) && menu.data.length === 0) {
        menu.data = undefined;
        menu.requestUpdate?.();
      }
      menu.show = true;
      trigger.setAttribute('aria-expanded', 'true');
    }
  }

  /** @private */
  _handleClickOutside(event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (!event.target.closest('.diff-dropdown')) {
      this._closeAllDropdowns();
    }
  }

  /** @private */
  _closeAllDropdowns() {
    if (!this.container) {
      return;
    }

    const triggers = this.container.querySelectorAll('.diff-dropdown-trigger');
    for (const trigger of triggers) {
      const dropdown = trigger.closest('.diff-dropdown');
      const menu = dropdown?.querySelector('.diff-dropdown-menu');
      if (menu) {
        menu.show = false;
      }
      trigger.setAttribute('aria-expanded', 'false');
    }
  }
}
