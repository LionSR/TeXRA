// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { createFromTemplate } from '@common/templateUtils.js';
import { getBasename } from '@common/pathUtils.js';
import { vscode } from '@common/webviewContext.js';

/**
 * Manages workflow agent proposal popups.
 * Shows proposals for workflow agent executions awaiting user approval.
 * @extends BaseUIRequestManager
 */
export class WorkflowProposals extends BaseUIRequestManager {
  constructor() {
    super({
      containerId: 'workflowProposals',
      listSelector: '.workflow-proposals__list',
      idAttribute: 'proposalId',
      requireToolAgent: true, // Only show for tool-use agent streams
    });
  }

  /** @override */
  _createRequestElement(request) {
    const element = createFromTemplate('workflowProposalTemplate');
    if (!element) {
      console.error('WorkflowProposals: workflowProposalTemplate not found');
      return document.createElement('div');
    }

    // Set proposal ID on element and all action buttons
    element.dataset.proposalId = request.proposalId;
    element.querySelectorAll('[data-action]').forEach((btn) => {
      btn.dataset.proposalId = request.proposalId;
    });

    this._updateRequestElement(element, request);
    return element;
  }

  /** @override */
  _updateRequestElement(element, request) {
    const agentElem = element.querySelector('.workflow-proposal__agent');
    const modelElem = element.querySelector('.workflow-proposal__model');
    const instructionElem = element.querySelector(
      '.workflow-proposal__instruction',
    );
    const inputFilesElem = element.querySelector(
      '.workflow-proposal__input-files',
    );
    const referenceFilesElem = element.querySelector(
      '.workflow-proposal__reference-files',
    );
    const auxiliaryFilesElem = element.querySelector(
      '.workflow-proposal__auxiliary-files',
    );
    const mediaFilesElem = element.querySelector(
      '.workflow-proposal__media-files',
    );
    const outputFilesElem = element.querySelector(
      '.workflow-proposal__output-files',
    );

    element.dataset.streamId = request.streamId || '';
    element.dataset.proposalId = request.proposalId || '';

    if (agentElem) {
      agentElem.textContent = request.agent || 'Unknown agent';
    }

    if (modelElem) {
      modelElem.textContent = request.model || '';
    }

    if (instructionElem) {
      // Show full instruction without truncation
      instructionElem.textContent = request.instruction || '';
    }

    // Helper to format file list with names
    const formatFileList = (files, label) => {
      if (!files || files.length === 0) return null;
      const names = files.map((f) => getBasename(f));
      return { label, names, fullPaths: files };
    };

    // Helper to set file info element with names
    const setFileInfo = (elem, files, label) => {
      if (!elem) return;
      const info = formatFileList(files, label);
      if (info) {
        // Create label and file list
        elem.innerHTML = '';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'workflow-proposal__file-label';
        labelSpan.textContent = `${info.label}: `;
        elem.appendChild(labelSpan);

        info.names.forEach((name, i) => {
          if (i > 0) {
            elem.appendChild(document.createTextNode(', '));
          }
          const fileSpan = document.createElement('span');
          fileSpan.className = 'workflow-proposal__file-name';
          fileSpan.textContent = name;
          fileSpan.title = info.fullPaths[i];
          elem.appendChild(fileSpan);
        });

        elem.hidden = false;
      } else {
        elem.hidden = true;
      }
    };

    // Set all file info with names
    setFileInfo(inputFilesElem, request.inputFiles, 'Input');
    setFileInfo(referenceFilesElem, request.referenceFiles, 'Reference');
    setFileInfo(auxiliaryFilesElem, request.auxiliaryFiles, 'Auxiliary');
    setFileInfo(mediaFilesElem, request.mediaFiles, 'Media');
    setFileInfo(outputFilesElem, request.outputFiles, 'Output');
  }

  /** @override */
  _handleAction(event) {
    if (!(event.target instanceof Element)) {
      return;
    }
    const button = event.target.closest('[data-proposal-id][data-action]');
    if (!button) {
      return;
    }

    const proposalId = button.dataset.proposalId;
    const action = button.dataset.action;
    if (!proposalId || !action) {
      return;
    }

    const validActions = ['approve', 'reject', 'setup'];
    if (!validActions.includes(action)) {
      return;
    }

    vscode.postMessage({
      command: COMMANDS.WORKFLOW_AGENT_PROPOSAL_ACTION,
      proposalId,
      action,
    });
  }
}
