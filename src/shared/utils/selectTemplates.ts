/**
 * Lit-native template helpers for rendering select options.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type { AgentOptionData, ModelOptionData } from '@shared/schemas';
import { AGENT_DECORATORS, getModelProviderDecorator } from './icons';

function buildAgentTooltip(opt: AgentOptionData): string {
  const { properties } = AGENT_DECORATORS;
  const hints: string[] = [];

  if (opt.isOrchestrator)
    hints.push(
      'Plans a pipeline of specialized agents. Ask it which agent to use, or name agents in your instruction to steer delegation.',
    );
  if (opt.isRemote) hints.push(properties.remote.hint);
  if (opt.isCustom) hints.push(properties.custom.hint);
  if (opt.description) hints.push(opt.description);
  if (opt.isToolUse) hints.push('Can execute tools and code');

  return hints.join('\n');
}

function renderAgentOption(
  opt: AgentOptionData,
  selectedValue: string,
): TemplateResult {
  const { properties } = AGENT_DECORATORS;
  const tooltip = buildAgentTooltip(opt);

  const isOrch = opt.isOrchestrator;
  return html`
    <vscode-option
      value=${opt.value}
      ?selected=${opt.value === selectedValue}
      title=${tooltip || nothing}
      data-label=${opt.label}
      data-tool-use=${opt.isToolUse ? 'true' : nothing}
      data-remote=${opt.isRemote ? 'true' : nothing}
      data-custom=${opt.isCustom ? 'true' : nothing}
      data-description=${opt.description || nothing}
    >
      ${isOrch
        ? html`<span class="agent-icon">🎯 </span>`
        : nothing}${opt.label}
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
