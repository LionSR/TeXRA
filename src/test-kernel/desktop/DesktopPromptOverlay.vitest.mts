import { describe, expect, it, vi } from 'vitest';

import { delay } from '@utils/core';

import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

async function loadPromptOverlay(): Promise<
  typeof import('../../../packages/desktop/src/renderer/desktopPromptOverlay')
> {
  return import(
    moduleFileUrl(desktopSourcePath('renderer', 'desktopPromptOverlay.ts'))
  ) as Promise<
    typeof import('../../../packages/desktop/src/renderer/desktopPromptOverlay')
  >;
}

async function flushDialogTicks(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) await delay(0);
}

describe('desktop prompt overlay', () => {
  useLitComponentTestDom(loadPromptOverlay);

  it('focuses and masks password prompts, then submits the entered value', async () => {
    const { createDesktopPromptOverlay } = await loadPromptOverlay();
    const appRoot = document.createElement('div');
    document.body.append(appRoot);
    const submit = vi.fn();
    const controller = createDesktopPromptOverlay({ appRoot, submit });
    const input = appRoot.querySelector<
      HTMLElement & { type: string; value: string; placeholder: string }
    >('wa-input.desktop-prompt-input');
    if (!input) throw new Error('Prompt input was not rendered.');
    const focus = vi.spyOn(input, 'focus');

    controller.open({
      command: 'desktop:showPrompt',
      requestId: 'prompt-password',
      title: 'Set API key',
      prompt: 'Enter OpenAI API key',
      inputType: 'password',
      placeHolder: 'sk-...',
    });
    await flushDialogTicks();

    const dialog = appRoot.querySelector<HTMLElement & { open: boolean }>(
      'wa-dialog.desktop-prompt-overlay',
    );
    expect(dialog?.open).toBe(true);
    expect((dialog as (HTMLElement & { label?: string }) | null)?.label).toBe(
      'Set API key',
    );
    expect(input.type).toBe('password');
    expect((input as typeof input & { label?: string }).label).toBe(
      'Enter OpenAI API key',
    );
    expect(input.placeholder).toBe('sk-...');
    expect(focus).toHaveBeenCalledOnce();

    input.value = 'sk-secret';
    appRoot
      .querySelector('form.desktop-prompt-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushDialogTicks();

    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({
      command: 'desktop:promptResult',
      requestId: 'prompt-password',
      value: 'sk-secret',
    });
    expect(input.value).toBe('');
  });

  it('reports cancellation without a value', async () => {
    const { createDesktopPromptOverlay } = await loadPromptOverlay();
    const appRoot = document.createElement('div');
    document.body.append(appRoot);
    const submit = vi.fn();
    const controller = createDesktopPromptOverlay({ appRoot, submit });
    controller.open({
      command: 'desktop:showPrompt',
      requestId: 'prompt-text',
      title: 'Save team',
      prompt: 'Name for the new team',
      inputType: 'text',
    });
    await flushDialogTicks();

    const cancel = appRoot.querySelector<HTMLElement>(
      'wa-button.desktop-prompt-cancel',
    );
    cancel?.click();
    await flushDialogTicks();

    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({
      command: 'desktop:promptResult',
      requestId: 'prompt-text',
    });
  });

  it('reports native dialog dismissal as cancellation', async () => {
    const { createDesktopPromptOverlay } = await loadPromptOverlay();
    const appRoot = document.createElement('div');
    document.body.append(appRoot);
    const submit = vi.fn();
    const controller = createDesktopPromptOverlay({ appRoot, submit });
    controller.open({
      command: 'desktop:showPrompt',
      requestId: 'prompt-dismissed',
      title: 'Set value',
      prompt: 'Enter a value',
      inputType: 'text',
    });
    await flushDialogTicks();

    const dialog = appRoot.querySelector('wa-dialog.desktop-prompt-overlay');
    dialog?.dispatchEvent(new CustomEvent('wa-hide'));
    dialog?.dispatchEvent(new CustomEvent('wa-after-hide'));

    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith({
      command: 'desktop:promptResult',
      requestId: 'prompt-dismissed',
    });
  });
});
