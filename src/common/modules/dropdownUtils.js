/**
 * Shared dropdown utilities for agent and model options.
 * Used by main webview and progress view for consistent dropdown rendering.
 */

import {
  AGENT_DECORATORS,
  getModelProviderDecorator,
} from './iconConstants.js';
import {
  isSelectLikeElement,
  getSelectOptionElements,
  getSelectedOptionElement,
} from './domUtils.js';

// =============================================================================
// PLACEHOLDER OPTIONS
// =============================================================================

/** Placeholder option for agent dropdowns */
export const AGENT_PLACEHOLDER =
  '<vscode-option value="">Select agent</vscode-option>';

/** Placeholder option for model dropdowns */
export const MODEL_PLACEHOLDER =
  '<vscode-option value="">Select model</vscode-option>';

/**
 * Prepend placeholder to options HTML.
 * @param {string} optionsHtml - The options HTML
 * @param {string} placeholder - The placeholder HTML
 * @returns {string} Combined HTML
 */
export function withPlaceholder(optionsHtml, placeholder) {
  return placeholder + '\n' + optionsHtml;
}

// =============================================================================
// AGENT OPTION DECORATION
// =============================================================================

/**
 * Read agent option metadata from data attributes.
 * @param {HTMLElement} opt - The option element
 * @returns {{ label: string, isMultiple: boolean, isToolUse: boolean, isRemote: boolean, isCustom: boolean, description: string }}
 */
export function readAgentOptionMetadata(opt) {
  const data = opt.dataset;
  // Fallback chain: dataset.label > textContent > value attribute
  const label =
    data.label || opt.textContent?.trim() || opt.getAttribute('value') || '';
  // Cache resolved label for subsequent reads
  if (label && !data.label) {
    opt.dataset.label = label;
  }
  return {
    label,
    isMultiple: data.multiple === 'true',
    isToolUse: data.toolUse === 'true',
    isRemote: data.remote === 'true',
    isCustom: data.custom === 'true',
    description: data.description || '',
  };
}

/**
 * Decorate a single agent option element with icons and tooltips.
 * @param {HTMLElement} opt - The option element
 */
export function decorateAgentOption(opt) {
  const { label, isMultiple, isToolUse, isRemote, isCustom, description } =
    readAgentOptionMetadata(opt);

  const hints = [];
  let displayLabel = label;

  // Add cloud icon for remote agents (visible indicator, at end)
  if (isRemote) {
    hints.push(AGENT_DECORATORS.properties.remote.hint);
  }

  // Add custom hint to tooltip (no unicode icon - too confusing)
  if (isCustom) {
    const { hint } = AGENT_DECORATORS.properties.custom;
    hints.push(hint);
  }

  // Add description (primary info about the agent)
  if (description) {
    hints.push(description);
  }

  // Add multiple outputs hint
  if (isMultiple) {
    hints.push(AGENT_DECORATORS.properties.multipleOutputs.hint);
    opt.style.opacity = '0.9';
  } else {
    opt.style.opacity = '';
  }

  // Add tool-use hint
  if (isToolUse) {
    hints.push('Can execute tools and code');
  }

  // Set text content first, then append icon spans with fixed width
  opt.textContent = displayLabel;

  // Append icons as spans with consistent sizing (order: multiple, remote)
  if (isMultiple) {
    const span = document.createElement('span');
    span.className = 'agent-icon';
    span.textContent = ` ${AGENT_DECORATORS.properties.multipleOutputs.unicode}`;
    opt.appendChild(span);
  }
  if (isRemote) {
    const span = document.createElement('span');
    span.className = 'agent-icon';
    span.textContent = ` ${AGENT_DECORATORS.properties.remote.unicode}`;
    opt.appendChild(span);
  }

  if (hints.length > 0) {
    opt.title = hints.join('\n');
    opt.setAttribute('aria-label', `${label} (${hints.join(', ')})`);
    opt.setAttribute('aria-description', hints.join(' '));
  } else {
    // Clear stale attributes when no hints
    opt.removeAttribute('title');
    opt.setAttribute('aria-label', label);
    opt.removeAttribute('aria-description');
  }
}

/**
 * Decorate all agent options in a select element.
 * @param {HTMLElement} selectElement - The select element
 */
export function decorateAgentOptions(selectElement) {
  if (!isSelectLikeElement(selectElement)) return;
  getSelectOptionElements(selectElement).forEach((opt) => {
    decorateAgentOption(opt);
  });
}

/**
 * Update the agent select element's tooltip to show the selected agent's details.
 * @param {HTMLElement} selectElement - The agent select element
 */
export function updateAgentSelectTooltip(selectElement) {
  if (!isSelectLikeElement(selectElement)) return;

  const selectedOption = getSelectedOptionElement(selectElement);
  if (selectedOption && selectedOption.title) {
    selectElement.title = selectedOption.title;
  } else if (selectedOption) {
    const label =
      selectedOption.dataset?.label || selectedOption.textContent || '';
    selectElement.title = label;
  } else {
    selectElement.title = '';
  }
}

// =============================================================================
// MODEL OPTION DECORATION
// =============================================================================

/**
 * Read model option metadata from data attributes.
 * @param {HTMLElement} opt - The option element
 * @returns {{ provider: string, context: string, cost: string, requiresKey: boolean, modelName: string }}
 */
export function readModelOptionMetadata(opt) {
  const data = opt.dataset;
  return {
    provider: data.provider || '',
    context: data.context || '',
    cost: data.cost || '',
    requiresKey: data.requiresKey === 'true',
    modelName: opt.textContent?.trim() || opt.getAttribute('value') || '',
  };
}

/**
 * Decorate a single model option element with provider icon and tooltips.
 * @param {HTMLElement} opt - The option element
 */
export function decorateModelOption(opt) {
  const { provider, context, cost, requiresKey, modelName } =
    readModelOptionMetadata(opt);

  // Get provider decorator for the icon
  const decorator = provider
    ? getModelProviderDecorator(provider)
    : { unicode: '', label: '', hint: '' };

  // Build display with provider icon
  const display = decorator.unicode
    ? `${decorator.unicode} ${modelName}`
    : modelName;

  // Set text content first, then append styled indicator if needed
  opt.textContent = display;

  // Add requires-key indicator as styled span (matches original main webview)
  if (requiresKey) {
    const span = document.createElement('span');
    span.className = 'api-key-missing';
    span.textContent = ' ✗';
    opt.appendChild(span);
  }

  // Build tooltip with provider info
  const hints = [];
  if (decorator.label) hints.push(decorator.label);
  if (context) hints.push(`Context: ${context}`);
  if (cost) hints.push(`Cost: ${cost}`);

  if (hints.length > 0) {
    // Use pipe separator to match main webview style
    opt.title = hints.join(' | ');
    // Add aria-label for accessibility
    opt.setAttribute('aria-label', `${modelName} (${hints.join(', ')})`);
  }
}

/**
 * Decorate all model options in a select element.
 * @param {HTMLElement} selectElement - The select element
 */
export function decorateModelOptions(selectElement) {
  if (!isSelectLikeElement(selectElement)) return;
  getSelectOptionElements(selectElement).forEach((opt) => {
    decorateModelOption(opt);
  });
}

// =============================================================================
// OPTION HTML APPLICATION
// =============================================================================

/**
 * Mark an option as selected in HTML string before DOM insertion.
 * Prevents vscode-single-select from defaulting to first option.
 * @param {string} optionsHtml - The options HTML string
 * @param {string} value - The value to mark as selected
 * @returns {string} HTML with selected attribute added
 */
export function markOptionAsSelected(optionsHtml, value) {
  if (!value || !optionsHtml) return optionsHtml || '';

  const searchStr = `value="${value}"`;
  const index = optionsHtml.indexOf(searchStr);

  // Value not found - return original HTML unchanged
  if (index === -1) return optionsHtml;

  // Find the end of the opening tag
  const tagEnd = optionsHtml.indexOf('>', index + searchStr.length);
  if (tagEnd === -1) return optionsHtml;

  // Insert selected attribute before the closing >
  return optionsHtml.slice(0, tagEnd) + ' selected' + optionsHtml.slice(tagEnd);
}

/**
 * Restore selection after innerHTML replacement.
 * Handles cases where the value might not exist in options.
 * @param {HTMLElement} selectElement - The select element
 * @param {string} previousValue - The previous selected value
 */
export function restoreSelection(selectElement, previousValue) {
  if (!previousValue || !isSelectLikeElement(selectElement)) return;

  const options = getSelectOptionElements(selectElement);
  const hasValue = options.some(
    (opt) => opt.getAttribute('value') === previousValue,
  );

  if (hasValue) {
    selectElement.value = previousValue;
  }
}

/**
 * Set innerHTML with selection preservation.
 * Workaround for vscode-single-select's slotchange behavior that resets selection.
 * Steps: 1) Mark option in HTML, 2) Set innerHTML, 3) Restore via callback.
 *
 * @param {HTMLElement} selectElement - The select element
 * @param {string} optionsHtml - The options HTML
 * @param {function} [restoreFn] - Custom restore function(selectElement, previousValue). Defaults to restoreSelection.
 * @returns {string} The previous value (for chaining with decoration)
 */
export function setOptionsHtml(
  selectElement,
  optionsHtml,
  restoreFn = restoreSelection,
) {
  if (!isSelectLikeElement(selectElement)) return '';

  const previousValue = selectElement.value;
  const htmlWithSelected = markOptionAsSelected(optionsHtml, previousValue);
  selectElement.innerHTML = htmlWithSelected;
  restoreFn(selectElement, previousValue);
  return previousValue;
}

/**
 * Apply agent options HTML to a select element with decoration.
 * @param {HTMLElement} selectElement - The select element
 * @param {string} optionsHtml - The options HTML
 * @param {Object} [options] - Options
 * @param {string} [options.preserveValue] - Value to preserve selection for
 */
export function applyAgentOptions(selectElement, optionsHtml, options = {}) {
  if (!isSelectLikeElement(selectElement)) return;

  if (options.preserveValue !== undefined) {
    // Use explicit value - manually do the steps
    const htmlWithSelected = markOptionAsSelected(
      optionsHtml,
      options.preserveValue,
    );
    selectElement.innerHTML = htmlWithSelected;
    restoreSelection(selectElement, options.preserveValue);
  } else {
    // Use current value via setOptionsHtml
    setOptionsHtml(selectElement, optionsHtml);
  }
  decorateAgentOptions(selectElement);
  updateAgentSelectTooltip(selectElement);
}

/**
 * Apply model options HTML to a select element with decoration.
 * @param {HTMLElement} selectElement - The select element
 * @param {string} optionsHtml - The options HTML
 * @param {Object} [options] - Options
 * @param {string} [options.preserveValue] - Value to preserve selection for
 */
export function applyModelOptions(selectElement, optionsHtml, options = {}) {
  if (!isSelectLikeElement(selectElement)) return;

  if (options.preserveValue !== undefined) {
    const htmlWithSelected = markOptionAsSelected(
      optionsHtml,
      options.preserveValue,
    );
    selectElement.innerHTML = htmlWithSelected;
    restoreSelection(selectElement, options.preserveValue);
  } else {
    setOptionsHtml(selectElement, optionsHtml);
  }
  decorateModelOptions(selectElement);
}
