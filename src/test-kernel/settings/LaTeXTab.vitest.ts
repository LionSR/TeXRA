import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type { LatexConfigValues } from '@shared/schemas';
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type LaTeXTabElement = HTMLElement & {
  loaded: boolean;
  configValues: LatexConfigValues;
  updateComplete: Promise<boolean>;
};

type WaTextareaElement = HTMLElement & {
  value: string;
  setCustomValidity: (message: string) => void;
};

async function mountLaTeXTab(
  configValues: LatexConfigValues,
): Promise<LaTeXTabElement> {
  return mountComponent<LaTeXTabElement>('latex-tab', {
    loaded: true,
    configValues,
  });
}

function customReplacementsInput(tab: LaTeXTabElement): WaTextareaElement {
  return tab.shadowRoot!.querySelector<WaTextareaElement>(
    '#latex-setting-customReplacements',
  )!;
}

async function enterInvalidJson(
  tab: LaTeXTabElement,
): Promise<ReturnType<typeof vi.spyOn>> {
  const input = customReplacementsInput(tab);
  const setCustomValidity = vi.spyOn(input, 'setCustomValidity');
  input.value = '{';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tab.updateComplete;
  expect(
    tab.shadowRoot!.querySelector('.replacement-json-error'),
  ).not.toBeNull();
  expect(setCustomValidity).toHaveBeenCalledWith(
    expect.stringMatching(/JSON/i),
  );
  return setCustomValidity;
}

describe('LaTeXTab custom replacement validation', () => {
  useLitComponentTestDom(() => import('@settingsView/frontend/tabs/LaTeXTab'));

  it('clears stale JSON validity immediately when reset is selected', async () => {
    const tab = await mountLaTeXTab({
      customReplacements: { before: 'after' },
    });
    const setCustomValidity = await enterInvalidJson(tab);
    const input = customReplacementsInput(tab);
    const reset = input
      .closest('.settings-row')!
      .querySelector<HTMLElement>('.settings-row-control wa-button')!;

    reset.click();
    await tab.updateComplete;

    expect(input.value).toBe('{}');
    expect(setCustomValidity).toHaveBeenLastCalledWith('');
    expect(tab.shadowRoot!.querySelector('.replacement-json-error')).toBeNull();
  });

  it('replaces an invalid draft and validity when external config changes', async () => {
    const tab = await mountLaTeXTab({});
    const setCustomValidity = await enterInvalidJson(tab);
    const input = customReplacementsInput(tab);

    tab.configValues = { customReplacements: {} };
    await tab.updateComplete;

    expect(input.value).toBe('{}');
    expect(setCustomValidity).toHaveBeenLastCalledWith('');
    expect(tab.shadowRoot!.querySelector('.replacement-json-error')).toBeNull();
  });
});
