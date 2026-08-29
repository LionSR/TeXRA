import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsViewOutboundHandlerRegistry } from '@shared/schemas';

import {
  applySettingsSnapshot,
  skillLoadIssues,
  skillsList,
} from '../settingsState';

export const skillsHandlers = {
  [SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_SETTINGS]: (data) => {
    applySettingsSnapshot(data.values);
  },
  [SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST]: (data) => {
    skillsList.set(data.skills);
    skillLoadIssues.set(data.issues);
  },
} satisfies Partial<SettingsViewOutboundHandlerRegistry>;
