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

describe('ModelSelectionList provider key actions', () => {
  useLitComponentTestDom(
    () =>
      import('@settingsView/frontend/components/profile/ModelSelectionList'),
  );

  it('shows direct API-key actions in model provider groups before profile load', async () => {
    const list = document.createElement(
      'model-selection-list',
    ) as ModelSelectionListElement;
    list.models = [deepseekModel];
    list.providerKeyStatuses = [];
    document.body.append(list);
    await list.updateComplete;

    const shadow = list.shadowRoot!;
    expect(shadow.textContent).toContain('No key');

    const setKeyButton = shadow.querySelector<HTMLElement>(
      '[title="Set DeepSeek API key"]',
    );
    expect(setKeyButton).toBeTruthy();

    const events: unknown[] = [];
    list.addEventListener('provider-key-set', (event) => {
      events.push((event as CustomEvent).detail);
    });

    setKeyButton!.click();

    expect(events).toEqual([{ provider: 'deepseek' }]);
  });

  it('shows helper model labels together with short ids', async () => {
    const list = document.createElement(
      'model-selection-list',
    ) as ModelSelectionListElement;
    list.models = [deepseekModel];
    list.helperModel = 'deepseek';
    document.body.append(list);
    await list.updateComplete;

    const helperOption = list.shadowRoot!.querySelector(
      '.helper-model-select wa-option',
    );

    expect(helperOption?.textContent?.trim()).toBe(
      'DeepSeek V4 Flash (deepseek)',
    );
  });
});
