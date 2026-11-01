// Node imports
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { Schema } from 'effect';
import { RpcSchema } from 'effect/rpc';
import { describe, expect, it } from 'vitest';

import { PROTOCOL, TexraRpcs } from '@texra/controllers/server/protocol';
import { REPO_ROOT } from '../support/repoScan';

/**
 * The service protocol's version moves with its shapes: a payload, success
 * or error schema that changes (a harness schema the protocol carries
 * included) fails here until `npm run protocol:bump` advances
 * `PROTOCOL.version` and rewrites `PROTOCOL.shapes` in the same edit.
 */
const PROTOCOL_FILE = resolve(
  REPO_ROOT,
  'packages/texra/src/controllers/server/protocol.ts',
);
const BUMPING = process.env.MODE === 'bump';

/** A procedure's shape: its schemas as JSON Schema, a stream by its parts. */
const shapes = Object.fromEntries(
  [...TexraRpcs.requests].map(([tag, rpc]) => {
    const success = rpc.successSchema;
    const schemas = RpcSchema.isStreamSchema(success)
      ? [rpc.payloadSchema, success.success, success.error, rpc.errorSchema]
      : [rpc.payloadSchema, success, rpc.errorSchema];
    const json = JSON.stringify(
      schemas.map((schema) => Schema.toJsonSchemaDocument(schema)),
    );
    return [tag, createHash('sha256').update(json).digest('hex').slice(0, 12)];
  }),
);

const moved = [
  ...new Set([...Object.keys(shapes), ...Object.keys(PROTOCOL.shapes)]),
]
  .filter((tag) => shapes[tag] !== PROTOCOL.shapes[tag])
  .toSorted();

describe('service protocol version', () => {
  it.skipIf(BUMPING)('records every procedure at the current version', () => {
    expect(
      moved,
      `${moved.join(', ')} changed shape under protocol ${PROTOCOL.version}; run \`npm run protocol:bump\``,
    ).toEqual([]);
  });

  it.runIf(BUMPING && moved.length > 0)('bumps the version', () => {
    const table = Object.entries(shapes)
      .map(([tag, hash]) => `    '${tag}': '${hash}',`)
      .join('\n');
    const source = readFileSync(PROTOCOL_FILE, 'utf8')
      .replace(/(\n {2}version: )\d+/, `$1${PROTOCOL.version + 1}`)
      .replace(/(\n {2}shapes: )\{[^}]*\}/, `$1{\n${table}\n  }`);
    writeFileSync(PROTOCOL_FILE, source);
  });
});
