// Node imports
import * as assert from 'node:assert';
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { Deferred, Effect } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect, afterEach, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  submitFollowUp: vi.fn(),
}));

vi.mock('@agent/followUp/ToolUseFollowUp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/followUp/ToolUseFollowUp')>()),
  submitFollowUp: mocks.submitFollowUp,
}));

// Local imports
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { AgentCategory, type RunId } from '@shared/schemas';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { DelegateAgentTool } from '@tools/delegation/DelegationTools';
import { rejectOversizedBibAttachments } from '@tools/delegation/inputFields';

describe('DelegationTools', () => {
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
      formattedSize: '150 KiB',
    },
  ])('$name', ({ sizeBytes, paths, rejectedPath, formattedSize }) =>
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
        `${rejectedPath} is ${sizeBytes} bytes (${formattedSize}), over the 102400 byte (100 KiB) limit. Call extract_bib_entries first if citations are needed, then re-propose without the full .bib file.`,
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
});
