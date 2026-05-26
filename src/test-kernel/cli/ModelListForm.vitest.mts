import { describe, expect, it } from 'vitest';

import {
  formatModelStatusForCliMode,
  modelSelectWindow,
} from '@cli/chat/tui/forms/ModelListForm';
import {
  selectItemRenderKey,
  visibleSelectRange,
} from '@cli/chat/tui/ui/Select';
import type { CliModelAccess } from '@cli/runtime/modelAccess';
import type { ModelOptionData } from '@shared/schemas';

function access(
  model: Partial<ModelOptionData>,
  status = 'api key set',
): CliModelAccess {
  return {
    model: {
      value: 'deepseekT',
      label: 'DeepSeek V4 Flash (Thinking)',
      ...model,
    },
    available: !model.disabled && !model.requiresKey,
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
});

describe('CLI ModelListForm row budget', () => {
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
