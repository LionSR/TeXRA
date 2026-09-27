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
 * One installed plugin, persisted as a row of the `texra.plugins.installed`
 * setting: the one install record every host reads and writes (the CLI's
 * `texra plugin`, and the Skills page of the extension's and the desktop's
 * settings). The plugin keeps its own manifest (`.claude-plugin/plugin.json`
 * or `.codex-plugin/plugin.json`); this row is only where it lives, whether
 * it is enabled, and the skill directories resolved at install or update,
 * which stand in for a manifest the plugin does not have.
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
  /**
   * Whether the plugin loads. An install records it disabled; enabling it
   * asks the user to trust the version it is at (`texra.plugins.trusted`).
   * A disabled plugin stays installed and pinned, and contributes nothing.
   */
  enabled: z.boolean(),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

/**
 * One trust decision the user accepted, persisted as a row of
 * `texra.plugins.trusted`: the plugin at one version, running exactly what
 * `digest` covers (each MCP server's spec and the files it executes). An
 * enabled plugin loads only while its current version and digest match its
 * row, so another version, or an edit to what it runs, asks again.
 */
export const PluginTrustSchema = z.object({
  name: SkillNameSchema,
  version: z.string().nullable(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PluginTrust = z.infer<typeof PluginTrustSchema>;
