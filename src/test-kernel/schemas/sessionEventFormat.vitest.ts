/**
 * `SESSION_EVENT_FORMAT` names the stored vocabulary a session database
 * holds; `Database` moves a store stamped with an older version aside at
 * open and refuses a newer one. The version is only meaningful if it moves with the shape, so this
 * suite pins the shape: a change to what `SessionEventSchema`, or a built-in
 * plugin's row arm (`@tools/pluginArms`), stores fails
 * here until the version is bumped and the snapshot regenerated
 * (`vitest -u`), which is also the moment to weigh that every existing
 * store starts fresh after the bump. The fingerprint is the JSON-schema shape,
 * so a change to a `refine` predicate alone is invisible to it: such a
 * change bumps the version by hand.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SESSION_EVENT_FORMAT, SessionEventSchema } from '@shared/schemas';
import { PLUGIN_ARMS } from '@tools/pluginArms';

const SNAPSHOT = fileURLToPath(
  new URL('./__snapshots__/sessionEventFormat.json', import.meta.url),
);

describe('the stored session event format', () => {
  it('moves its version with its shape', async () => {
    // Core's arms and every built-in plugin's: a plugin row's value is
    // stored in the same format.
    const jsonSchema = (schema: z.ZodType) =>
      z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' });
    const shape = {
      core: jsonSchema(SessionEventSchema),
      plugins: [...PLUGIN_ARMS]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([kind, arm]) => [kind, jsonSchema(arm.schema)]),
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(shape))
      .digest('hex');
    const current = { format: SESSION_EVENT_FORMAT, fingerprint };
    if (existsSync(SNAPSHOT)) {
      const pinned = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as {
        format: number;
        fingerprint: string;
      };
      if (
        pinned.fingerprint !== fingerprint &&
        pinned.format === SESSION_EVENT_FORMAT
      ) {
        expect.fail(
          `The stored shape of SessionEventSchema changed (pinned ${pinned.fingerprint.slice(0, 12)}, now ${fingerprint.slice(0, 12)}) but SESSION_EVENT_FORMAT is still ${SESSION_EVENT_FORMAT}. Bump it in src/shared/schemas/sessionEvent.ts (every existing texra.db is moved aside on its next open), delete this snapshot, and regenerate it with vitest -u.`,
        );
      }
    }
    await expect(`${JSON.stringify(current, null, 2)}\n`).toMatchFileSnapshot(
      SNAPSHOT,
    );
  });
});
