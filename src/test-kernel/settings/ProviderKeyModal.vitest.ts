import { describe, expect, it } from 'vitest';

import { delay } from '@utils/core';
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type ProviderKeyModalElement = HTMLElement & {
  provider: string;
  displayName: string;
  updateComplete: Promise<boolean>;
};

type WaDialogElement = HTMLElement & { open: boolean };

// wa-dialog's show/hide flow chains a few requestAnimationFrame and
// animateWithClass ticks before settling; flushing several macrotasks lets
// those promise/timer callbacks resolve in jsdom (which has no real raf).
async function flushDialogTicks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await delay(0);
  }
}

async function mountModal(): Promise<ProviderKeyModalElement> {
  const modal = await mountComponent<ProviderKeyModalElement>(
    'provider-key-modal',
    { provider: 'google', displayName: 'Google' },
  );
  await flushDialogTicks();
  return modal;
}

function setKey(
  modal: ProviderKeyModalElement,
  value: string,
): HTMLElement & { value: string } {
  const input = modal.shadowRoot!.querySelector('wa-input') as HTMLElement & {
    value: string;
  };
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

function submitForm(modal: ProviderKeyModalElement): void {
  modal
    .shadowRoot!.querySelector('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function countModalEvents(modal: ProviderKeyModalElement): {
  cancelled: number;
  submitted: number;
} {
  const counts = { cancelled: 0, submitted: 0 };
  modal.addEventListener('provider-key-cancel', () => {
    counts.cancelled += 1;
  });
  modal.addEventListener('provider-key-submit', () => {
    counts.submitted += 1;
  });
  return counts;
}

describe('ProviderKeyModal', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/components/profile/ProviderKeyModal'),
  );

  it('emits the trimmed key on submit without rendering it back after save', async () => {
    const modal = await mountModal();

    const submitted: unknown[] = [];
    modal.addEventListener('provider-key-submit', (event) => {
      submitted.push((event as CustomEvent).detail);
    });

    const input = setKey(modal, '  sk-test  ');
    submitForm(modal);
    await modal.updateComplete;

    await flushDialogTicks();
    expect(submitted).toEqual([{ provider: 'google', apiKey: 'sk-test' }]);
    expect(input.value).toBe('');
  });

  it('clears input and emits cancel without submitting a key', async () => {
    const modal = await mountModal();
    const counts = countModalEvents(modal);

    const input = setKey(modal, 'sk-cancel');
    // First wa-button in the footer is "Cancel" (outlined / neutral); clicking
    // it triggers the user-initiated close path that fires provider-key-cancel.
    const cancelButton = modal
      .shadowRoot!.querySelectorAll<HTMLElement>('wa-button')
      .item(0);
    cancelButton.click();
    await flushDialogTicks();

    expect(counts).toEqual({ cancelled: 1, submitted: 0 });
    expect(input.value).toBe('');
  });

  it('opens the wa-dialog when mounted and closes it after submit', async () => {
    const modal = await mountModal();

    const dialog =
      modal.shadowRoot!.querySelector<WaDialogElement>('wa-dialog')!;
    expect(dialog).toBeTruthy();
    // wa-dialog opens itself when `open` is set in firstUpdated.
    expect(dialog.open).toBe(true);

    const counts = countModalEvents(modal);

    setKey(modal, 'sk-after-submit');
    submitForm(modal);
    await flushDialogTicks();

    // Submit closes the dialog programmatically and must NOT also fire cancel.
    expect(dialog.open).toBe(false);
    expect(counts.cancelled).toBe(0);
  });
});
