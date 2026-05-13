/**
 * Lit-native template helpers for rendering select options.
 */

import '@awesome.me/webawesome/dist/components/option/option.js';

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

function renderAgentOption(opt: AgentOptionData): TemplateResult {
  const { properties } = AGENT_DECORATORS;
  const tooltip = buildAgentTooltip(opt);

  const isOrch = opt.isOrchestrator;
  return html`
    <wa-option
      value=${opt.value}
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
    </wa-option>
  `;
}

export function renderAgentOptions(
  options: AgentOptionData[],
  _selectedValue: string,
): TemplateResult {
  return html`
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderAgentOption(opt),
    )}
  `;
}

function renderModelOption(opt: ModelOptionData): TemplateResult {
  const decorator = getModelProviderDecorator(opt.provider ?? '');
  const display = decorator.unicode
    ? `${decorator.unicode} ${opt.label}`
    : opt.label;
  const availability =
    opt.availability ??
    (opt.requiresKey ? 'missing-key' : opt.disabled ? 'not-included' : '');
  const availabilityLabel =
    opt.availabilityLabel ??
    (opt.requiresKey ? 'Missing API key' : opt.disabled ? 'Not included' : '');

  const hints: string[] = [];
  if (decorator.label) hints.push(decorator.label);
  if (opt.hint) hints.push(opt.hint);
  if (availabilityLabel) hints.push(availabilityLabel);
  const tooltip = hints.join(' | ');

  return html`
    <wa-option
      value=${opt.value}
      ?disabled=${opt.disabled}
      title=${tooltip || nothing}
      data-provider=${opt.provider || nothing}
      data-context=${opt.context || nothing}
      data-cost=${opt.cost || nothing}
      data-availability=${availability || nothing}
      data-requires-key=${opt.requiresKey ? 'true' : nothing}
      aria-label=${availabilityLabel
        ? `${opt.label} (${availabilityLabel})`
        : opt.label}
    >
      ${display}
      ${opt.disabled
        ? html`<span class="model-option-status"> ${availabilityLabel} </span>`
        : nothing}
    </wa-option>
  `;
}

export function renderModelOptions(
  options: ModelOptionData[],
  _selectedValue: string,
): TemplateResult {
  return html`
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderModelOption(opt),
    )}
  `;
}
