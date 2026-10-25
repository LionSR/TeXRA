// Node imports
import * as assert from 'node:assert';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { Effect, Schema } from 'effect';
import { it } from '@effect/vitest';
import { describe, afterEach, beforeEach, expect } from 'vitest';

// Local imports
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { documentTaskKey } from '@texra/agent/output/documentRecipe';
import { DOCUMENT_TASK_BLOCK } from '@texra/shared/plugins/documents';
import {
  rejectOversizedBibAttachments,
  taskFileVars,
} from '@texra/tools/documents/documentTask';

describe('documentTask', () => {
  // The bib-size probe reads the real filesystem, so the cases build a real
  // tree whose files carry the sizes under test rather than stubbing a `stat`.
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'texra-bib-size-'));
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  async function bibFile(relativePath: string, size: number): Promise<void> {
    const target = path.join(workspaceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '');
    await truncate(target, size);
  }

  it.effect.each([
    {
      name: 'rejects context .bib files in the multi-list larger than 100KB',
      sizeBytes: 150 * 1024,
      paths: ['paper.tex', 'bibliography/main.bib'],
      rejectedPath: 'bibliography/main.bib',
    },
  ])('$name', ({ sizeBytes, paths, rejectedPath }) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => bibFile(rejectedPath, sizeBytes));

      const result = yield* rejectOversizedBibAttachments(
        workspaceRoot,
        paths,
      ).pipe(Effect.provide(nodePlatformLayer));

      assert.strictEqual(result?.status, 'error');
      assert.strictEqual(
        result?.summary,
        'Rejected oversized BibTeX attachment',
      );
      assert.strictEqual(
        result?.error,
        `${rejectedPath} is ${sizeBytes} bytes, over the 102400 byte limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`,
      );
      assert.deepStrictEqual(result?.diagnostics, {
        type: 'oversized_bib_attachment',
        path: rejectedPath,
        sizeBytes,
        limitBytes: 102400,
      });
    }),
  );

  it.effect('allows .bib files at the 100KB limit', () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => bibFile('library.bib', 100 * 1024));

      const result = yield* rejectOversizedBibAttachments(workspaceRoot, [
        'library.bib',
      ]).pipe(Effect.provide(nodePlatformLayer));

      assert.strictEqual(result, null);
    }),
  );

  describe('task.files custom variables', () => {
    const task = (files: Record<string, string>) =>
      Schema.decodeUnknownSync(DOCUMENT_TASK_BLOCK.schema)({
        files,
        requests: ['Revise.'],
      });
    const agentPath = () => path.join(workspaceRoot, 'agents', 'generic.yaml');

    beforeEach(async () => {
      await mkdir(path.join(workspaceRoot, 'agents'), { recursive: true });
      await writeFile(
        path.join(workspaceRoot, 'agents', 'brief.txt'),
        'briefing notes',
      );
    });

    // A required file named after a file category generates the fixed X_FILE /
    // X_CONTENT variables and would silently override them. The guard fails
    // loudly at variable-build time instead.
    it.effect.each(['INPUT', 'CONTEXT', 'EDITED', 'MEDIA'])(
      'rejects a required file named %s whose generated variables collide with the fixed vocabulary',
      (varName) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            taskFileVars(task({ [varName]: 'brief.txt' }), agentPath()).pipe(
              Effect.provide(nodePlatformLayer),
            ),
          );
          expect(String(failure)).toContain(
            'collides with a fixed template variable',
          );
        }),
    );

    it.effect('binds a custom required file beside the agent file', () =>
      Effect.gen(function* () {
        const { vars, entries } = yield* taskFileVars(
          task({ BRIEF: 'brief.txt' }),
          agentPath(),
        ).pipe(Effect.provide(nodePlatformLayer));
        const briefPath = path.join(workspaceRoot, 'agents', 'brief.txt');

        expect(vars).toStrictEqual({
          BRIEF_FILE: briefPath,
          BRIEF_CONTENT: 'briefing notes',
        });
        expect(entries).toStrictEqual([
          { path: briefPath, ok: true, varName: 'BRIEF', source: 'task.files' },
        ]);
      }),
    );
  });

  // The main view's picker spells the agent source-qualified and the launch
  // stamps the resolved source beside it: the task's tools must look up that
  // one entry, never `builtIn:builtIn:polish`.
  it.each([
    { agent: 'builtIn:polish', agentSource: 'builtIn' as const },
    { agent: 'polish', agentSource: 'builtIn' as const },
    { agent: 'builtIn:polish', agentSource: undefined },
  ])('keys $agent with source $agentSource to builtIn:polish', (config) => {
    expect(documentTaskKey(config)).toBe('builtIn:polish');
  });
});
