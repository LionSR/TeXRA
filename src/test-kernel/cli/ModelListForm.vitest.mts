import { describe, expect, it } from 'vitest';

import type { ModelOptionData } from '@shared/schemas';

import { formatModelStatusForCliMode } from '../../../packages/cli/src/chat/tui/forms/ModelListForm';
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
