import { describe, expect, it } from 'vitest';

import { useLitComponentTestDom } from './litComponentTestUtils';

type ProviderKeyModalElement = HTMLElement & {
  provider: string;
  displayName: string;
  updateComplete: Promise<boolean>;
};

describe('ProviderKeyModal', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/components/profile/ProviderKeyModal'),
  );

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

  it('clears input and emits cancel without submitting a key', async () => {
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

    const input = modal.shadowRoot!.querySelector('input')!;
    input.value = 'sk-cancel';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    modal
      .shadowRoot!.querySelector<HTMLButtonElement>('.provider-key-secondary')!
      .click();

    expect(cancelled).toBe(1);
    expect(submitted).toBe(0);
    expect(input.value).toBe('');
  });

  it('closes on Escape and traps Tab focus in the dialog', async () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();

    const modal = document.createElement(
      'provider-key-modal',
    ) as ProviderKeyModalElement;
    modal.provider = 'google';
    modal.displayName = 'Google';
    document.body.append(modal);
    await modal.updateComplete;

    let cancelled = 0;
    modal.addEventListener('provider-key-cancel', () => {
      cancelled += 1;
    });

    const input = modal.shadowRoot!.querySelector('input')!;
    const closeButton =
      modal.shadowRoot!.querySelector<HTMLButtonElement>('.provider-key-icon')!;
    const submitButton = modal.shadowRoot!.querySelector<HTMLButtonElement>(
      '.provider-key-primary',
    )!;

    submitButton.focus();
    submitButton.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(modal.shadowRoot!.activeElement).toBe(closeButton);

    closeButton.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(modal.shadowRoot!.activeElement).toBe(submitButton);

    input.value = 'sk-escape';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(cancelled).toBe(1);
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(trigger);
  });
});
