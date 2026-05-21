/**
 * Git author settings shared handlers.
 *
 * `readGitAuthorSettingsFromState` already lives in `@utils/system` and is
 * platform-agnostic; this module just composes the outbound message so both
 * hosts post it the same way.
 */
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import type { UpdateGitAuthorSettingsMessage } from '@shared/schemas/settingsViewMessages';
import {
  readGitAuthorSettingsFromState,
  type GitAuthorSettings,
} from '@utils/system/gitAuthorSettings';

import type { SettingsStatePorts } from './types';

export function buildGitAuthorSettingsMessage(
  ports: SettingsStatePorts,
  settings?: GitAuthorSettings,
): UpdateGitAuthorSettingsMessage {
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
    ...(settings ?? readGitAuthorSettingsFromState(ports.workspaceState)),
  };
}
