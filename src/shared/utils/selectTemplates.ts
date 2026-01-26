/**
 * Lit-native template helpers for rendering select options.
 *
 * These replace the HTML string building approach with declarative Lit templates.
 * Use these helpers in component render() methods instead of unsafeHTML().
 */

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type {
  SelectOption,
  AgentOption,
  ModelOption,
  CommitOption,
} from '@shared/types/selectOptions';
import { AGENT_DECORATORS, getModelProviderDecorator } from './icons';

// =============================================================================
// GENERIC SELECT OPTIONS
// =============================================================================

/**
 * Render a placeholder option.
 */
export function renderPlaceholder(
  text = 'None',
  value = '',
): TemplateResult {
  return html`<vscode-option value=${value}>${text}</vscode-option>`;
}

/**
 * Render simple select options.
 */
export function renderSelectOptions(
  options: SelectOption[],
  selectedValue: string,
  placeholder?: string,
): TemplateResult {
  return html`
    ${placeholder ? renderPlaceholder(placeholder) : nothing}
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => html`
        <vscode-option
          value=${opt.value}
          ?selected=${opt.value === selectedValue}
          ?disabled=${opt.disabled}
        >
          ${opt.label}
        </vscode-option>
      `,
    )}
  `;
}

// =============================================================================
// FILE OPTIONS (sorted alphabetically)
// =============================================================================

/**
 * Render file path options sorted alphabetically.
 */
export function renderFileOptions(
  files: string[],
  selectedValue: string,
  placeholder = 'None',
): TemplateResult {
  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  return html`
    ${renderPlaceholder(placeholder)}
    ${repeat(
      sorted,
      (file) => file,
      (file) => html`
        <vscode-option value=${file} ?selected=${file === selectedValue}>
          ${file}
        </vscode-option>
      `,
    )}
  `;
}

// =============================================================================
// AGENT OPTIONS
// =============================================================================

/**
 * Build tooltip text for an agent option.
 */
function buildAgentTooltip(opt: AgentOption): string {
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
export function renderAgentOption(
  opt: AgentOption,
  selectedValue: string,
): TemplateResult {
  const isSelected = opt.value === selectedValue;
  const tooltip = buildAgentTooltip(opt);

  return html`
    <vscode-option
      value=${opt.value}
      ?selected=${isSelected}
      ?disabled=${opt.disabled}
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
            ${AGENT_DECORATORS.properties.multipleOutputs.unicode}</span
          >`
        : nothing}${opt.isRemote
        ? html`<span class="agent-icon">
            ${AGENT_DECORATORS.properties.remote.unicode}</span
          >`
        : nothing}
    </vscode-option>
  `;
}

/**
 * Render agent options with decorators.
 */
export function renderAgentOptions(
  options: AgentOption[],
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
export function renderModelOption(
  opt: ModelOption,
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
        ? html`<span class="api-key-missing"> \u2717</span>`
        : nothing}
    </vscode-option>
  `;
}

/**
 * Render model options with provider decorations.
 */
export function renderModelOptions(
  options: ModelOption[],
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

// =============================================================================
// COMMIT OPTIONS
// =============================================================================

/**
 * Render git commit options.
 */
export function renderCommitOptions(
  commits: CommitOption[],
  selectedValue: string,
  isGitRepo: boolean,
): TemplateResult {
  if (!isGitRepo) {
    return html`<vscode-option value="">Not a Git repository</vscode-option>`;
  }

  // Ensure HEAD is included
  const hasHead = commits.some((c) => c.hash === 'HEAD');
  const entries = hasHead ? commits : [{ hash: 'HEAD', label: 'HEAD' }, ...commits];

  return html`
    ${repeat(
      entries,
      (commit) => commit.hash,
      (commit) => html`
        <vscode-option
          value=${commit.hash}
          ?selected=${commit.hash === selectedValue}
        >
          ${commit.label}
        </vscode-option>
      `,
    )}
  `;
}
