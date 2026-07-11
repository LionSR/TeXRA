import { describe, expect, it } from 'vitest';

import type {
  ModelSelectionItem,
  ProviderKeyStatus,
} from '@shared/schemas/settingsViewMessages';
import { useLitComponentTestDom } from './litComponentTestUtils';

type ModelSelectionListElement = HTMLElement & {
  models: ModelSelectionItem[];
  helperModel: string;
  providerKeyStatuses: ProviderKeyStatus[];
  updateComplete: Promise<boolean>;
};

type ModelSelectionEventDetail = { modelName: string; enabled: boolean };

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

async function renderModelSelectionList(
  configure: (list: ModelSelectionListElement) => void,
): Promise<ModelSelectionListElement> {
  const list = document.createElement(
    'model-selection-list',
  ) as ModelSelectionListElement;
  list.models = [deepseekModel];
  configure(list);
  document.body.append(list);
  await list.updateComplete;
  return list;
}

describe('ModelSelectionList provider key status', () => {
  useLitComponentTestDom(
    () =>
      import('@settingsView/frontend/components/profile/ModelSelectionList'),
  );

  it('shows a read-only API-key status in model provider groups before profile load', async () => {
    const list = await renderModelSelectionList((el) => {
      el.providerKeyStatuses = [];
    });

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
    const list = await renderModelSelectionList((el) => {
      el.helperModel = 'deepseek';
    });

    const helperOption = list.shadowRoot!.querySelector(
      '.helper-model-select wa-option',
    );

    expect(helperOption?.textContent?.trim()).toBe(
      'DeepSeek V4 Flash (deepseek)',
    );
  });

  it('renders the per-model enabled toggle as wa-switch and emits model-enabled-set on change', async () => {
    const list = await renderModelSelectionList(() => {});

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

    let detail: ModelSelectionEventDetail | undefined;
    list.addEventListener('model-enabled-set', (event) => {
      detail = (event as CustomEvent<ModelSelectionEventDetail>).detail;
    });

    modelSwitch.checked = false;
    modelSwitch.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(detail).toEqual({ modelName: 'deepseek', enabled: false });
  });
});
