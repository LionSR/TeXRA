/**
 * Lit-native template helpers for rendering select options.
 */

import '@awesome.me/webawesome/dist/components/option/option.js';

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type { AgentOptionData, ModelOptionData } from '@shared/schemas';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { AGENT_DECORATORS, getModelProviderDecorator } from './icons';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';

/**
 * Read the current value from a `wa-select` change event, defaulting to ''.
 * Reads from `currentTarget` (the wa-select host) instead of `target` — wa-
 * select can retarget events from internal elements, and
 * `HTMLSelectElement` is the wrong type for this Web Component anyway.
 */
export function readSelectValue(event: Event): string {
  const select = event.currentTarget as WaSelect | null;
  return typeof select?.value === 'string' ? select.value : '';
}

/**
 * Sentinel option value for the launcher dropdown's "Browse all agents…"
 * tail item. Never a real agent selection — handlers must intercept it
 * and open Settings → Agents instead.
 */
export const BROWSE_ALL_AGENTS_OPTION_VALUE = '__browse-all-agents__';

function buildAgentTooltip(opt: AgentOptionData): string {
  const { properties } = AGENT_DECORATORS;
  const hints: string[] = [];

  if (opt.isOrchestrator)
    hints.push(
      'Plans a pipeline of specialized agents. Ask it which agent to use, or name agents in your instruction to steer delegation.',
    );
  if (opt.isRemote) hints.push(properties.remote.hint);
  if (opt.isCustom) hints.push(properties.custom.hint);
  if (opt.isToolUse) hints.push('Can execute tools and code');

  return hints.join('\n');
}

function renderAgentOption(opt: AgentOptionData): TemplateResult {
  const tooltip = buildAgentTooltip(opt);

  return html`
    <wa-option
      value=${opt.value}
      title=${tooltip || nothing}
      data-label=${opt.label}
      data-tool-use=${opt.isToolUse ? 'true' : nothing}
      data-remote=${opt.isRemote ? 'true' : nothing}
      data-custom=${opt.isCustom ? 'true' : nothing}
    >
      ${
        opt.isOrchestrator
          ? html`<span class="agent-icon">${waIcon('bullseye')} </span>`
          : nothing
      }${opt.label}
      ${
        opt.isRemote
          ? html`<span class="agent-icon">
              ${waIcon(AGENT_DECORATORS.properties.remote.icon)}</span
            >`
          : nothing
      }
    </wa-option>
  `;
}

export function renderAgentOptions(
  options: AgentOptionData[],
  { includeBrowseAll = false }: { includeBrowseAll?: boolean } = {},
): TemplateResult {
  return html`
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderAgentOption(opt),
    )}
    ${
      includeBrowseAll
        ? html`
            <wa-option
              value=${BROWSE_ALL_AGENTS_OPTION_VALUE}
              title="Open Settings → Agents to browse the full catalog"
            >
              Browse all agents…
            </wa-option>
          `
        : nothing
    }
  `;
}

function defaultAvailability(opt: ModelOptionData): {
  value: string;
  label: string;
} {
  if (opt.requiresKey)
    return { value: 'missing-key', label: 'Missing API key' };
  if (opt.disabled) return { value: 'not-included', label: 'Not included' };
  return { value: '', label: '' };
}

function renderModelOption(opt: ModelOptionData): TemplateResult {
  const decorator = getModelProviderDecorator(opt.provider ?? '');
  const fallback = defaultAvailability(opt);
  const availability = opt.availability ?? fallback.value;
  const availabilityLabel = opt.availabilityLabel ?? fallback.label;

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
      aria-label=${
        availabilityLabel ? `${opt.label} (${availabilityLabel})` : opt.label
      }
    >
      <span class="agent-icon">${waIcon(decorator.icon)} </span>${opt.label}
      ${
        opt.disabled
          ? html`<span class="model-option-status">
              ${availabilityLabel}
            </span>`
          : nothing
      }
    </wa-option>
  `;
}

export function renderModelOptions(options: ModelOptionData[]): TemplateResult {
  return html`
    ${repeat(
      options,
      (opt) => opt.value,
      (opt) => renderModelOption(opt),
    )}
  `;
}
