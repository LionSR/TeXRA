import { describe, expect, it } from 'vitest';

import type { ModelOptionData } from '@shared/schemas';

import {
  formatModelStatusForCliMode,
  modelSelectWindow,
} from '../../../packages/cli/src/chat/tui/forms/ModelListForm';
import { visibleSelectRange } from '../../../packages/cli/src/chat/tui/ui/Select';
import type { CliModelAccess } from '../../../packages/cli/src/runtime/modelAccess';

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
