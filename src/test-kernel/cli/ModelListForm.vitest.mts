import { describe, expect, it } from 'vitest';

import {
  emptyModelListMessageForCliMode,
  formatModelStatusForCliMode,
  modelSelectItemsForCliMode,
  modelSelectWindow,
  noRunnableModelAccessReason,
} from '@cli/chat/tui/forms/ModelListForm';
import {
  COMPACT_FORM_MAX_ROWS,
  isCompactFormRows,
} from '@cli/chat/tui/forms/_shared/selectWindow';
import {
  nextSelectHighlightIndex,
  selectInlineOverflowText,
  selectInitialHighlightIndex,
  selectItemRenderKey,
  selectVisibleInlineOverflowText,
  visibleSelectRange,
} from '@cli/chat/tui/ui/Select';
import type { CliModelAccess } from '@cli/runtime/modelAccess';
import type { ModelOptionData } from '@shared/schemas';

function access(
  model: Partial<ModelOptionData>,
  status = 'api key set',
  available = !model.disabled && !model.requiresKey,
): CliModelAccess {
  return {
    model: {
      value: 'deepseekT',
      label: 'DeepSeek V4 Flash (Thinking)',
      ...model,
    },
    available,
    status,
  };
}

describe('CLI ModelListForm status text', () => {
  it('marks personal API mode explicitly', () => {
    expect(
      formatModelStatusForCliMode(
        access({ availability: 'provider-key' }),
        'personal',
      ),
    ).toBe('api: api key set');
  });

  it('marks included relay mode explicitly', () => {
    expect(
      formatModelStatusForCliMode(
        access({ availability: 'included-access' }, 'included access'),
        'included',
      ),
    ).toBe('relay: included');
  });

  it('does not describe personal-key access as relay availability', () => {
    expect(
      formatModelStatusForCliMode(
        access({ availability: 'provider-key' }),
        'included',
      ),
    ).toBe('relay: unavailable; api key set');
  });

  it('distinguishes exhausted relay quota from tier exclusion', () => {
    expect(
      formatModelStatusForCliMode(
        access(
          {
            availability: 'relay-quota-exhausted',
            availabilityLabel: 'Relay quota exhausted',
            disabled: true,
          },
          'relay quota exhausted',
        ),
        'included',
      ),
    ).toBe('relay: quota exhausted');
  });

  it('shows signed-out included mode as a relay login requirement', () => {
    expect(
      formatModelStatusForCliMode(
        access(
          {
            availability: 'included-login-required',
            availabilityLabel: 'Login required',
            disabled: true,
          },
          'login required',
        ),
        'included',
      ),
    ).toBe('relay: login required');
  });
});

describe('CLI ModelListForm model visibility', () => {
  it('shows only models runnable in the active API mode', () => {
    const items = modelSelectItemsForCliMode(
      [
        access({
          value: 'sonnet46T',
          label: 'Sonnet',
          availability: 'included-access',
        }),
        access(
          {
            value: 'deepseekT',
            label: 'DeepSeek',
            availability: 'provider-key',
          },
          'api key set',
        ),
        access(
          {
            value: 'openrouterOnlyT',
            label: 'OpenRouter Only',
            availability: 'openrouter-key',
          },
          'openrouter key',
        ),
        access(
          {
            value: 'opus48T',
            label: 'Opus',
            availability: 'not-included',
            disabled: true,
          },
          'not included',
          false,
        ),
        access({
          value: 'gpt54',
          label: 'GPT-5.4',
          availability: 'included-access',
        }),
      ],
      'included',
    );

    expect(items.map((item) => item.value)).toEqual(['sonnet46T', 'gpt54']);
    expect(items.map((item) => item.description)).toEqual([
      'relay: included',
      'relay: included',
    ]);
  });

  it('shows personal-key models for personal API mode', () => {
    const items = modelSelectItemsForCliMode(
      [
        access(
          {
            value: 'sonnet46T',
            label: 'Sonnet',
            availability: 'included-access',
          },
          'included access',
        ),
        access({
          value: 'deepseekT',
          label: 'DeepSeek',
          availability: 'provider-key',
        }),
        access(
          {
            value: 'openrouterOnlyT',
            label: 'OpenRouter Only',
            availability: 'openrouter-key',
          },
          'openrouter key',
        ),
        access(
          {
            value: 'gemini31p',
            label: 'Gemini',
            availability: 'missing-key',
            requiresKey: true,
          },
          'missing api key',
          false,
        ),
      ],
      'personal',
    );

    expect(items.map((item) => item.value)).toEqual([
      'deepseekT',
      'openrouterOnlyT',
    ]);
    expect(items.map((item) => item.description)).toEqual([
      'api: api key set',
      'api: openrouter key',
    ]);
  });

  it('marks API-mode-runnable models disabled when the live chat cannot switch formats', () => {
    const items = modelSelectItemsForCliMode(
      [
        access({
          value: 'sonnet46T',
          label: 'Sonnet',
          availability: 'provider-key',
        }),
        access({
          value: 'gpt55',
          label: 'GPT-5.5',
          availability: 'provider-key',
        }),
      ],
      'personal',
      (model) =>
        model === 'sonnet46T'
          ? 'different conversation format; start new chat'
          : undefined,
    );

    expect(items).toEqual([
      {
        value: 'sonnet46T',
        label: 'Sonnet',
        description:
          'api: api key set; different conversation format; start new chat',
        disabled: true,
      },
      {
        value: 'gpt55',
        label: 'GPT-5.5',
        description: 'api: api key set',
        disabled: false,
      },
    ]);
  });

  it('treats filtered-empty lists as non-actionable', () => {
    expect(
      modelSelectItemsForCliMode(
        [
          access(
            {
              availability: 'provider-key',
            },
            'api key set',
            false,
          ),
          access(
            {
              availability: 'missing-key',
              requiresKey: true,
            },
            'missing api key',
            false,
          ),
          access(
            {
              availability: 'not-included',
              disabled: true,
            },
            'not included',
            false,
          ),
        ],
        'included',
      ).length,
    ).toBe(0);
  });
});

describe('CLI ModelListForm empty state', () => {
  it('classifies signed-out included access separately from other included outages', () => {
    expect(
      noRunnableModelAccessReason(
        [
          access(
            {
              availability: 'included-login-required',
              disabled: true,
            },
            'login required',
            false,
          ),
        ],
        'included',
      ),
    ).toBe('includedLoginRequired');
  });

  it('classifies personal and non-login included empty states by API mode', () => {
    expect(
      noRunnableModelAccessReason(
        [
          access(
            {
              availability: 'missing-key',
              requiresKey: true,
            },
            'missing api key',
            false,
          ),
        ],
        'personal',
      ),
    ).toBe('personal');
    expect(
      noRunnableModelAccessReason(
        [
          access(
            {
              availability: 'relay-quota-exhausted',
              disabled: true,
            },
            'relay quota exhausted',
            false,
          ),
        ],
        'included',
      ),
    ).toBe('included');
  });

  it('explains that included relay models require sign-in', () => {
    expect(
      emptyModelListMessageForCliMode(
        [
          access(
            {
              availability: 'included-login-required',
              disabled: true,
            },
            'login required',
            false,
          ),
        ],
        'included',
      ),
    ).toBe(
      'Included relay models require sign-in. Run /login or switch with /api personal.',
    );
  });

  it('points included relay users at personal keys when no relay models are runnable', () => {
    expect(
      emptyModelListMessageForCliMode(
        [
          access(
            {
              availability: 'not-included',
              disabled: true,
            },
            'not included',
            false,
          ),
        ],
        'included',
      ),
    ).toBe(
      'No included relay models are runnable. Switch with /api personal or try again later.',
    );
  });

  it('points personal API-key users at key setup or included relay', () => {
    expect(
      emptyModelListMessageForCliMode(
        [
          access(
            {
              availability: 'missing-key',
              requiresKey: true,
            },
            'missing api key',
            false,
          ),
        ],
        'personal',
      ),
    ).toBe(
      'No personal API-key models are runnable. Configure a provider key or switch with /api included.',
    );
  });
});

describe('Select render keys', () => {
  it('does not collapse object-valued items to the same React key', () => {
    const first = selectItemRenderKey(
      { value: { kind: 'chat' }, label: 'New chat' },
      0,
    );
    const second = selectItemRenderKey(
      { value: { kind: 'help' }, label: 'Help' },
      1,
    );

    expect(first).toBe('0:New chat');
    expect(second).toBe('1:Help');
    expect(first).not.toBe(second);
  });
});

describe('CLI Select visible range', () => {
  it('keeps a contiguous window around the highlighted row', () => {
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 5,
        maxVisibleItems: 5,
      }),
    ).toEqual({ start: 3, end: 8 });
  });

  it('clamps the visible window at list edges', () => {
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 0,
        maxVisibleItems: 5,
      }),
    ).toEqual({ start: 0, end: 5 });
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 7,
        maxVisibleItems: 5,
      }),
    ).toEqual({ start: 3, end: 8 });
  });

  it('allows callers to reserve zero visible rows', () => {
    expect(
      visibleSelectRange({
        itemCount: 8,
        highlight: 3,
        maxVisibleItems: 0,
      }),
    ).toEqual({ start: 0, end: 0 });
  });
});

describe('CLI Select inline overflow', () => {
  it('summarizes hidden choices when separate overflow rows are disabled', () => {
    expect(
      selectInlineOverflowText({
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: false,
      }),
    ).toBe('+3 more');
    expect(
      selectInlineOverflowText({
        hiddenBefore: 2,
        hiddenAfter: 0,
        showOverflow: false,
      }),
    ).toBe('+2 earlier');
    expect(
      selectInlineOverflowText({
        hiddenBefore: 2,
        hiddenAfter: 4,
        showOverflow: false,
      }),
    ).toBe('+2 earlier, +4 more');
  });

  it('defers to separate overflow rows when they are enabled', () => {
    expect(
      selectInlineOverflowText({
        hiddenBefore: 0,
        hiddenAfter: 3,
        showOverflow: true,
      }),
    ).toBeUndefined();
  });

  it('shows inline overflow for any clipped visible window', () => {
    expect(
      selectVisibleInlineOverflowText({
        hiddenBefore: 0,
        hiddenAfter: 2,
        showOverflow: false,
        visibleItemCount: 3,
      }),
    ).toBe('+2 more');
  });
});

describe('CLI Select disabled-row focus', () => {
  const items = [
    { value: 'gemini', label: 'Gemini', disabled: true },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'deepseek', label: 'DeepSeek', disabled: true },
  ];

  it('starts on the active row when it is enabled', () => {
    expect(
      selectInitialHighlightIndex({
        activeValue: 'sonnet',
        items,
      }),
    ).toBe(1);
  });

  it('starts on the first enabled row when the active row is disabled', () => {
    expect(
      selectInitialHighlightIndex({
        activeValue: 'deepseek',
        items,
      }),
    ).toBe(1);
  });

  it('starts on the first enabled row when the requested initial row is disabled', () => {
    expect(
      selectInitialHighlightIndex({
        initialIndex: 3,
        items,
      }),
    ).toBe(1);
  });

  it('keeps arrow navigation directional around disabled rows', () => {
    expect(
      nextSelectHighlightIndex({
        direction: 1,
        highlight: 1,
        items,
      }),
    ).toBe(2);
    expect(
      nextSelectHighlightIndex({
        direction: 1,
        highlight: 2,
        items,
      }),
    ).toBe(2);
    expect(
      nextSelectHighlightIndex({
        direction: -1,
        highlight: 1,
        items,
      }),
    ).toBe(1);
    expect(
      nextSelectHighlightIndex({
        direction: -1,
        highlight: 2,
        items,
      }),
    ).toBe(1);
  });

  it('keeps wraparound navigation for all-enabled lists', () => {
    const enabledItems = [
      { value: 'gemini', label: 'Gemini' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
    ];

    expect(
      nextSelectHighlightIndex({
        direction: -1,
        highlight: 0,
        items: enabledItems,
      }),
    ).toBe(2);
    expect(
      nextSelectHighlightIndex({
        direction: 1,
        highlight: 2,
        items: enabledItems,
      }),
    ).toBe(0);
  });
});

describe('CLI ModelListForm row budget', () => {
  it('uses compact slash forms before bordered content clips titles', () => {
    expect(COMPACT_FORM_MAX_ROWS).toBe(9);
    expect(isCompactFormRows(9)).toBe(true);
    expect(isCompactFormRows(10)).toBe(false);
  });

  it('removes the row floor on short terminals', () => {
    expect(modelSelectWindow({ availableRows: 6, itemCount: 8 })).toEqual({
      maxVisibleItems: 1,
      showOverflow: false,
    });
    expect(modelSelectWindow({ availableRows: 7, itemCount: 8 })).toEqual({
      maxVisibleItems: 2,
      showOverflow: false,
    });
  });

  it('spends overflow rows only when the budget can fit them', () => {
    expect(modelSelectWindow({ availableRows: 12, itemCount: 8 })).toEqual({
      maxVisibleItems: 5,
      showOverflow: true,
    });
  });
});
