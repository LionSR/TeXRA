import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type ProviderKeyModalElement = HTMLElement & {
  provider: string;
  displayName: string;
  updateComplete: Promise<boolean>;
};

let dom: JSDOM;

describe('ProviderKeyModal', () => {
  beforeAll(async () => {
    dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://texra.local',
    });

    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      Document: dom.window.Document,
      customElements: dom.window.customElements,
      HTMLElement: dom.window.HTMLElement,
      HTMLInputElement: dom.window.HTMLInputElement,
      CustomEvent: dom.window.CustomEvent,
      Event: dom.window.Event,
      MouseEvent: dom.window.MouseEvent,
      ShadowRoot: dom.window.ShadowRoot,
    });

    await import('@settingsView/frontend/components/profile/ProviderKeyModal');
  });

  beforeEach(() => {
    document.body.replaceChildren();
  });

  afterAll(() => {
    dom.window.close();
  });

  it('emits the trimmed key on submit without rendering it back after save', async () => {
    const modal = document.createElement(
      'provider-key-modal',
    ) as ProviderKeyModalElement;
    modal.provider = 'google';
    modal.displayName = 'Google';
    document.body.append(modal);
    await modal.updateComplete;

    const submitted: unknown[] = [];
    modal.addEventListener('provider-key-submit', (event) => {
      submitted.push((event as CustomEvent).detail);
    });

    const input = modal.shadowRoot!.querySelector('input')!;
    input.value = '  sk-test  ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    modal
      .shadowRoot!.querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await modal.updateComplete;

    expect(submitted).toEqual([{ provider: 'google', apiKey: 'sk-test' }]);
    expect(input.value).toBe('');
  });

  it('emits cancel without submitting a key', async () => {
    const modal = document.createElement(
      'provider-key-modal',
    ) as ProviderKeyModalElement;
    modal.provider = 'google';
    modal.displayName = 'Google';
    document.body.append(modal);
    await modal.updateComplete;

    let cancelled = 0;
    let submitted = 0;
    modal.addEventListener('provider-key-cancel', () => {
      cancelled += 1;
    });
    modal.addEventListener('provider-key-submit', () => {
      submitted += 1;
    });

    modal
      .shadowRoot!.querySelector<HTMLButtonElement>('.provider-key-secondary')!
      .click();

    expect(cancelled).toBe(1);
    expect(submitted).toBe(0);
  });
});
