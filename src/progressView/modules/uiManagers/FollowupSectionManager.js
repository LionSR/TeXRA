// Local imports - progress view
import { COMMANDS, ELEMENT_IDS } from '../constants.js';
import { progressViewState } from '../progressViewState.js';

// Local imports - common helpers
import {
  getRadioChangeValue,
  safeGetElementById,
  setRadioGroupValue,
  setVisibilityState,
} from '@common/domUtils.js';

/**
 * Manages the followup section for workflow task continuation.
 * Allows users to set up a followup task (workflow or merge) from completed workflow output.
 */
export class FollowupSectionManager {
  constructor(vscode) {
    this.vscode = vscode;
    // Mode is stored in progressViewState.streamFollowupMode (single source of truth)
    this._currentStreamData = null;
    this._listeners = [];
    this._workflowAgents = [];
    this._toolUseAgents = [];
  }

  /**
   * Get the current mode from the single source of truth.
   * @private
   * @returns {'chat' | 'workflow' | 'merge'} The current mode
   */
  _getMode() {
    const activeStream = progressViewState.activeStream;
    return activeStream
      ? progressViewState.streamFollowupMode.get(activeStream) || 'chat'
      : 'chat';
  }

  setup() {
    // Mode toggle - must wait for web component to be ready
    const modeGroup = safeGetElementById('followupModeGroup');
    if (modeGroup) {
      const attachModeListener = () => {
        // Extract value from the clicked radio element, not the group's .value property
        const modeHandler = (event) => {
          const mode = getRadioChangeValue(event, modeGroup);
          if (mode) {
            this._setMode(mode);
          }
        };
        modeGroup.addEventListener('change', modeHandler);
        this._listeners.push({
          element: modeGroup,
          event: 'change',
          handler: modeHandler,
        });
      };

      // Wait for Lit web component to be ready if needed
      if (modeGroup.updateComplete) {
        modeGroup.updateComplete.then(attachModeListener);
      } else {
        attachModeListener();
      }
    }

    // Initialize data-mode attribute (don't touch radio group yet - HTML has checked attribute)
    const section = safeGetElementById(ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE);
    const followupSection = section?.querySelector('.followup-section');
    if (followupSection) {
      followupSection.dataset.mode = 'chat';
    }

    // Setup button - sends config to main view for review
    const setupBtn = safeGetElementById(ELEMENT_IDS.FOLLOWUP_SETUP_BTN);
    if (setupBtn) {
      const setupHandler = () => this._sendFollowup(COMMANDS.SETUP_FOLLOWUP);
      setupBtn.addEventListener('click', setupHandler);
      this._listeners.push({
        element: setupBtn,
        event: 'click',
        handler: setupHandler,
      });
    }

    // Run button - executes followup immediately
    const runBtn = safeGetElementById(ELEMENT_IDS.FOLLOWUP_RUN_BTN);
    if (runBtn) {
      const runHandler = () => this._sendFollowup(COMMANDS.RUN_FOLLOWUP);
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
          // Sync radio group when first opened (ensures visual state matches)
          this._syncRadioGroup();
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
   * Sync the radio group visual state with the stored mode.
   * Called when section becomes visible to ensure proper rendering.
   * @private
   */
  _syncRadioGroup() {
    const modeGroup = safeGetElementById('followupModeGroup');
    if (modeGroup) {
      // Use requestAnimationFrame to ensure DOM has rendered
      requestAnimationFrame(() => {
        setRadioGroupValue(modeGroup, this._getMode());
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
   * Shows the section for completed workflow or tool-use streams with output files.
   * @param {Object} streamData - The stream data
   */
  updateForStream(streamData) {
    this._currentStreamData = streamData;
    const collapsible = safeGetElementById(ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE);

    // Show for workflow streams that have generated files
    const isValidCategory = streamData?.agentCategory === 'workflow';
    const shouldShow =
      isValidCategory &&
      streamData?.status === 'stopped' &&
      streamData?.hasOutputFiles;

    setVisibilityState(collapsible, shouldShow);

    if (shouldShow) {
      this._requestFollowupOptions();
      // Update UI to match the stored mode (reads from single source of truth)
      this._applyModeToUI(this._getMode());
      this._syncRadioGroup();
    }
  }

  /**
   * Set the available agent and model options.
   * Called when receiving options from the extension.
   * @param {Object} options - { workflowAgents: string[], toolUseAgents: string[], models: string[], defaultMergeModel: string }
   */
  setOptions(options) {
    const {
      workflowAgents = [],
      toolUseAgents = [],
      models = [],
      defaultMergeModel,
    } = options ?? {};

    // Store both agent lists for mode switching
    this._workflowAgents = workflowAgents;
    this._toolUseAgents = toolUseAgents;

    // Update agent dropdown based on current mode
    this._updateAgentDropdown();

    // Update model dropdown
    const modelSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_MODEL);
    if (modelSelect) {
      const currentValue = modelSelect.value;
      // Use current stream's model as default, or defaultMergeModel for merge mode
      const defaultModel =
        this._getMode() === 'merge'
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
   * Update the agent dropdown based on the current mode.
   * Chat mode shows tool-use agents; workflow mode shows workflow agents.
   * @private
   */
  _updateAgentDropdown() {
    const agentSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_AGENT);
    if (!agentSelect) return;

    // Select the appropriate agent list based on mode
    const agents =
      this._getMode() === 'chat' ? this._toolUseAgents : this._workflowAgents;

    // Clear dropdown if no agents available for this mode
    if (!agents || agents.length === 0) {
      agentSelect.innerHTML = '';
      return;
    }

    // Preserve current selection if valid in the new list
    const currentValue = agentSelect.value;
    const isCurrentValid = agents.includes(currentValue);

    agentSelect.innerHTML = agents
      .map((agent) => {
        // Extract display name from source:name format
        const displayName = agent.includes(':') ? agent.split(':')[1] : agent;
        const isSelected = isCurrentValid && agent === currentValue;
        return `<vscode-option value="${agent}"${isSelected ? ' selected' : ''}>${displayName}</vscode-option>`;
      })
      .join('');
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
   * Set the mode (chat, workflow, or merge) and update UI.
   * Stores mode in progressViewState (single source of truth) and updates UI.
   * @private
   * @param {string} mode - The mode to set
   */
  _setMode(mode) {
    // Store in single source of truth
    const activeStream = progressViewState.activeStream;
    if (activeStream) {
      progressViewState.streamFollowupMode.set(activeStream, mode);
    }

    // Update UI to reflect the new mode
    this._applyModeToUI(mode);
  }

  /**
   * Apply mode to UI elements without modifying state.
   * Used both when setting a new mode and when restoring from state.
   * @private
   * @param {string} mode - The mode to apply
   */
  _applyModeToUI(mode) {
    // Sync radio group visual state
    const modeGroup = safeGetElementById('followupModeGroup');
    if (modeGroup) {
      setRadioGroupValue(modeGroup, mode);
    }

    // Set data-mode attribute on the section - CSS uses this for visibility
    const section = safeGetElementById(ELEMENT_IDS.FOLLOWUP_COLLAPSIBLE);
    const followupSection = section?.querySelector('.followup-section');
    if (followupSection) {
      followupSection.dataset.mode = mode;
    }

    // Update agent dropdown to show appropriate agents for this mode
    this._updateAgentDropdown();

    // Update model default for merge mode
    if (mode === 'merge' && this._defaultMergeModel) {
      const modelSelect = safeGetElementById(ELEMENT_IDS.FOLLOWUP_MODEL);
      if (modelSelect) {
        modelSelect.value = this._defaultMergeModel;
      }
    }
  }

  /**
   * Send a followup command with the current payload.
   * @private
   * @param {string} command - The command to send (SETUP_FOLLOWUP or RUN_FOLLOWUP)
   */
  _sendFollowup(command) {
    const payload = this._buildFollowupPayload();
    if (payload) {
      this.vscode.postMessage({ command, ...payload });
    }
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
    const initialQuestionTextarea = safeGetElementById(
      ELEMENT_IDS.FOLLOWUP_INITIAL_QUESTION,
    );

    const mode = this._getMode();
    const agent = mode === 'merge' ? 'merge' : agentSelect?.value;
    const model = modelSelect?.value;
    const includeInstruction =
      mode === 'workflow' && includeInstructionCheckbox?.checked;
    const initialQuestion = initialQuestionTextarea?.value?.trim() || '';

    if (!agent) {
      console.warn('[FollowupSectionManager] No agent selected');
      return null;
    }

    if (!model) {
      console.warn('[FollowupSectionManager] No model selected');
      return null;
    }

    // Include workflow context for display in main webview instruction
    const { agentName, instructionPreview, fileCount } =
      this._currentStreamData || {};

    return {
      stream,
      mode,
      agent,
      model,
      includeInstruction,
      initialQuestion,
      // Workflow context - passed to main webview for instruction display
      workflowContext: {
        agentName,
        instructionPreview,
        fileCount,
      },
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
