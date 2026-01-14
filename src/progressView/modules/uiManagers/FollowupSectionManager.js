// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';

// Local imports - common helpers
import { safeGetElementById, setVisibilityState } from '@common/domUtils.js';

/**
 * Manages the followup section for workflow task continuation.
 * Allows users to set up a followup task (workflow or merge) from completed workflow output.
 */
export class FollowupSectionManager {
  constructor(vscode) {
    this.vscode = vscode;
    this._mode = 'workflow';
    this._currentStreamData = null;
    this._listeners = [];
  }

  setup() {
    // Mode toggle
    const modeGroup = safeGetElementById('followupModeGroup');
    if (modeGroup) {
      const modeHandler = (e) => this._setMode(e.target.value);
      modeGroup.addEventListener('change', modeHandler);
      this._listeners.push({
        element: modeGroup,
        event: 'change',
        handler: modeHandler,
      });
    }

    // Setup button
    const setupBtn = safeGetElementById(ELEMENT_IDS.FOLLOWUP_SETUP_BTN);
    if (setupBtn) {
      const setupHandler = () => this._handleSetup();
      setupBtn.addEventListener('click', setupHandler);
      this._listeners.push({
        element: setupBtn,
        event: 'click',
        handler: setupHandler,
      });
    }

    // Run button
    const runBtn = safeGetElementById(ELEMENT_IDS.FOLLOWUP_RUN_BTN);
    if (runBtn) {
      const runHandler = () => this._handleRun();
      runBtn.addEventListener('click', runHandler);
      this._listeners.push({
        element: runBtn,
        event: 'click',
        handler: runHandler,
      });
    }

    // Request followup options when section becomes visible
    const collapsible = safeGetElementById(ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE);
    if (collapsible) {
      const toggleHandler = (e) => {
        if (e.target.open) {
          this._requestFollowupOptions();
        }
      };
      collapsible.addEventListener('toggle', toggleHandler);
      this._listeners.push({
        element: collapsible,
        event: 'toggle',
        handler: toggleHandler,
      });
    }
  }

  /**
   * Clean up event listeners to prevent memory leaks.
   */
  dispose() {
    for (const { element, event, handler } of this._listeners) {
      element.removeEventListener(event, handler);
    }
    this._listeners = [];
    this._currentStreamData = null;
  }

  /**
   * Update the followup section visibility based on stream data.
   * Shows the section only for completed workflow streams with output files.
   * @param {Object} streamData - The stream data
   */
  updateForStream(streamData) {
    this._currentStreamData = streamData;
    const collapsible = safeGetElementById(ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE);

    // Only show for workflow streams that have generated files
    const shouldShow =
      streamData?.agentCategory === 'workflow' &&
      streamData?.status === 'stopped' &&
      streamData?.hasOutputFiles;

    setVisibilityState(collapsible, shouldShow);

    if (shouldShow) {
      this._requestFollowupOptions();
    }
  }

  /**
   * Set the available agent and model options.
   * Called when receiving options from the extension.
   * @param {Object} options - { agents: string[], models: string[], defaultMergeModel: string }
   */
  setOptions(options) {
    const { agents = [], models = [], defaultMergeModel } = options;

    // Update agent dropdown
    const agentSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_AGENT);
    if (agentSelect) {
      // Preserve current selection if valid
      const currentValue = agentSelect.value;
      agentSelect.innerHTML = agents
        .map(
          (agent) =>
            `<vscode-option value="${agent}"${agent === currentValue ? ' selected' : ''}>${agent}</vscode-option>`,
        )
        .join('');
    }

    // Update model dropdown
    const modelSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_MODEL);
    if (modelSelect) {
      const currentValue = modelSelect.value;
      // Use current stream's model as default, or defaultMergeModel for merge mode
      const defaultModel =
        this._mode === 'merge'
          ? defaultMergeModel
          : this._currentStreamData?.model || currentValue;

      modelSelect.innerHTML = models
        .map(
          (model) =>
            `<vscode-option value="${model}"${model === defaultModel ? ' selected' : ''}>${model}</vscode-option>`,
        )
        .join('');
    }

    this._defaultMergeModel = defaultMergeModel;
  }

  /**
   * Request followup options from the extension.
   * @private
   */
  _requestFollowupOptions() {
    const stream = progressViewState.activeStream;
    if (!stream) return;

    this.vscode.postMessage({
      command: COMMANDS.GET_FOLLOWUP_OPTIONS,
      stream,
    });
  }

  /**
   * Set the mode (workflow or merge) and update UI.
   * @private
   */
  _setMode(mode) {
    this._mode = mode;
    const section = safeGetElementById(ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE);
    const followupSection = section?.querySelector('.followup-section');
    if (followupSection) {
      followupSection.dataset.mode = mode;
    }

    // Update agent select visibility
    const agentSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_AGENT);
    const agentGroup = agentSelect?.closest('.followup-select-group');
    if (agentGroup) {
      agentGroup.style.display = mode === 'merge' ? 'none' : '';
    }

    // Update model default for merge mode
    if (mode === 'merge' && this._defaultMergeModel) {
      const modelSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_MODEL);
      if (modelSelect) {
        modelSelect.value = this._defaultMergeModel;
      }
    }

    // Update instruction checkbox visibility (hide for merge)
    const instructionCheckbox = safeGetElementById(
      ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION,
    );
    if (instructionCheckbox) {
      const optionsDiv = instructionCheckbox.closest('.followup-options');
      if (optionsDiv) {
        optionsDiv.style.display = mode === 'merge' ? 'none' : '';
      }
    }
  }

  /**
   * Handle the Setup button click.
   * Sends message to set up the followup task in the main view.
   * @private
   */
  _handleSetup() {
    const payload = this._buildFollowupPayload();
    if (!payload) return;

    this.vscode.postMessage({
      command: COMMANDS.SETUP_FOLLOWUP,
      ...payload,
    });
  }

  /**
   * Handle the Run button click.
   * Sends message to run the followup task immediately.
   * @private
   */
  _handleRun() {
    const payload = this._buildFollowupPayload();
    if (!payload) return;

    this.vscode.postMessage({
      command: COMMANDS.RUN_FOLLOWUP,
      ...payload,
    });
  }

  /**
   * Build the followup payload from current UI state.
   * @private
   * @returns {Object|null} The followup payload or null if invalid
   */
  _buildFollowupPayload() {
    const stream = progressViewState.activeStream;
    if (!stream) {
      console.warn('[FollowupSectionManager] No active stream');
      return null;
    }

    const agentSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_AGENT);
    const modelSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_MODEL);
    const includeInstructionCheckbox = safeGetElementById(
      ELEMENT_IDS.FOLLOWUP_INCLUDE_INSTRUCTION,
    );

    const mode = this._mode;
    const agent = mode === 'merge' ? 'merge' : agentSelect?.value;
    const model = modelSelect?.value;
    const includeInstruction =
      mode !== 'merge' && includeInstructionCheckbox?.checked;

    if (!agent) {
      console.warn('[FollowupSectionManager] No agent selected');
      return null;
    }

    if (!model) {
      console.warn('[FollowupSectionManager] No model selected');
      return null;
    }

    return {
      stream,
      mode,
      agent,
      model,
      includeInstruction,
    };
  }

  /**
   * Hide the followup section.
   */
  hide() {
    const collapsible = safeGetElementById(ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE);
    setVisibilityState(collapsible, false);
  }

  /**
   * Clear the followup section state.
   */
  clear() {
    this._currentStreamData = null;
    this.hide();
  }
}
