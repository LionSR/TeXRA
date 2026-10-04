import { z } from 'zod';

import { Sha256Schema } from './offeredTools';
import { SkillNameSchema } from './skillName';

export const AGENT_SKILLS_CONFIG_KEY = 'texra.skills.enabled';
export const AGENT_SKILLS_ENABLED_DEFAULT = false;

/** Whether agents receive the available TeXRA and imported skills. */
export const AgentSkillsEnabledSchema = z
  .boolean()
  .describe(
    'Discover TeXRA and imported skills and expose them to agent prompts',
  );

/**
 * The trust decision the user accepted for an installed plugin: the version
 * it was at and a digest of every file it ships and what its MCP servers run
 * (their specs, a keyed digest of their env values, and the external
 * commands and files they name). The plugin loads only while its current
 * version and digest match, so another version, or any edit, asks again.
 */
const PluginTrustSchema = z.object({
  version: z.string().nullable(),
  digest: Sha256Schema,
});
export type PluginTrust = z.infer<typeof PluginTrustSchema>;

/**
 * One installed plugin, persisted as a row of the `texra.plugins.installed`
 * state: the one install record every host reads and writes (the CLI's
 * `texra plugin`, and the Skills page of the extension's and the desktop's
 * settings). The plugin keeps its own manifest (`.claude-plugin/plugin.json`
 * or `.codex-plugin/plugin.json`); this row is where it lives, whether it is
 * enabled, the trust given to it, and what stands in for a manifest the
 * plugin does not have (the marketplace entry's skill directories, version
 * and description).
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
  /** The marketplace entry's version and description, for a plugin with no
   *  manifest of its own. */
  version: z.string().optional(),
  description: z.string().optional(),
  /**
   * Whether the plugin loads. An install records it disabled; enabling it
   * asks the user to trust it as it is (`trust`). A disabled plugin stays
   * installed, pinned and trusted, and contributes nothing.
   */
  enabled: z.boolean(),
  /** The last trust decision the user accepted; kept in the same row, so
   *  one write changes both, and removing the plugin removes its trust. */
  trust: PluginTrustSchema.optional(),
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;
