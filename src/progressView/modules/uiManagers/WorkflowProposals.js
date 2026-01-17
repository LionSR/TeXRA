// Local imports - progress view
import { COMMANDS } from '../constants.js';
import { BaseUIRequestManager } from './BaseUIRequestManager.js';

// Local imports - common helpers
import { createFromTemplate } from '@common/templateUtils.js';
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
      const instruction = request.instruction || '';
      // Truncate long instructions for display
      const maxLen = 200;
      instructionElem.textContent =
        instruction.length > maxLen
          ? instruction.slice(0, maxLen) + '...'
          : instruction;
      instructionElem.title = instruction;
    }

    // Helper to format file list
    const formatFiles = (files, singular, plural) => {
      if (!files || files.length === 0) return null;
      const label = files.length === 1 ? singular : plural;
      return `${files.length} ${label}`;
    };

    // Helper to set file info element
    const setFileInfo = (elem, files, singular, plural) => {
      if (!elem) return;
      const text = formatFiles(files, singular, plural);
      if (text) {
        elem.textContent = text;
        elem.title = files.join('\n');
        elem.hidden = false;
      } else {
        elem.hidden = true;
      }
    };

    // Set all file info
    setFileInfo(
      inputFilesElem,
      request.inputFiles,
      'input file',
      'input files',
    );
    setFileInfo(
      referenceFilesElem,
      request.referenceFiles,
      'reference file',
      'reference files',
    );
    setFileInfo(
      auxiliaryFilesElem,
      request.auxiliaryFiles,
      'auxiliary file',
      'auxiliary files',
    );
    setFileInfo(mediaFilesElem, request.mediaFiles, 'media file', 'media files');
    setFileInfo(
      outputFilesElem,
      request.outputFiles,
      'output file',
      'output files',
    );
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

    const validActions = ['approve', 'reject'];
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
