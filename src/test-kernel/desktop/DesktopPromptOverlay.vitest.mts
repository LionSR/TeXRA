// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - shared utilities
import { delay } from '@utils/core';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface DesktopPromptOverlay {
  open(message: {
    command: 'desktop:showPrompt';
    requestId: string;
    title: string;
    prompt: string;
    password: boolean;
  }): void;
  cancel(): void;
}

interface DesktopPromptOverlayModule {
  createDesktopPromptOverlay(
    appRoot: HTMLElement,
    send: (message: Record<string, unknown>) => void,
  ): DesktopPromptOverlay;
}

async function loadDesktopPromptOverlay(): Promise<DesktopPromptOverlayModule> {
  return import(
    moduleFileUrl(desktopSourcePath('renderer', 'promptOverlay.ts'))
  ) as Promise<DesktopPromptOverlayModule>;
}

async function flushDialogTicks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) await delay(0);
}

const REQUEST_ID = '87db1d8b-81ed-4407-9414-984168ed4890';

describe('desktop prompt overlay', () => {
  useLitComponentTestDom(loadDesktopPromptOverlay);

  it('opens a focused password input and submits its value', async () => {
    const { createDesktopPromptOverlay } = await loadDesktopPromptOverlay();
    const appRoot = document.createElement('main');
    document.body.append(appRoot);
    const send = vi.fn();
    const overlay = createDesktopPromptOverlay(appRoot, send);

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
    const { createDesktopPromptOverlay } = await loadDesktopPromptOverlay();
    const appRoot = document.createElement('main');
    document.body.append(appRoot);
    const send = vi.fn();
    const overlay = createDesktopPromptOverlay(appRoot, send);
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
    overlay.cancel();
    overlay.cancel();
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
