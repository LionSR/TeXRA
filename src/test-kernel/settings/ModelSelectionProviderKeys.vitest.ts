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
});
