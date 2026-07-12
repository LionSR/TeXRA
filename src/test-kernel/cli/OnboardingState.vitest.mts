import { describe, expect, it, vi } from 'vitest';

import {
  getOnboardingDeclined,
  setOnboardingDeclined,
} from '@controllers/onboarding/onboardingFunnel';
import { maskDisplayValue } from '@cli/chat/tui/input/textInputEditing';
import { formatApiKeyShadowWarning } from '@cli/runtime/apiStatus';
import { maybeRunCliOnboarding } from '@cli/onboarding/runOnboarding';
import { describeSavedKeyLocation } from '@cli/onboarding/onboardingState';
import { GlobalStateKey } from '@shared/state/stateKeys';

const ONBOARDING_DECLINED_KEY = GlobalStateKey.ONBOARDING_DECLINED;

import type { StateStore } from '@platform/interfaces';

function fakeStateStore(initial: Record<string, unknown> = {}): StateStore {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get<T>(key: string, defaultValue?: T): T {
      return (store.has(key) ? store.get(key) : defaultValue) as T;
    },
    async update(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
  };
}

describe('onboarding decline flag', () => {
  it('defaults to false and round-trips through global state', async () => {
    const state = fakeStateStore();
    expect(getOnboardingDeclined(state)).toBe(false);

    await setOnboardingDeclined(state, true);
    expect(getOnboardingDeclined(state)).toBe(true);
    expect(state.get(ONBOARDING_DECLINED_KEY)).toBe(true);

    await setOnboardingDeclined(state, false);
    expect(getOnboardingDeclined(state)).toBe(false);
  });

  it('treats a non-boolean stored value as not-declined', () => {
    expect(
      getOnboardingDeclined(
        fakeStateStore({ [ONBOARDING_DECLINED_KEY]: 'yes' }),
      ),
    ).toBe(false);
  });
});

describe('describeSavedKeyLocation', () => {
  it('names the exact secret entry and env-var fallback', () => {
    const message = describeSavedKeyLocation('anthropic');
    expect(message).toContain('apiKey.anthropic');
    expect(message).toContain('ANTHROPIC_API_KEY');
  });
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

describe('formatApiKeyShadowWarning', () => {
  it('warns only when signed in AND a personal key is present', () => {
    expect(formatApiKeyShadowWarning(true, ['deepseek'])).toBe(
      'available: included TeXRA access; personal API keys: DeepSeek',
    );
    expect(formatApiKeyShadowWarning(true, [])).toBeUndefined();
    expect(formatApiKeyShadowWarning(false, ['deepseek'])).toBeUndefined();
    expect(formatApiKeyShadowWarning(false, [])).toBeUndefined();
  });
});

describe('maybeRunCliOnboarding headless parity', () => {
  it('returns configured:false and writes nothing in headless mode', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write');
    try {
      await expect(
        maybeRunCliOnboarding({
          mode: 'headless',
          stdoutIsTty: true,
          termIsDumb: false,
        }),
      ).resolves.toEqual({ configured: false, declined: false });
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('returns configured:false on a non-TTY stdout even when marked interactive', async () => {
    // The defensive `!process.stdout.isTTY` guard must bail before rendering.
    // Stub isTTY explicitly so the test is deterministic regardless of whether
    // the runner attaches a TTY (vitest locally vs CI).
    const original = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    try {
      await expect(
        maybeRunCliOnboarding({
          mode: 'interactive',
          stdoutIsTty: true,
          termIsDumb: false,
        }),
      ).resolves.toEqual({ configured: false, declined: false });
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: original,
        configurable: true,
      });
    }
  });
});
