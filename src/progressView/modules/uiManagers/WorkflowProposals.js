// Local imports - progress view
import { COMMANDS } from '../constants.js';
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
    element.dataset.agentCategory = request.agentCategory || 'workflow';

    // Update category badge
    const categoryBadge = element.querySelector(
      '.workflow-proposal__category-badge',
    );
    if (categoryBadge) {
      const isToolUse = request.agentCategory === 'toolUse';
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

    // Combine singular + array fields for display
    const combine = (single, arr) => [single, ...(arr || [])].filter((f) => f);

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
        vscode.postMessage({ command: COMMANDS.OPEN_FILE, path: filePath });
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

    if (!['approve', 'reject', 'setup'].includes(action)) return;

    // Handle reject with feedback toggle
    if (action === 'reject') {
      const proposalElem = button.closest('.workflow-proposal');
      const feedbackSection = proposalElem?.querySelector(
        '.workflow-proposal__feedback',
      );
      const feedbackInput = feedbackSection?.querySelector(
        '.workflow-proposal__feedback-input',
      );

      if (feedbackSection && feedbackInput) {
        if (feedbackSection.hidden) {
          // First click: show feedback section
          feedbackSection.hidden = false;
          proposalElem.classList.add('workflow-proposal--feedback-active');
          button.textContent = 'Submit';
          button.title = 'Submit rejection with feedback';
          feedbackInput.focus();
          return;
        }
        // Second click: submit with feedback
        vscode.postMessage({
          command: COMMANDS.WORKFLOW_AGENT_PROPOSAL_ACTION,
          proposalId,
          action,
          feedback: feedbackInput.value?.trim() || undefined,
        });
        return;
      }
    }

    vscode.postMessage({
      command: COMMANDS.WORKFLOW_AGENT_PROPOSAL_ACTION,
      proposalId,
      action,
    });
  }
}
