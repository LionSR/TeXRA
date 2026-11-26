/**
 * How a skill source reads in every host: its name, which the settings
 * view groups and tags skills by, and its switch, which the settings view
 * and the terminal's `/config` both toggle.
 */
import type { ActiveSkillSourceScope } from '@texra-ai/worldline/schemas';

/** Each skill source's name. */
export const SKILL_SOURCE_LABEL = Object.freeze({
  bundled: 'Bundled',
  project: 'Project',
  user: 'User',
  custom: 'Custom',
  interop: 'Imported',
} satisfies Record<ActiveSkillSourceScope, string>);

/** The switch that turns a whole skill source on or off. */
export function skillSourceToggleLabel(scope: ActiveSkillSourceScope): string {
  return `Use ${SKILL_SOURCE_LABEL[scope].toLowerCase()} skills`;
}
