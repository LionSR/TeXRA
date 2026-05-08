import { describe, expect, it } from 'vitest';

import { useLitComponentTestDom } from './litComponentTestUtils';

type ProviderKeyModalElement = HTMLElement & {
  provider: string;
  displayName: string;
  updateComplete: Promise<boolean>;
};

type WaDialogElement = HTMLElement & { open: boolean };

// wa-dialog's show/hide flow chains a few requestAnimationFrame and
// animateWithClass ticks before settling; flushing several macrotasks lets
// those promise/timer callbacks resolve in jsdom (which has no real raf).
async function flushDialogTicks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

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
    await flushDialogTicks();

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

    await flushDialogTicks();
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
    await flushDialogTicks();

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
    await flushDialogTicks();

    expect(cancelled).toBe(1);
    expect(submitted).toBe(0);
    expect(input.value).toBe('');
  });

  it('opens the wa-dialog when mounted and closes it after submit', async () => {
    const modal = document.createElement(
      'provider-key-modal',
    ) as ProviderKeyModalElement;
    modal.provider = 'google';
    modal.displayName = 'Google';
    document.body.append(modal);
    await modal.updateComplete;
    await flushDialogTicks();

    const dialog =
      modal.shadowRoot!.querySelector<WaDialogElement>('wa-dialog')!;
    expect(dialog).toBeTruthy();
    // wa-dialog opens itself when `open` is set in firstUpdated.
    expect(dialog.open).toBe(true);

    let cancelled = 0;
    modal.addEventListener('provider-key-cancel', () => {
      cancelled += 1;
    });

    const input = modal.shadowRoot!.querySelector('input')!;
    input.value = 'sk-after-submit';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    modal
      .shadowRoot!.querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushDialogTicks();

    // Submit closes the dialog programmatically and must NOT also fire cancel.
    expect(dialog.open).toBe(false);
    expect(cancelled).toBe(0);
  });
});
