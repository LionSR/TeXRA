/**
 * Lit-native template helpers for rendering select options.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type { AgentOptionData, ModelOptionData } from '@shared/schemas';
import { AGENT_DECORATORS, getModelProviderDecorator } from './icons';

/** Check whether an agent option represents an orchestrator agent. */
function isOrchestratorAgent(opt: AgentOptionData): boolean {
  return (
    opt.value === 'orchestrator' ||
    opt.value.endsWith(':orchestrator') ||
    opt.value === 'leanOrchestrator' ||
    opt.value.endsWith(':leanOrchestrator')
  );
}

function buildAgentTooltip(opt: AgentOptionData): string {
  const { properties } = AGENT_DECORATORS;
  const hints: string[] = [];

  if (isOrchestratorAgent(opt))
    hints.push('Coordinates agents to work on your paper');
  if (opt.isRemote) hints.push(properties.remote.hint);
  if (opt.isCustom) hints.push(properties.custom.hint);
  if (opt.description) hints.push(opt.description);
  if (opt.isMultiple) hints.push(properties.multipleOutputs.hint);
  if (opt.isToolUse) hints.push('Can execute tools and code');

  return hints.join('\n');
}

function renderAgentOption(
  opt: AgentOptionData,
  selectedValue: string,
): TemplateResult {
  const { properties } = AGENT_DECORATORS;
  const tooltip = buildAgentTooltip(opt);

  const isOrch = isOrchestratorAgent(opt);
  return html`
    <vscode-option
      value=${opt.value}
      ?selected=${opt.value === selectedValue}
      title=${tooltip || nothing}
      data-label=${opt.label}
      data-multiple=${opt.isMultiple ? 'true' : nothing}
      data-tool-use=${opt.isToolUse ? 'true' : nothing}
      data-remote=${opt.isRemote ? 'true' : nothing}
      data-custom=${opt.isCustom ? 'true' : nothing}
      data-description=${opt.description || nothing}
    >
      ${isOrch
        ? html`<span class="agent-icon">🎯 </span>`
        : nothing}${opt.label}
      ${opt.isMultiple
        ? html`<span class="agent-icon">
            ${properties.multipleOutputs.unicode}</span
          >`
        : nothing}
      ${opt.isRemote
        ? html`<span class="agent-icon"> ${properties.remote.unicode}</span>`
        : nothing}
    </vscode-option>
  `;
}

export function renderAgentOptions(
  options: AgentOptionData[],
  selectedValue: string,
): TemplateResult {
  return html`
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderAgentOption(opt, selectedValue),
    )}
  `;
}

function renderModelOption(
  opt: ModelOptionData,
  selectedValue: string,
): TemplateResult {
  const decorator = getModelProviderDecorator(opt.provider ?? '');
  const display = decorator.unicode
    ? `${decorator.unicode} ${opt.label}`
    : opt.label;

  const hints: string[] = [];
  if (decorator.label) hints.push(decorator.label);
  if (opt.hint) hints.push(opt.hint);
  if (opt.requiresKey) hints.push('⚠ API key not configured');
  const tooltip = hints.join(' | ');

  return html`
    <vscode-option
      value=${opt.value}
      ?selected=${opt.value === selectedValue}
      ?disabled=${opt.disabled}
      title=${tooltip || nothing}
      data-provider=${opt.provider || nothing}
      data-context=${opt.context || nothing}
      data-cost=${opt.cost || nothing}
      data-requires-key=${opt.requiresKey ? 'true' : nothing}
    >
      ${display}
      ${opt.requiresKey
        ? html`<span class="api-key-missing"> ✗</span>`
        : nothing}
    </vscode-option>
  `;
}

export function renderModelOptions(
  options: ModelOptionData[],
  selectedValue: string,
): TemplateResult {
  return html`
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderModelOption(opt, selectedValue),
    )}
  `;
}
