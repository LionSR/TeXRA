// Local imports - progress view
import {
  COMMANDS,
  AGENT_PROPOSAL_ACTIONS,
  AGENT_PROPOSAL_CATEGORIES,
} from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { createFromTemplate } from '@common/templateUtils.js';
import { getBasename } from '@common/pathUtils.js';
import { vscode } from '@common/webviewContext.js';

/** Manages workflow agent proposal popups for user approval. */
export class WorkflowProposals extends BaseUIRequestManager {
  constructor() {
    super({
      containerId: 'workflowProposals',
      listSelector: '.workflow-proposals__list',
      idAttribute: 'proposalId',
      requireToolAgent: true,
    });
  }

  _getFeedbackConfig() {
    return {
      containerClass: 'workflow-proposal',
      feedbackClass: 'workflow-proposal__feedback',
      inputClass: 'workflow-proposal__feedback-input',
      activeClass: 'workflow-proposal--feedback-active',
    };
  }

  _createRequestElement(request) {
    const element = createFromTemplate('workflowProposalTemplate');
    if (!element) {
      console.error('WorkflowProposals: template not found');
      return document.createElement('div');
    }

    element.dataset.proposalId = request.proposalId;
    element.querySelectorAll('[data-action]').forEach((btn) => {
      btn.dataset.proposalId = request.proposalId;
    });

    this._updateRequestElement(element, request);
    return element;
  }

  _updateRequestElement(element, request) {
    element.dataset.streamId = request.streamId || '';
    element.dataset.proposalId = request.proposalId || '';
    element.dataset.agentCategory =
      request.agentCategory || AGENT_PROPOSAL_CATEGORIES.WORKFLOW;

    const isToolUse =
      request.agentCategory === AGENT_PROPOSAL_CATEGORIES.TOOL_USE;

    // Update category badge
    const categoryBadge = element.querySelector(
      '.workflow-proposal__category-badge',
    );
    if (categoryBadge) {
      categoryBadge.textContent = isToolUse ? 'Tool-Use' : 'Workflow';
      categoryBadge.className = `workflow-proposal__category-badge workflow-proposal__category-badge--${isToolUse ? 'tool-use' : 'workflow'}`;
    }

    this._setText(
      element,
      '.workflow-proposal__agent',
      request.agent || 'Unknown agent',
    );
    this._setText(element, '.workflow-proposal__model', request.model || '');
    this._setText(
      element,
      '.workflow-proposal__instruction',
      request.instruction || '',
    );

    // File fields only exist for workflow agent proposals (agentCategory === 'workflow')
    // Tool-use agent proposals access files via their own tools (read_file, etc.)
    // The schema enforces this - tool-use proposals simply don't have file fields
    const combine = (single, arr) => [single, ...(arr ?? [])].filter(Boolean);

    this._setFileInfo(
      element,
      '.workflow-proposal__input-files',
      combine(request.inputFile, request.inputFiles),
      'Input',
    );
    this._setFileInfo(
      element,
      '.workflow-proposal__reference-files',
      combine(request.referenceFile, request.referenceFiles),
      'Reference',
    );
    this._setFileInfo(
      element,
      '.workflow-proposal__auxiliary-files',
      combine(request.auxiliaryFile, request.auxiliaryFiles),
      'Auxiliary',
    );
    this._setFileInfo(
      element,
      '.workflow-proposal__media-files',
      combine(request.mediaFile, request.mediaFiles),
      'Media',
    );
    this._setFileInfo(
      element,
      '.workflow-proposal__output-files',
      request.outputFiles,
      'Output',
    );
  }

  _setText(parent, selector, text) {
    const elem = parent.querySelector(selector);
    if (elem) elem.textContent = text;
  }

  _setFileInfo(parent, selector, files, label) {
    const elem = parent.querySelector(selector);
    if (!elem) return;

    if (!files || files.length === 0) {
      elem.hidden = true;
      return;
    }

    elem.innerHTML = '';
    const labelSpan = document.createElement('span');
    labelSpan.className = 'workflow-proposal__file-label';
    labelSpan.textContent = `${label}: `;
    elem.appendChild(labelSpan);

    files.forEach((filePath, i) => {
      if (i > 0) elem.appendChild(document.createTextNode(', '));

      const fileSpan = document.createElement('span');
      fileSpan.className = 'workflow-proposal__file-name';
      fileSpan.textContent = getBasename(filePath);
      fileSpan.title = filePath;
      fileSpan.dataset.filePath = filePath;
      fileSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ command: COMMANDS.OPEN_FILE, file: filePath });
      });
      elem.appendChild(fileSpan);
    });

    elem.hidden = false;
  }

  _handleAction(event) {
    if (!(event.target instanceof Element)) return;

    const button = event.target.closest('[data-proposal-id][data-action]');
    if (!button) return;

    const { proposalId, action } = button.dataset;
    if (!proposalId || !action) return;

    if (!AGENT_PROPOSAL_ACTIONS.includes(action)) return;

    // Handle reject with feedback toggle (uses shared base class logic)
    if (action === 'reject') {
      const handled = this._handleRejectWithFeedback(
        button,
        proposalId,
        COMMANDS.AGENT_PROPOSAL_ACTION,
        'proposalId',
      );
      if (handled) return;
    }

    vscode.postMessage({
      command: COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId,
      action,
    });
  }
}
