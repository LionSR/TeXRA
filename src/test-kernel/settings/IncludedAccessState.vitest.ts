import { beforeEach, describe, expect, it } from 'vitest';

import { profileHandlers } from '@settingsView/frontend/slices/profileSlice';
import {
  resetSettingsState,
  spendingStatus,
} from '@settingsView/frontend/settingsState';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { assertSupported } from '@shared/utils/dispatcher';

function profileMessage(remaining: number) {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
    authenticated: true,
    user: null,
    tier: 'Ultra',
    apiAccessMode: 'personal' as const,
    sessionProblem: null,
    spendingStatus: {
      currentSpend: 100 - remaining,
      limit: 100,
      remaining,
      percentUsed: 100 - remaining,
    },
    quotaAutoSwitched: remaining <= 0,
    providerKeyStatuses: [],
    globalStreamingDefault: true,
  };
}

describe('included access exhaustion state', () => {
  beforeEach(() => resetSettingsState());

  it('tracks refreshed quota status without retaining the exhausted state', () => {
    const handleProfile = assertSupported(
      profileHandlers[SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE],
    );
    handleProfile(profileMessage(0));
    expect(spendingStatus.get()?.remaining).toBe(0);

    handleProfile(profileMessage(40));
    expect(spendingStatus.get()?.remaining).toBe(40);
  });
});
