import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type {
  ModelSelectionItem,
  ProviderKeyStatus,
} from '@shared/settingsView/settingsViewMessages';
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
});
