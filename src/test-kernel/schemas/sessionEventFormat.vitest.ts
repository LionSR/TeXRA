/**
 * `SESSION_EVENT_FORMAT` names the stored vocabulary a session database
 * holds, and `Database` clears a store stamped with any other version at
 * open. The version is only meaningful if it moves with the shape, so this
 * suite pins the shape: a change to what `SessionEventSchema` stores fails
 * here until the version is bumped and the snapshot regenerated
 * (`vitest -u`), which is also the moment to weigh that every existing
 * store is cleared by the bump. The fingerprint is the JSON-schema shape,
 * so a change to a `refine` predicate alone is invisible to it: such a
 * change bumps the version by hand.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SESSION_EVENT_FORMAT, SessionEventSchema } from '@shared/schemas';

const SNAPSHOT = fileURLToPath(
  new URL('./__snapshots__/sessionEventFormat.json', import.meta.url),
);

describe('the stored session event format', () => {
  it('moves its version with its shape', async () => {
    const shape = z.toJSONSchema(SessionEventSchema, {
      unrepresentable: 'any',
      io: 'input',
    });
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
          `The stored shape of SessionEventSchema changed (pinned ${pinned.fingerprint.slice(0, 12)}, now ${fingerprint.slice(0, 12)}) but SESSION_EVENT_FORMAT is still ${SESSION_EVENT_FORMAT}. Bump it in src/shared/schemas/sessionEvent.ts (every existing texra.db is cleared on its next open), delete this snapshot, and regenerate it with vitest -u.`,
        );
      }
    }
    await expect(`${JSON.stringify(current, null, 2)}\n`).toMatchFileSnapshot(
      SNAPSHOT,
    );
  });
});
