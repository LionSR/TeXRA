/**
 * Lit-native template helpers for rendering select options.
 */

import '@awesome.me/webawesome/dist/components/option/option.js';

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';

import type { AgentOptionData, ModelOptionData } from '@shared/schemas';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { AGENT_DECORATORS, getModelProviderDecorator } from '@shared/wa/icons';
import { waIcon } from '@shared/wa/webAwesomeIcons';
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

function buildAgentTooltip(opt: AgentOptionData): string {
  const { properties } = AGENT_DECORATORS;
  const hints: string[] = [];

  if (opt.isOrchestrator)
    hints.push(
      'Plans a pipeline of specialized agents. Ask it which agent to use, or name agents in your instruction to steer delegation.',
    );
  // The two built-in sources carry no origin hint and have no row here.
  if (opt.source !== undefined && opt.source in properties)
    hints.push(properties[opt.source as keyof typeof properties].hint);
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
    >
      ${
        opt.isOrchestrator
          ? html`<span class="agent-icon">${waIcon('bullseye')} </span>`
          : nothing
      }${opt.label}
      ${
        opt.source === 'remote'
          ? html`<span class="agent-icon">
              ${waIcon(AGENT_DECORATORS.properties.remote.icon)}</span
            >`
          : nothing
      }
      ${
        opt.source === 'inline'
          ? html`<span class="agent-icon">
              ${waIcon(AGENT_DECORATORS.properties.inline.icon)}</span
            >`
          : nothing
      }
    </wa-option>
  `;
}

export function renderAgentOptions(options: AgentOptionData[]): TemplateResult {
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
  // `computeModelOptionsData` is the sole producer of both fields; a row
  // without them came from the secret-free basic list, which has no
  // availability verdict to show.
  const { availability, availabilityLabel } = opt;

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
