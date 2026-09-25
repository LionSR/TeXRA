import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { maskDisplayValue } from '@cli/chat/tui/input/textInputEditing';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { readOnboardingFlags } from '@shared/state/onboardingState';
import { GlobalStateKey } from '@shared/state/stateKeys';

const ONBOARDING_DECLINED_KEY = GlobalStateKey.ONBOARDING_DECLINED;

describe('onboarding decline flag', () => {
  it.effect('treats a non-boolean stored value as not-declined', () =>
    Effect.gen(function* () {
      const state = new MemoryStateStore();
      yield* state.update(ONBOARDING_DECLINED_KEY, 'yes');

      expect((yield* readOnboardingFlags(state)).declined).toBe(false);
    }),
  );
});

describe('maskDisplayValue', () => {
  it('masks every visible glyph but preserves newlines and length', () => {
    expect(maskDisplayValue('sk-ant-12345')).toBe('••••••••••••');
    expect(maskDisplayValue('sk-ant-12345')).toHaveLength(
      'sk-ant-12345'.length,
    );
    expect(maskDisplayValue('ab\ncd')).toBe('••\n••');
    expect(maskDisplayValue('')).toBe('');
  });
});
