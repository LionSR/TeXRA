import { describe, expect, it, vi } from 'vitest';

import { maskDisplayValue } from '@cli/chat/tui/input/textInputEditing';
import { formatPersonalApiKeysLine } from '@cli/runtime/apiStatus';
import { maybeRunCliOnboarding } from '@cli/onboarding/runOnboarding';
import {
  describeSavedKeyLocation,
  formatSavedKeySummary,
} from '@cli/onboarding/onboardingState';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { GlobalStateKey } from '@shared/state/stateKeys';

const ONBOARDING_DECLINED_KEY = GlobalStateKey.ONBOARDING_DECLINED;

describe('onboarding decline flag', () => {
  it('defaults to false and round-trips through global state', async () => {
    const state = new MemoryStateStore();
    expect(readOnboardingFlags(state).declined).toBe(false);

    await setOnboardingDeclined(state, true);
    expect(readOnboardingFlags(state).declined).toBe(true);
    expect(state.get(ONBOARDING_DECLINED_KEY)).toBe(true);

    await setOnboardingDeclined(state, false);
    expect(readOnboardingFlags(state).declined).toBe(false);
  });

  it('treats a non-boolean stored value as not-declined', async () => {
    const state = new MemoryStateStore();
    await state.update(ONBOARDING_DECLINED_KEY, 'yes');

    expect(readOnboardingFlags(state).declined).toBe(false);
  });
});

describe('saved key summary', () => {
  const SAVED_KEY_PREFIX =
    'Saved your Anthropic API key. Stored in TeXRA secrets as `apiKey.anthropic` (or set ANTHROPIC_API_KEY in your environment). ';

  it('names the exact secret entry and env-var fallback', () => {
    const message = describeSavedKeyLocation('anthropic');
    expect(message).toContain('apiKey.anthropic');
    expect(message).toContain('ANTHROPIC_API_KEY');
  });

  it('surfaces the access-route warning when ChatGPT remains active', () => {
    const warning =
      'Model access remains on ChatGPT subscription because a more specific setting overrides workspace config.';

    expect(
      formatSavedKeySummary('anthropic', {
        apiMode: 'personal',
        message: warning,
      }),
    ).toBe(SAVED_KEY_PREFIX + warning);
  });

  it('confirms the normal personal-key access route', () => {
    expect(
      formatSavedKeySummary('anthropic', {
        apiMode: 'personal',
        message: 'Model access: Your own API keys.',
      }),
    ).toBe(SAVED_KEY_PREFIX + 'Model access: Your own API keys.');
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

describe('formatPersonalApiKeysLine', () => {
  it('formats the configured provider inventory without access claims', () => {
    expect(formatPersonalApiKeysLine(['deepseek'])).toBe(
      'your own API keys: DeepSeek',
    );
    expect(formatPersonalApiKeysLine([])).toBeUndefined();
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
