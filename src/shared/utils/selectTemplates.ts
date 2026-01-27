/**
 * Lit-native template helpers for rendering select options.
 *
 * These replace the HTML string building approach with declarative Lit templates.
 * Use these helpers in component render() methods instead of unsafeHTML().
 */

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import { AGENT_DECORATORS, getModelProviderDecorator } from './icons';

import type { AgentOptionData, ModelOptionData } from '@shared/schemas';

// =============================================================================
// PLACEHOLDER
// =============================================================================

function renderPlaceholder(text = 'None', value = ''): TemplateResult {
  return html`<vscode-option value=${value}>${text}</vscode-option>`;
}

// =============================================================================
// AGENT OPTIONS
// =============================================================================

/**
 * Build tooltip text for an agent option.
 */
function buildAgentTooltip(opt: AgentOptionData): string {
  const hints: string[] = [];

  if (opt.isRemote) {
    hints.push(AGENT_DECORATORS.properties.remote.hint);
  }
  if (opt.isCustom) {
    hints.push(AGENT_DECORATORS.properties.custom.hint);
  }
  if (opt.description) {
    hints.push(opt.description);
  }
  if (opt.isMultiple) {
    hints.push(AGENT_DECORATORS.properties.multipleOutputs.hint);
  }
  if (opt.isToolUse) {
    hints.push('Can execute tools and code');
  }

  return hints.join('\n');
}

/**
 * Render a single agent option with decorators.
 */
function renderAgentOption(
  opt: AgentOptionData,
  selectedValue: string,
): TemplateResult {
  const isSelected = opt.value === selectedValue;
  const tooltip = buildAgentTooltip(opt);

  return html`
    <vscode-option
      value=${opt.value}
      ?selected=${isSelected}
      title=${tooltip || nothing}
      data-label=${opt.label}
      data-multiple=${opt.isMultiple ? 'true' : nothing}
      data-tool-use=${opt.isToolUse ? 'true' : nothing}
      data-remote=${opt.isRemote ? 'true' : nothing}
      data-custom=${opt.isCustom ? 'true' : nothing}
      data-description=${opt.description || nothing}
      style=${opt.isMultiple ? 'opacity: 0.9' : nothing}
    >
      ${opt.label}${opt.isMultiple
        ? html`<span class="agent-icon">
            ${' '}${AGENT_DECORATORS.properties.multipleOutputs.unicode}</span
          >`
        : nothing}${opt.isRemote
        ? html`<span class="agent-icon">
            ${' '}${AGENT_DECORATORS.properties.remote.unicode}</span
          >`
        : nothing}
    </vscode-option>
  `;
}

/**
 * Render agent options with decorators.
 */
export function renderAgentOptions(
  options: AgentOptionData[],
  selectedValue: string,
  placeholder = 'Select agent',
): TemplateResult {
  return html`
    ${renderPlaceholder(placeholder)}
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderAgentOption(opt, selectedValue),
    )}
  `;
}

// =============================================================================
// MODEL OPTIONS
// =============================================================================

/**
 * Render a single model option with provider decoration.
 */
function renderModelOption(
  opt: ModelOptionData,
  selectedValue: string,
): TemplateResult {
  const isSelected = opt.value === selectedValue;
  const decorator = opt.provider
    ? getModelProviderDecorator(opt.provider)
    : { unicode: '', label: '', hint: '' };

  const display = decorator.unicode
    ? `${decorator.unicode} ${opt.label}`
    : opt.label;

  const hints: string[] = [];
  if (decorator.label) hints.push(decorator.label);
  if (opt.context) hints.push(`Context: ${opt.context}`);
  if (opt.cost) hints.push(`Cost: ${opt.cost}`);
  const tooltip = hints.join(' | ');

  return html`
    <vscode-option
      value=${opt.value}
      ?selected=${isSelected}
      ?disabled=${opt.disabled}
      title=${tooltip || nothing}
      data-provider=${opt.provider || nothing}
      data-context=${opt.context || nothing}
      data-cost=${opt.cost || nothing}
      data-requires-key=${opt.requiresKey ? 'true' : nothing}
    >
      ${display}${opt.requiresKey
        ? html`<span class="api-key-missing"> ✗</span>`
        : nothing}
    </vscode-option>
  `;
}

/**
 * Render model options with provider decorations.
 */
export function renderModelOptions(
  options: ModelOptionData[],
  selectedValue: string,
  placeholder = 'Select model',
): TemplateResult {
  return html`
    ${renderPlaceholder(placeholder)}
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderModelOption(opt, selectedValue),
    )}
  `;
}
