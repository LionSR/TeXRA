import { describe, expect, it } from 'vitest';

import type { ModelOptionData } from '@shared/schemas';
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import type { TemplateResult } from 'lit';

let templates: typeof import('@shared/utils/selectTemplates');
let renderTemplate: typeof import('lit').render;

// `lit` and the module under test are imported through the harness callback,
// after the DOM globals are patched onto globalThis: lit-html caches its
// DOM-creation helpers off `global.document` when it is first evaluated.
useLitComponentTestDom(async () => {
  templates = await import('@shared/utils/selectTemplates');
  ({ render: renderTemplate } = await import('lit'));
});

/**
 * Regression coverage for #8157: the model-option dropdown used to bake a raw
 * unicode/emoji provider glyph into the option's text label. `renderModelOption`
 * now uses the same `wa-icon` mechanism as `renderAgentOption`.
 */
describe('renderModelOption uses wa-icon, matching renderAgentOption', () => {
  function renderOptions(template: TemplateResult): HTMLElement {
    const container = document.createElement('div');
    renderTemplate(template, container);
    return container;
  }

  it('renders a wa-icon for the provider, not a unicode glyph in the label text', () => {
    const options: ModelOptionData[] = [
      { value: 'claude-x', label: 'Claude X', provider: 'anthropic' },
    ];

    const option = renderOptions(
      templates.renderModelOptions(options),
    ).querySelector('wa-option');
    expect(option).not.toBeNull();

    const icon = option?.querySelector('wa-icon');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('name')).toBe('brain');
    expect(icon?.getAttribute('library')).toBe('texra');

    // The label text must not carry a baked-in unicode/emoji glyph.
    expect(option?.textContent).toContain('Claude X');
    expect(option?.textContent).not.toMatch(
      /[\u{1D400}-\u{1D7FF}\u{1F300}-\u{1FAFF}⌀-⏿☀-➿]/u,
    );
  });

  it('mirrors renderAgentOption: icon lives inside an .agent-icon span, not a slot', () => {
    const modelIconSpan = renderOptions(
      templates.renderModelOptions([
        { value: 'gpt-x', label: 'GPT X', provider: 'openai' },
      ]),
    ).querySelector('wa-option .agent-icon wa-icon');
    expect(modelIconSpan).not.toBeNull();
    expect(modelIconSpan?.getAttribute('slot')).toBeNull();

    const agentIconSpan = renderOptions(
      templates.renderAgentOptions([
        { value: 'orchestrator', label: 'Orchestrator', isOrchestrator: true },
      ]),
    ).querySelector('wa-option .agent-icon wa-icon');
    expect(agentIconSpan).not.toBeNull();
    expect(agentIconSpan?.getAttribute('slot')).toBeNull();
  });

  it('renders inline provenance in the launcher option', () => {
    const option = renderOptions(
      templates.renderAgentOptions([
        { value: 'inline:helper', label: 'helper', isInline: true },
      ]),
    ).querySelector('wa-option');

    expect(option?.getAttribute('data-inline')).toBe('true');
    expect(option?.getAttribute('title')).toContain(
      'Definition supplied directly by the embedding application',
    );
    expect(option?.querySelector('wa-icon')?.getAttribute('name')).toBe('code');
  });

  it('falls back to the neutral "robot" icon for an unmapped provider', () => {
    const icon = renderOptions(
      templates.renderModelOptions([
        {
          value: 'mystery',
          label: 'Mystery Model',
          provider: 'some-unknown-provider',
        },
      ]),
    ).querySelector('wa-option wa-icon');

    expect(icon?.getAttribute('name')).toBe('robot');
  });
});
