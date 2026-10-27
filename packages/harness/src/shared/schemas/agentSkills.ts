import { Schema } from 'effect';

import { Sha256Schema } from './offeredTools';
import { SkillNameSchema } from './skillName';

/**
 * The setting key that turns skill discovery on for agents; the run loop and
 * the CLI's `skills` command read it through `Settings`.
 */
export const AGENT_SKILLS_CONFIG_KEY = 'texra.skills.enabled';
/**
 * The value of {@link AGENT_SKILLS_CONFIG_KEY} when the user has not set it:
 * skills stay off until opted into.
 */
export const AGENT_SKILLS_ENABLED_DEFAULT = false;

/** Whether agents receive the skills discovered from every source. */
export const AgentSkillsEnabledSchema = Schema.Boolean.annotate({
  description:
    'Discover the skills of every source and expose them to agent prompts',
});

/**
 * The trust decision the user accepted for an installed plugin: the version
 * it was at and a digest of every file it ships and what its MCP servers run
 * (their specs, a keyed digest of their env values, and the external
 * commands and files they name). The plugin loads only while its current
 * version and digest match, so another version, or any edit, asks again.
 */
const PluginTrustSchema = Schema.Struct({
  version: Schema.NullOr(Schema.String),
  digest: Sha256Schema,
});
/** The decoded shape of the trust record kept on an {@link InstalledPlugin}. */
export type PluginTrust = typeof PluginTrustSchema.Type;

/**
 * One installed plugin, persisted as a row of the `texra.plugins.installed`
 * state: the one install record every host reads and writes (a CLI's
 * plugin command, a settings page). The plugin keeps its own manifest
 * (`.claude-plugin/plugin.json` or `.codex-plugin/plugin.json`); this row is
 * where it lives, whether it is
 * enabled, the trust given to it, and what stands in for a manifest the
 * plugin does not have (the marketplace entry's skill directories, version
 * and description).
 *
 * `name` takes the skill-name grammar, which also makes it a safe single path
 * segment for the managed `plugins/<name>` directory. `commit` is set exactly
 * when the harness fetched the plugin with git and owns its directory; a local
 * plugin is referenced in place and has none.
 */
export const InstalledPluginSchema = Schema.Struct({
  name: SkillNameSchema,
  /** The git URL fetched from, or the absolute path of a local plugin. */
  source: Schema.NonEmptyString,
  /** The git ref asked for at install; absent means the remote's HEAD. */
  ref: Schema.optional(Schema.NonEmptyString),
  /** The commit the managed checkout is pinned to. */
  commit: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[0-9a-f]{40,64}$/)),
  ),
  /** Absolute path of the plugin root, the directory holding its manifest. */
  path: Schema.NonEmptyString,
  /** Absolute skill roots inside `path`, each holding `<skill>/SKILL.md`. */
  skills: Schema.Array(Schema.NonEmptyString),
  /** The marketplace entry's version and description, for a plugin with no
   *  manifest of its own. */
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /**
   * Whether the plugin loads. An install records it disabled; enabling it
   * asks the user to trust it as it is (`trust`). A disabled plugin stays
   * installed, pinned and trusted, and contributes nothing.
   */
  enabled: Schema.Boolean,
  /** The last trust decision the user accepted; kept in the same row, so
   *  one write changes both, and removing the plugin removes its trust. */
  trust: Schema.optional(PluginTrustSchema),
});
/** The decoded shape of {@link InstalledPluginSchema}. */
export type InstalledPlugin = typeof InstalledPluginSchema.Type;
