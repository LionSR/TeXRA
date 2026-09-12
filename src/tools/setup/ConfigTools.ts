/**
 * Read and update TeXRA's `texra.*` configuration during onboarding.
 *
 * Two narrow tools: `read_config` (read-only) and `update_config` (writes,
 * gated by a strict per-key allowlist). Together they let the setup
 * assistant teach the user about a setting, show its current value, and
 * change it transparently — without giving an LLM unfettered write access
 * to arbitrary configuration. Anything outside the allowlist must still be
 * edited through the regular host settings surface.
 */

import { Effect } from 'effect';
import { z } from 'zod';

import { ToolCall } from '@agent/runtime/ToolCall';
import { hostPort } from '@common/hostPort';
import {
  settingByKey,
  settingSchemaWithoutPrefault,
  ToolError,
  type StateSettingEntry,
} from '@shared/schemas';

import { executed } from '@tools/core/result';
import { defineTool } from '../core/define';

/**
 * Keys `update_config` may write. Read access (`read_config`) is open across
 * all `texra.*` keys, but writes are limited to this allowlist so a
 * hallucinated payload cannot flip an arbitrary setting. Each key's value
 * schema and description come from the settings catalog, so the tool
 * validates against, and explains, exactly what every host reads. The catalog
 * is consulted when a tool runs, never while this module loads.
 */
const UPDATABLE_KEY_LIST = [
  'texra.bib.defaultPath',
  'texra.bib.zoteroPort',
  'texra.audio.soxPath',
  'texra.latex.tikzInputDirectory',
  'texra.git.numberOfCommitsToShow',
  'texra.maxImageDimension',
] as const;

type UpdatableKey = (typeof UPDATABLE_KEY_LIST)[number];

function catalogEntry(key: UpdatableKey): StateSettingEntry {
  const entry = settingByKey(key);
  if (!entry) {
    throw new Error(`update_config allowlist key ${key} is not in the catalog`);
  }
  return entry;
}

const ALLOWLIST_TEXT = UPDATABLE_KEY_LIST.map((key) => `- \`${key}\``).join(
  '\n',
);

const ReadConfigInputSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .regex(
      /^texra\./,
      'Only TeXRA configuration keys are readable through this tool. Pass a key starting with "texra.".',
    )
    .describe(
      'Configuration key starting with "texra." (e.g. texra.bib.defaultPath).',
    ),
});

type ReadConfigInput = z.infer<typeof ReadConfigInputSchema>;

export class ReadConfigTool extends defineTool({
  name: 'read_config',
  description: `Read the effective value of a TeXRA configuration key.

Accepts any key starting with \`texra.\`. Returns the current resolved value (workspace value if set, else user, else default). Use this when teaching the user what a setting controls: read first, explain, then propose a change with \`update_config\`.`,
  schema: ReadConfigInputSchema,
}) {
  protected execute(input: ReadConfigInput) {
    return Effect.gen(function* () {
      const call = yield* ToolCall;
      const value = call.config.get(input.key);
      const json = JSON.stringify(value, null, 2) ?? 'undefined';
      const description = settingByKey(input.key)?.description;
      return executed(
        `${input.key}:\n${json}${description ? `\n\n${description}` : ''}`,
        `Read ${input.key}`,
      );
    });
  }
}

const UpdateConfigInputSchema = z.strictObject({
  key: z
    .enum(UPDATABLE_KEY_LIST)
    .describe(
      `Configuration key to update. Must be on the setup allowlist:\n${ALLOWLIST_TEXT}`,
    ),
  value: z
    .unknown()
    .describe(
      "New value, validated against the setting's schema. Call read_config first to see what the setting controls.",
    ),
  target: z
    .enum(['user', 'workspace'])
    .prefault('user')
    .describe(
      '"user" updates the global setting shared across workspaces; "workspace" scopes the change to the current workspace only.',
    ),
});

type UpdateConfigInput = z.infer<typeof UpdateConfigInputSchema>;

const updateConfig = Effect.fn('UpdateConfigTool.execute')(function* (
  input: UpdateConfigInput,
) {
  const entry = catalogEntry(input.key);
  const schema = settingSchemaWithoutPrefault(entry) as z.ZodType;
  const parsed = schema.safeParse(input.value);
  if (!parsed.success) {
    return yield* Effect.fail(
      new ToolError(
        `Value rejected for ${input.key}: ${z.prettifyError(parsed.error)}. ${entry.description ?? ''}`,
      ),
    );
  }

  const call = yield* ToolCall;
  const config = call.config;
  const previous = config.get(input.key);
  yield* hostPort(() =>
    config.update(
      input.key,
      parsed.data,
      input.target === 'workspace' ? 'workspace' : 'global',
    ),
  );

  const before = JSON.stringify(previous);
  const after = JSON.stringify(parsed.data);
  return executed(
    `Updated ${input.key} (${input.target} scope): ${before ?? 'undefined'} → ${after}.`,
    `Updated ${input.key} (${input.target})`,
  );
});

export class UpdateConfigTool extends defineTool({
  name: 'update_config',
  requiresApproval: true,
  description: `Update a TeXRA configuration value (allowlisted keys only).

Use this AFTER calling \`read_config\` and explaining to the user what the setting does and what the new value will mean. Explain every change clearly. Pass \`target: "workspace"\` only when the change is genuinely workspace-specific (e.g. a project-local bib path); default to \`"user"\` for general preferences shared across workspaces.

Allowlisted keys:
${ALLOWLIST_TEXT}

Anything outside this list must be changed through the host's regular configuration surface.`,
  schema: UpdateConfigInputSchema,
}) {
  protected execute(input: UpdateConfigInput) {
    return updateConfig(input);
  }
}
