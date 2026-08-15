import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { ModelSelectionItem, ProviderKeyStatus } from '@shared/schemas';
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type ModelSelectionListElement = HTMLElement & {
  models: ModelSelectionItem[];
  helperModel: string;
  providerKeyStatuses: ProviderKeyStatus[];
  updateComplete: Promise<boolean>;
};

const deepseekModel: ModelSelectionItem = {
  name: 'deepseek',
  label: 'DeepSeek V4 Flash',
  provider: 'deepseek',
  enabled: true,
  deprecated: false,
  supportsReasoningLevel: false,
  contextWindow: '1.0M',
  cost: '$0.140/$0.280',
  isFast: true,
};

function renderModelSelectionList(
  props: Partial<ModelSelectionListElement> = {},
): Promise<ModelSelectionListElement> {
  return mountComponent<ModelSelectionListElement>('model-selection-list', {
    models: [deepseekModel],
    ...props,
  });
}

describe('ModelSelectionList provider key status', () => {
  useLitComponentTestDom(
    () =>
      import('@settingsView/frontend/components/profile/ModelSelectionList'),
  );

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('shows a read-only API-key status in model provider groups before profile load', async () => {
    const list = await renderModelSelectionList({ providerKeyStatuses: [] });

    const shadow = list.shadowRoot!;
    expect(shadow.textContent).toContain('Not set');
    expect(shadow.textContent).not.toContain('No key');

    const setKeyButton = shadow.querySelector<HTMLElement>(
      '[title="Set DeepSeek API key"]',
    );
    const getKeyButton = shadow.querySelector<HTMLElement>(
      '[title="Get DeepSeek API key"]',
    );

    expect(setKeyButton).toBeNull();
    expect(getKeyButton).toBeNull();
  });

  it('shows helper model labels together with short ids', async () => {
    const list = await renderModelSelectionList({ helperModel: 'deepseek' });

    const helperOption = list.shadowRoot!.querySelector(
      '.helper-model-select wa-option',
    );

    expect(helperOption?.textContent?.trim()).toBe(
      'DeepSeek V4 Flash (deepseek)',
    );
  });

  it('keeps the pinned helper visible when it is not enabled', async () => {
    const list = await renderModelSelectionList({
      models: [
        { ...deepseekModel, enabled: false },
        {
          ...deepseekModel,
          name: 'sonnet5T',
          label: 'Sonnet 5 (Thinking)',
          provider: 'anthropic',
          enabled: true,
        },
      ],
      helperModel: 'deepseek',
    });

    const helperOptions = [
      ...list.shadowRoot!.querySelectorAll('.helper-model-select wa-option'),
    ];
    expect(helperOptions.map((option) => option.getAttribute('value'))).toEqual(
      ['deepseek', 'sonnet5T'],
    );
    expect(helperOptions[0]?.textContent?.trim()).toBe(
      'DeepSeek V4 Flash (deepseek)',
    );
  });

  it('renders the per-model enabled toggle as wa-switch and posts setModelEnabled on change', async () => {
    const list = await renderModelSelectionList();

    const providerToggle = list.shadowRoot!.querySelector<HTMLElement>(
      '.provider-group-toggle',
    );
    providerToggle?.click();
    await list.updateComplete;

    expect(list.shadowRoot!.querySelector('.model-row wa-checkbox')).toBe(null);
    const modelSwitch = list.shadowRoot!.querySelector(
      '.model-row wa-switch',
    ) as HTMLElement & { checked?: boolean };
    expect(modelSwitch).not.toBeNull();
    expect(modelSwitch.checked).toBe(true);

    modelSwitch.checked = false;
    modelSwitch.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
        { modelName: 'deepseek', enabled: false },
      ],
    ]);
  });

  it('shows an effective route without changing the provider group', async () => {
    const list = await renderModelSelectionList({
      models: [
        {
          ...deepseekModel,
          name: 'kimi3',
          label: 'Kimi K3',
          provider: 'moonshot',
          routeLabel: 'Via Kimi Code',
        },
      ],
    });

    list
      .shadowRoot!.querySelector<HTMLElement>('.provider-group-toggle')
      ?.click();
    await list.updateComplete;

    expect(
      list.shadowRoot!.querySelector('.provider-group-name')?.textContent,
    ).toContain('Moonshot');
    expect(
      list.shadowRoot!.querySelector('.model-route')?.textContent,
    ).toContain('Via Kimi Code');
  });
});
