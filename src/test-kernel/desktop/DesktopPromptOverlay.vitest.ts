// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared utilities
import { delay } from '@utils/core';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.ts';
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

type DesktopPromptOverlay = ReturnType<
  typeof import('@desktop/renderer/promptOverlay').createDesktopPromptOverlay
>;

async function loadDesktopPromptOverlay(): Promise<
  typeof import('@desktop/renderer/promptOverlay')
> {
  return loadSourceModule('@desktop/renderer/promptOverlay');
}

async function flushDialogTicks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await delay(0);
}

const REQUEST_ID = '87db1d8b-81ed-4407-9414-984168ed4890';

async function mountOverlay(): Promise<{
  appRoot: HTMLElement;
  overlay: DesktopPromptOverlay;
  send: ReturnType<typeof vi.fn>;
}> {
  const { createDesktopPromptOverlay } = await loadDesktopPromptOverlay();
  const appRoot = document.createElement('main');
  document.body.append(appRoot);
  const send = vi.fn();
  return { appRoot, overlay: createDesktopPromptOverlay(appRoot, send), send };
}

describe('desktop prompt overlay', () => {
  useLitComponentTestDom(loadDesktopPromptOverlay);

  it('opens a focused password input and submits its value', async () => {
    const { appRoot, overlay, send } = await mountOverlay();

    overlay.open({
      command: 'desktop:showPrompt',
      requestId: REQUEST_ID,
      title: 'Set API key',
      prompt: 'Enter API key',
      password: true,
    });
    await flushDialogTicks();

    const dialog = appRoot.querySelector<HTMLElement & { open: boolean }>(
      'wa-dialog.desktop-prompt-overlay',
    )!;
    const input = appRoot.querySelector<
      HTMLElement & { type: string; value: string }
    >('wa-input.desktop-prompt-input')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-label')).toBe('Set API key');
    expect(input.type).toBe('password');
    expect(document.activeElement).toBe(input);

    input.value = 'sk-test';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }),
    );
    await flushDialogTicks();

    expect(send).toHaveBeenCalledWith({
      command: 'desktop:settlePrompt',
      requestId: REQUEST_ID,
      value: 'sk-test',
    });
    expect(dialog.open).toBe(false);
  });

  it('settles cancel and replacement requests exactly once', async () => {
    const { appRoot, overlay, send } = await mountOverlay();
    overlay.open({
      command: 'desktop:showPrompt',
      requestId: REQUEST_ID,
      title: 'First',
      prompt: 'First value',
      password: false,
    });
    overlay.open({
      command: 'desktop:showPrompt',
      requestId: '1afbf628-3501-488c-a691-26d2285a7389',
      title: 'Second',
      prompt: 'Second value',
      password: false,
    });
    const cancelButton = appRoot.querySelector<HTMLButtonElement>(
      'wa-button.desktop-prompt-cancel',
    )!;
    cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushDialogTicks();

    expect(send.mock.calls).toEqual([
      [
        {
          command: 'desktop:settlePrompt',
          requestId: REQUEST_ID,
          value: null,
        },
      ],
      [
        {
          command: 'desktop:settlePrompt',
          requestId: '1afbf628-3501-488c-a691-26d2285a7389',
          value: null,
        },
      ],
    ]);
  });
});
