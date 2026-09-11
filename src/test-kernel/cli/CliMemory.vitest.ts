// Third-party imports
import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
  formatCliMemoryList,
  loadCliMemoryDetail,
} from '@cli/runtime/memory';
import type { MemoryViewItem } from '@shared/schemas';

vi.mock('@tools/memory/memoryFileSystem', () => ({
  loadMemoryPreview: () => Effect.succeed({ lineCount: 1, preview: 'preview' }),
}));

const item: MemoryViewItem = {
  displayPath: '/memories/project.md',
  storagePath: 'memories/project.md',
  size: 2048,
  mtime: '2026-01-02T03:04:05.000Z',
  modifiedBy: 'researcher',
  pinned: true,
};

/** The squashed failure an exit carries, or undefined when it succeeded. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

describe('CLI memory formatting', () => {
  it('does not treat the Unix epoch as an unknown modification date', () => {
    const description = cliMemoryItemDescription({
      ...item,
      mtime: '1970-01-01T00:00:00.000Z',
    });

    expect(description).toContain('modified:');
    expect(description).not.toContain('modified: unknown');
  });

  it('limits long memory listings and reports hidden rows', () => {
    const list = formatCliMemoryList(
      Array.from({ length: CLI_MEMORY_LIST_LIMIT + 1 }, (_unused, index) => ({
        ...item,
        displayPath: `/memories/project-${index}.md`,
      })),
    );

    expect(list).toContain(`Memories (${CLI_MEMORY_LIST_LIMIT + 1}):`);
    expect(list).toContain('/memories/project-0.md');
    expect(list).not.toContain(`/memories/project-${CLI_MEMORY_LIST_LIMIT}.md`);
    expect(list).toContain('... 1 more');
  });

  it.effect.each([
    '/memories/project.md',
    'memories/project.md',
    'memories\\project.md',
    'project.md',
  ])('accepts the path form %s', (input) =>
    Effect.gen(function* () {
      const detail = yield* loadCliMemoryDetail(input);
      expect(detail).toMatchObject({
        path: '/memories/project.md',
      });
    }),
  );

  it.effect('rejects absolute paths outside the memory display root', () =>
    Effect.gen(function* () {
      const error = failureOf(
        yield* Effect.exit(loadCliMemoryDetail('/memoriesExtra')),
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Invalid memory path');
    }),
  );

  it.effect(
    'reports the original display path when a memory path escapes the root',
    () =>
      Effect.gen(function* () {
        const error = failureOf(
          yield* Effect.exit(loadCliMemoryDetail('/memories/../outside.md')),
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          'Invalid memory path: /memories/../outside.md',
        );
      }),
  );
});
