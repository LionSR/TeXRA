// Node imports
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { Effect, Schema } from 'effect';
import { it } from '@effect/vitest';
import { afterEach, beforeEach, describe, expect } from 'vitest';

// Local imports
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { DOCUMENT_TASK_BLOCK } from '@texra/shared/plugins/documents';
import { taskFileVars } from '@texra/tools/documents/documentTask';

describe('documentTask task.files custom variables', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'texra-task-files-'));
    await mkdir(path.join(workspaceRoot, 'agents'), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, 'agents', 'brief.txt'),
      'briefing notes',
    );
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  // A required file named after a file category generates the fixed X_FILE /
  // X_CONTENT variables and would silently override them. The guard fails
  // loudly at variable-build time instead.
  it.effect(
    'rejects a required file named INPUT whose generated variables collide with the fixed vocabulary',
    () =>
      Effect.gen(function* () {
        const task = Schema.decodeUnknownSync(DOCUMENT_TASK_BLOCK.schema)({
          files: { INPUT: 'brief.txt' },
          requests: ['Revise.'],
        });
        const failure = yield* Effect.flip(
          taskFileVars(
            task,
            path.join(workspaceRoot, 'agents', 'generic.yaml'),
          ).pipe(Effect.provide(nodePlatformLayer)),
        );
        expect(String(failure)).toContain(
          'collides with a fixed template variable',
        );
      }),
  );
});
