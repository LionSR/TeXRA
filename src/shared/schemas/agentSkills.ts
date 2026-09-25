import { z } from 'zod';

import { SkillNameSchema } from './skillName';

export const AGENT_SKILLS_CONFIG_KEY = 'texra.skills.enabled';
export const AGENT_SKILLS_ENABLED_DEFAULT = false;

/** Whether tool-use agents receive the available TeXRA and imported skills. */
export const AgentSkillsEnabledSchema = z
  .boolean()
  .describe(
    'Discover TeXRA and imported skills and expose them to tool-use agent prompts',
  );

/**
 * One plugin `texra plugin install` recorded, persisted as a row of the
 * `texra.plugins.installed` setting. The plugin keeps its own manifest
 * (`.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`); this row is
 * only where it lives and which of its directories hold skills, resolved once
 * at install or update so discovery reads data rather than manifests.
 *
 * `name` takes the skill-name grammar, which also makes it a safe single path
 * segment for the managed `plugins/<name>` directory. `commit` is set exactly
 * when TeXRA fetched the plugin with git and owns its directory; a local
 * plugin is referenced in place and has none.
 */
export const InstalledPluginSchema = z.object({
  name: SkillNameSchema,
  /** The git URL fetched from, or the absolute path of a local plugin. */
  source: z.string().min(1),
  /** The git ref asked for at install; absent means the remote's HEAD. */
  ref: z.string().min(1).optional(),
  /** The commit the managed checkout is pinned to. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .optional(),
  /** Absolute path of the plugin root, the directory holding its manifest. */
  path: z.string().min(1),
  /** Absolute skill roots inside `path`, each holding `<skill>/SKILL.md`. */
  skills: z.array(z.string().min(1)),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;
