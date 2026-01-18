// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { addEventListenerSafely } from '@common/domUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';
import { vscode } from '@common/webviewContext.js';

/** Manages approval request popups for tool edits. */
export class ApprovalRequests extends BaseUIRequestManager {
  constructor() {
    super({
      containerId: 'approvalRequests',
      listSelector: '.approval-requests__list',
      idAttribute: 'requestId',
    });
    this._handleToggle = this._handleToggle.bind(this);
    this._handleDropdownToggle = this._handleDropdownToggle.bind(this);
    this._handleClickOutside = this._handleClickOutside.bind(this);
    this._handleMenuItemClick = this._handleMenuItemClick.bind(this);
  }

  _getFeedbackConfig() {
    return {
      containerClass: 'approval-request',
      feedbackClass: 'approval-request__feedback',
      inputClass: 'approval-request__feedback-input',
      activeClass: 'approval-request--feedback-active',
    };
  }

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
      addEventListenerSafely(
        this.container,
        'vsc-click',
        this._handleMenuItemClick,
        true,
      );
    }
    // Listen for clicks outside to close dropdown menus
    document.addEventListener('click', this._handleClickOutside, true);
  }

  _disposeAdditionalListeners() {
    if (this.container) {
      this.container.removeEventListener('change', this._handleToggle, true);
      this.container.removeEventListener(
        'click',
        this._handleDropdownToggle,
        true,
      );
      this.container.removeEventListener(
        'vsc-click',
        this._handleMenuItemClick,
        true,
      );
    }
    document.removeEventListener('click', this._handleClickOutside, true);
  }

  _createRequestElement(request) {
    const element = createFromTemplate('approvalRequestTemplate');
    if (!element) {
      console.error('ApprovalRequests: template not found');
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
    const pathElem = element.querySelector('.approval-request__path');
    const metaElem = element.querySelector('.approval-request__meta');
    const mainDiffButton = element.querySelector('.diff-main-button');
    const dropdownTrigger = element.querySelector('.diff-dropdown-trigger');
    const dropdownMenu = element.querySelector('.diff-dropdown-menu');
    const previewMenuItem = element.querySelector(
      'vscode-context-menu-item[value="previewProposed"]',
    );
    const latexdiffMenuItem = element.querySelector(
      'vscode-context-menu-item[value="showLatexdiff"]',
    );
    element.dataset.streamId = request.streamId || '';

    if (pathElem) {
      pathElem.textContent = request.relativePath || request.path || '';
    }

    if (metaElem) {
      this._updateMetaElement(metaElem, request);
    }

    // Set requestId on all diff-related elements
    this._setRequestId(
      [mainDiffButton, previewMenuItem, latexdiffMenuItem],
      request.requestId,
    );

    // Show/hide dropdown trigger for LaTeX files
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
  }

  _updateMetaElement(metaElem, request) {
    const toCount = (v) => (Number.isFinite(v) ? Math.max(0, v) : 0);
    const added = toCount(request.addedLines);
    const removed = toCount(request.removedLines);
    const total = added + removed;
    const lineLabel = total === 1 ? 'line' : 'lines';

    const diffParts = [
      added > 0 && `+${added}`,
      removed > 0 && `-${removed}`,
    ].filter(Boolean);
    const tooltip =
      diffParts.length > 0
        ? `${diffParts.join(' / ')} ${lineLabel} changed`
        : 'No line changes';

    const diffContainer = document.createElement('span');
    diffContainer.className = 'approval-request__diff';
    diffContainer.title = tooltip;

    const appendSpan = (className, text) => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      diffContainer.appendChild(span);
    };

    if (added > 0) appendSpan('approval-request__diff-added', `+${added}`);
    if (removed > 0)
      appendSpan('approval-request__diff-removed', `-${removed}`);
    appendSpan('approval-request__diff-label', `${total} ${lineLabel}`);

    // Build final meta content
    metaElem.textContent = '';
    if (request.sourceTool) {
      metaElem.append(`Requested by ${request.sourceTool}`);
      if (diffContainer.childElementCount > 0) metaElem.append(' • ');
    }
    metaElem.appendChild(diffContainer);
  }

  _handleAction(event) {
    if (!(event.target instanceof Element)) return;

    const button = event.target.closest('[data-request-id][data-action]');
    if (!button || button.hasAttribute('data-toggle-action')) return;

    const { requestId, action } = button.dataset;
    if (!requestId || !action) return;

    // Handle reject with feedback toggle (uses shared base class logic)
    if (action === 'reject') {
      const handled = this._handleRejectWithFeedback(
        button,
        requestId,
        COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
        'requestId',
      );
      if (handled) return;
    }

    this._dispatchApprovalAction(requestId, action);
  }

  _handleToggle(event) {
    if (!(event.target instanceof Element)) return;

    const button = event.target.closest(
      '[data-request-id][data-action][data-toggle-action]',
    );
    if (!button) return;

    const { requestId } = button.dataset;
    if (!requestId) return;

    const action = button.checked
      ? button.dataset.action
      : button.dataset.toggleAction;
    if (!action) return;

    vscode.postMessage({
      command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId,
      action,
    });
  }

  _handleDropdownToggle(event) {
    if (!(event.target instanceof Element)) return;

    const trigger = event.target.closest('.diff-dropdown-trigger');
    if (!trigger) return;

    event.stopPropagation();

    const menu = trigger
      .closest('.diff-dropdown')
      ?.querySelector('.diff-dropdown-menu');
    if (!menu) return;

    const wasExpanded = trigger.getAttribute('aria-expanded') === 'true';
    this._closeAllDropdowns();

    if (!wasExpanded) {
      // Workaround: vscode-context-menu sets _data=[] which prevents slot rendering
      if (Array.isArray(menu.data) && menu.data.length === 0) {
        menu.data = undefined;
        menu.requestUpdate?.();
      }
      menu.show = true;
      trigger.setAttribute('aria-expanded', 'true');
    }
  }

  _handleClickOutside(event) {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('.diff-dropdown')) {
      this._closeAllDropdowns();
    }
  }

  _closeAllDropdowns() {
    if (!this.container) return;

    for (const trigger of this.container.querySelectorAll(
      '.diff-dropdown-trigger',
    )) {
      const menu = trigger
        .closest('.diff-dropdown')
        ?.querySelector('.diff-dropdown-menu');
      if (menu) menu.show = false;
      trigger.setAttribute('aria-expanded', 'false');
    }
  }

  _handleMenuItemClick(event) {
    const menuItem = this._getMenuItemFromEvent(event);
    if (!menuItem) return;

    const action = event.detail?.value ?? menuItem.getAttribute('value');
    const { requestId } = menuItem.dataset;
    if (!action || !requestId) return;

    this._dispatchApprovalAction(requestId, action, { closeDropdown: true });
  }

  _dispatchApprovalAction(requestId, action, options = {}) {
    const mappedAction = action === 'open' ? 'openDiff' : action;
    const validActions = [
      'openDiff',
      'approve',
      'reject',
      'showLatexdiff',
      'previewProposed',
    ];
    if (!validActions.includes(mappedAction)) return false;

    if (options.closeDropdown) this._closeAllDropdowns();

    vscode.postMessage({
      command: COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId,
      action: mappedAction,
    });
    return true;
  }

  _getMenuItemFromEvent(event) {
    if (!(event.target instanceof Element)) return null;

    const targetItem = event.target.closest('vscode-context-menu-item');
    if (targetItem) return targetItem;

    for (const entry of event.composedPath?.() ?? []) {
      if (entry instanceof Element) {
        const menuItem = entry.closest?.('vscode-context-menu-item');
        if (menuItem) return menuItem;
      }
    }
    return null;
  }

  _setRequestId(elements, requestId) {
    elements.forEach((el) => el && (el.dataset.requestId = requestId));
  }
}
