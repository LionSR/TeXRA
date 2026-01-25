/**
 * Shared dropdown utilities for agent and model options.
 * Used by main webview and progress view for consistent dropdown rendering.
 */

// Local imports - shared utilities
import {
  AGENT_DECORATORS,
  getModelProviderDecorator,
} from '@shared/utils/icons';
import {
  isSelectLikeElement,
  getSelectOptionElements,
  getSelectedOptionElement,
} from '@shared/utils/dom';

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
 */
export function withPlaceholder(
  optionsHtml: string,
  placeholder: string,
): string {
  return `${placeholder}\n${optionsHtml}`;
}

// =============================================================================
// AGENT OPTION DECORATION
// =============================================================================

export interface AgentOptionMetadata {
  label: string;
  isMultiple: boolean;
  isToolUse: boolean;
  isRemote: boolean;
  isCustom: boolean;
  description: string;
}

/**
 * Read agent option metadata from data attributes.
 */
export function readAgentOptionMetadata(opt: HTMLElement): AgentOptionMetadata {
  const data = opt.dataset;
  const label =
    data.label || opt.textContent?.trim() || opt.getAttribute('value') || '';

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
 */
export function decorateAgentOption(opt: HTMLElement): void {
  const { label, isMultiple, isToolUse, isRemote, isCustom, description } =
    readAgentOptionMetadata(opt);

  const hints: string[] = [];

  if (isRemote) {
    hints.push(AGENT_DECORATORS.properties.remote.hint);
  }

  if (isCustom) {
    hints.push(AGENT_DECORATORS.properties.custom.hint);
  }

  if (description) {
    hints.push(description);
  }

  if (isMultiple) {
    hints.push(AGENT_DECORATORS.properties.multipleOutputs.hint);
    opt.style.opacity = '0.9';
  } else {
    opt.style.opacity = '';
  }

  if (isToolUse) {
    hints.push('Can execute tools and code');
  }

  opt.textContent = label;

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
    opt.removeAttribute('title');
    opt.setAttribute('aria-label', label);
    opt.removeAttribute('aria-description');
  }
}

/**
 * Decorate all agent options in a select element.
 */
export function decorateAgentOptions(selectElement: HTMLElement): void {
  if (!isSelectLikeElement(selectElement)) return;
  getSelectOptionElements(selectElement).forEach((opt) => {
    decorateAgentOption(opt);
  });
}

/**
 * Update the agent select element's tooltip to show the selected agent's details.
 */
export function updateAgentSelectTooltip(selectElement: HTMLElement): void {
  if (!isSelectLikeElement(selectElement)) return;

  const selectedOption = getSelectedOptionElement(selectElement);
  if (selectedOption?.title) {
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

export interface ModelOptionMetadata {
  provider: string;
  context: string;
  cost: string;
  requiresKey: boolean;
  modelName: string;
}

/**
 * Read model option metadata from data attributes.
 */
export function readModelOptionMetadata(opt: HTMLElement): ModelOptionMetadata {
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
 */
export function decorateModelOption(opt: HTMLElement): void {
  const { provider, context, cost, requiresKey, modelName } =
    readModelOptionMetadata(opt);

  const decorator = provider
    ? getModelProviderDecorator(provider)
    : { unicode: '', label: '', hint: '' };

  const display = decorator.unicode
    ? `${decorator.unicode} ${modelName}`
    : modelName;

  opt.textContent = display;

  if (requiresKey) {
    const span = document.createElement('span');
    span.className = 'api-key-missing';
    span.textContent = ' ✗';
    opt.appendChild(span);
  }

  const hints: string[] = [];
  if (decorator.label) hints.push(decorator.label);
  if (context) hints.push(`Context: ${context}`);
  if (cost) hints.push(`Cost: ${cost}`);

  if (hints.length > 0) {
    opt.title = hints.join(' | ');
    opt.setAttribute('aria-label', `${modelName} (${hints.join(', ')})`);
  }
}

/**
 * Decorate all model options in a select element.
 */
export function decorateModelOptions(selectElement: HTMLElement): void {
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
 */
export function markOptionAsSelected(
  optionsHtml: string,
  value: string,
): string {
  if (!value || !optionsHtml) return optionsHtml || '';

  const searchStr = `value="${value}"`;
  const index = optionsHtml.indexOf(searchStr);
  if (index === -1) return optionsHtml;

  const tagEnd = optionsHtml.indexOf('>', index + searchStr.length);
  if (tagEnd === -1) return optionsHtml;

  return `${optionsHtml.slice(0, tagEnd)} selected${optionsHtml.slice(tagEnd)}`;
}

/**
 * Restore selection after innerHTML replacement.
 */
export function restoreSelection(
  selectElement: HTMLElement,
  previousValue: string,
): void {
  if (!previousValue || !isSelectLikeElement(selectElement)) return;

  const options = getSelectOptionElements(selectElement);
  const hasValue = options.some(
    (opt) => opt.getAttribute('value') === previousValue,
  );

  if (hasValue) {
    (selectElement as HTMLInputElement).value = previousValue;
  }
}

/**
 * Set innerHTML with selection preservation.
 */
export function setOptionsHtml(
  selectElement: HTMLElement,
  optionsHtml: string,
  restoreFn: (select: HTMLElement, value: string) => void = restoreSelection,
): string {
  if (!isSelectLikeElement(selectElement)) return '';

  const previousValue = (selectElement as HTMLInputElement).value;
  const htmlWithSelected = markOptionAsSelected(optionsHtml, previousValue);
  selectElement.innerHTML = htmlWithSelected;
  restoreFn(selectElement, previousValue);
  return previousValue;
}

/**
 * Apply agent options HTML to a select element with decoration.
 */
export function applyAgentOptions(
  selectElement: HTMLElement,
  optionsHtml: string,
  options: { preserveValue?: string } = {},
): void {
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
  decorateAgentOptions(selectElement);
  updateAgentSelectTooltip(selectElement);
}

/**
 * Apply model options HTML to a select element with decoration.
 */
export function applyModelOptions(
  selectElement: HTMLElement,
  optionsHtml: string,
  options: { preserveValue?: string } = {},
): void {
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
