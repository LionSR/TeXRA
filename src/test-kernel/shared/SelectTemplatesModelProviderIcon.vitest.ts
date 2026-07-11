import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ModelOptionData } from '@shared/schemas';

/**
 * Regression coverage for #8157: the model-option dropdown used to bake a
 * raw unicode/emoji provider glyph into the option's text label
 * (`MODEL_PROVIDER_DECORATORS[...].unicode`), while the sibling agent-option
 * dropdown rendered its icons through `wa-icon` via the texra Font Awesome
 * resolver. `renderModelOption` now uses the same `wa-icon` mechanism as
 * `renderAgentOption` — never a unicode glyph baked into the label text.
 */
describe('renderModelOption uses wa-icon, matching renderAgentOption', () => {
  let dom: JSDOM;

  beforeAll(() => {
    dom = new JSDOM('<!doctype html><html><body></body></html>');
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      Node: dom.window.Node,
      Element: dom.window.Element,
      DocumentFragment: dom.window.DocumentFragment,
      customElements: dom.window.customElements,
      HTMLElement: dom.window.HTMLElement,
    });
  });

  afterAll(() => {
    dom.window.close();
  });

  it('renders a wa-icon for the provider, not a unicode glyph in the label text', async () => {
    const { renderModelOptions } =
      await import('@shared/utils/selectTemplates');
    const { render } = await import('lit');

    const options: ModelOptionData[] = [
      { value: 'claude-x', label: 'Claude X', provider: 'anthropic' },
    ];

    const container = document.createElement('div');
    render(renderModelOptions(options), container);

    const option = container.querySelector('wa-option');
    expect(option).not.toBeNull();

    const icon = option?.querySelector('wa-icon');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('name')).toBe('brain');
    expect(icon?.getAttribute('library')).toBe('texra');

    // The label text itself carries no baked-in glyph — the old unicode
    // decorators (𝔸, ⬡, 𝔾, 𝕏, 🐳, 𝕂, ☄, ⎇, ◇) are gone entirely.
    expect(option?.textContent).toContain('Claude X');
    expect(option?.textContent).not.toMatch(
      /[\u{1D400}-\u{1D7FF}\u{1F300}-\u{1FAFF}⌀-⏿☀-➿]/u,
    );
  });

  it('mirrors renderAgentOption: icon lives inside an .agent-icon span, not a slot', async () => {
    const { renderModelOptions, renderAgentOptions } =
      await import('@shared/utils/selectTemplates');
    const { render } = await import('lit');

    const modelContainer = document.createElement('div');
    render(
      renderModelOptions([
        { value: 'gpt-x', label: 'GPT X', provider: 'openai' },
      ]),
      modelContainer,
    );
    const modelIconSpan = modelContainer.querySelector(
      'wa-option .agent-icon wa-icon',
    );
    expect(modelIconSpan).not.toBeNull();
    expect(modelIconSpan?.getAttribute('slot')).toBeNull();

    const agentContainer = document.createElement('div');
    render(
      renderAgentOptions([
        { value: 'orchestrator', label: 'Orchestrator', isOrchestrator: true },
      ]),
      agentContainer,
    );
    const agentIconSpan = agentContainer.querySelector(
      'wa-option .agent-icon wa-icon',
    );
    expect(agentIconSpan).not.toBeNull();
    expect(agentIconSpan?.getAttribute('slot')).toBeNull();
  });

  it('falls back to the neutral "robot" icon for an unmapped provider', async () => {
    const { renderModelOptions } =
      await import('@shared/utils/selectTemplates');
    const { render } = await import('lit');

    const container = document.createElement('div');
    render(
      renderModelOptions([
        {
          value: 'mystery',
          label: 'Mystery Model',
          provider: 'some-unknown-provider',
        },
      ]),
      container,
    );

    const icon = container.querySelector('wa-option wa-icon');
    expect(icon?.getAttribute('name')).toBe('robot');
  });
});
