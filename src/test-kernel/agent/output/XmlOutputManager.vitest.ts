import { it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';

import { type RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
import { XmlOutputManager } from '@texra/agent/output/XmlOutputManager';
import { createOutputState } from '@texra/agent/output/outputState';
import { assignByContentSimilarity } from '@texra/agent/output/extraction/contentSimilarity';
import { createExternalLocation } from '@utils/files/fileLocation';
import { RunFileService } from '@utils/files/runStorage';

const RUN_ID = 'xml-output-manager-test' as RunId;

interface XmlManagerOptions {
  outputFiles?: string[];
  /** Run-relative names of the files a similarity fallback may match against. */
  baseFiles?: string[];
}

function createXmlManager(
  inputFiles: string[] = ['paper.tex'],
  options: XmlManagerOptions = {},
): XmlOutputManager {
  const logger = spiedTrace(
    {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      emit: vi.fn(),
    },
    { strict: true },
  );
  return new XmlOutputManager(
    {
      inputFiles,
      outputFiles: options.outputFiles ?? [],
    } as unknown as AgentConfig,
    logger,
    new RunFileService(RUN_ID, testWorkspaceRoots()),
    createOutputState(),
    testWorkspaceRoots().config,
  );
}

/** Seed the run directory: the fake host roots every path in a real temp
 *  directory, so the cases run as `it.live`. */
const write = (target: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(target, content);
  });

/** Write a response and unpack it through the extraction pipeline. */
const writeAndSplitDocuments = Effect.fn('writeAndSplitDocuments')(function* (
  output: readonly string[],
  inputFiles: string[] = ['paper.tex'],
  options: XmlManagerOptions = {},
) {
  yield* write(fakePath('tmp/run/output.xml'), output.join('\n'));
  return yield* createXmlManager(
    inputFiles,
    options,
  ).splitScratchpadMultipleOutputXml(
    createExternalLocation(fakePath('tmp/run/output.xml')),
    0,
    options.baseFiles?.map((name) =>
      createExternalLocation(fakePath('tmp/run', name)),
    ),
  );
});

const expectWritten = Effect.fn('expectWritten')(function* (
  path: string,
  content: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const written = yield* fs.readFileString(fakePath('tmp/run', path));
  expect(written).toBe(content);
});

/**
 * A recovery scenario: the raw output lines, the input files (the default
 * single `paper.tex` when null), and the files that must be written, keyed
 * by run-relative path in expected source order.
 */
type RecoveryCase = [
  name: string,
  output: string[],
  inputFiles: string[] | null,
  files: Record<string, string>,
];

const RECOVERY_CASES: readonly RecoveryCase[] = [
  [
    'keeps percent filename comments inside a LaTeX document body',
    [
      '% main.tex',
      '\\documentclass{article}',
      '\\begin{document}',
      '% notes.tex',
      'Still the main document.',
      '\\end{document}',
      '% appendix.tex',
      'Appendix text.',
    ],
    null,
    {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '% notes.tex',
        'Still the main document.',
        '\\end{document}',
        '',
      ].join('\n'),
      'appendix.tex': 'Appendix text.\n',
    },
  ],
  [
    'avoids percent filename suffix collisions with explicit headers',
    [
      '% chunk.tex',
      'First.',
      '% chunk-2.tex',
      'Explicit suffix.',
      '% chunk.tex',
      'Second duplicate.',
    ],
    null,
    {
      'chunk.tex': 'First.\n',
      'chunk-2.tex': 'Explicit suffix.\n',
      'chunk-3.tex': 'Second duplicate.\n',
    },
  ],
  [
    'recovers documents from bare filename labels with no % prefix',
    [
      '## Reflection',
      '',
      'Some narrative text about what changed.',
      '',
      'Draft/LeanMPSPaper/Draft3.tex:',
      '```latex',
      '\\documentclass{article}',
      '\\begin{document}',
      'Body one.',
      '\\end{document}',
      '```',
      '',
      'Draft/LeanMPSPaper/endmatter.tex:',
      '```latex',
      'End matter body.',
      '```',
    ],
    ['Draft/LeanMPSPaper/Draft3.tex', 'Draft/LeanMPSPaper/endmatter.tex'],
    {
      'Draft/LeanMPSPaper/Draft3.tex':
        '\\documentclass{article}\n\\begin{document}\nBody one.\n\\end{document}\n',
      'Draft/LeanMPSPaper/endmatter.tex': 'End matter body.\n',
    },
  ],
  [
    'keeps a bare label inside a verbatim block instead of splitting the fragment',
    [
      'main.tex:',
      '\\section{Listing}',
      '\\begin{verbatim}',
      'appendix.tex:',
      '\\end{verbatim}',
      'Tail.',
      'appendix.tex:',
      'Appendix content.',
    ],
    ['main.tex', 'appendix.tex'],
    {
      'main.tex':
        '\\section{Listing}\n\\begin{verbatim}\nappendix.tex:\n\\end{verbatim}\nTail.\n',
      'appendix.tex': 'Appendix content.\n',
    },
  ],
];

describe('XmlOutputManager', () => {
  beforeEach(async () => {
    await installPlatform({
      files: { '/tmp/run/output.xml': '<documents />' },
      workspacePath: fakePath('workspace'),
    });
  });

  for (const [name, output, inputFiles, files] of RECOVERY_CASES) {
    it.live(name, () =>
      Effect.gen(function* () {
        const outputs = yield* writeAndSplitDocuments(
          output,
          inputFiles ?? undefined,
        );
        expect(outputs.map((o) => o.source)).toEqual(Object.keys(files));
        for (const [source, content] of Object.entries(files)) {
          yield* expectWritten(source, content);
        }
      }).pipe(Effect.provide(nodePlatformLayer)),
    );
  }

  it.live(
    'falls back to content-similarity matching for unlabeled fenced blocks against the original inputs',
    () =>
      Effect.gen(function* () {
        yield* write(
          fakePath('tmp/run/appendices.tex'),
          '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture with a shared Lean repository.\n',
        );
        yield* write(
          fakePath('tmp/run/cost_section.tex'),
          '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nPreliminary numbers from the local interactive logs.\n',
        );

        // Response order is deliberately swapped relative to inputFiles, and
        // neither fence carries any filename label, to prove the match is
        // driven by content rather than declaration or response order.
        const outputs = yield* writeAndSplitDocuments(
          [
            '# Phase 2: Revised Documents',
            '',
            '```latex',
            '% !TEX root = Draft3SM.tex',
            '\\section{Computational cost}',
            'Revised numbers from the local interactive logs.',
            '```',
            '',
            '```latex',
            '\\appendix',
            '\\section{Agent architecture}',
            'The formalization system uses a multi-agent architecture with a persistent shared memory.',
            '```',
          ],
          ['appendices.tex', 'cost_section.tex'],
          { baseFiles: ['appendices.tex', 'cost_section.tex'] },
        );

        expect(outputs.map((output) => output.source).sort()).toEqual([
          'appendices.tex',
          'cost_section.tex',
        ]);
        yield* expectWritten(
          'appendices.tex',
          '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture with a persistent shared memory.\n',
        );
        yield* expectWritten(
          'cost_section.tex',
          '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nRevised numbers from the local interactive logs.\n',
        );
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  // Agents like ocr/paper2slide declare one `task.outputs` entry while
  // accepting several attached input files. The document tools then build
  // baseFiles from outputFiles, not inputFiles, so baseFiles[i] no longer
  // corresponds to inputFiles[i].
  it.live(
    'concatenates multiple unlabeled fences under the sole declared output',
    () =>
      Effect.gen(function* () {
        const outputs = yield* writeAndSplitDocuments(
          [
            'page1.png:',
            '```latex',
            'Page one transcription.',
            '```',
            '',
            'page2.png:',
            '```latex',
            'Page two transcription.',
            '```',
          ],
          ['page1.png', 'page2.png'],
          { outputFiles: ['ocr_result.tex'], baseFiles: ['ocr_result.tex'] },
        );

        expect(outputs.map((o) => o.source)).toEqual(['ocr_result.tex']);
        yield* expectWritten(
          'ocr_result.tex',
          'Page one transcription.\n\nPage two transcription.\n',
        );
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(fakePath('tmp/run/ocr_result-2.tex'))).toBe(
          false,
        );
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it.live(
    'leaves an unlabeled block unmatched when identical base files make the match ambiguous',
    () =>
      Effect.gen(function* () {
        const stub = '\\section{Stub}\nShared template content.\n';
        yield* write(fakePath('tmp/run/a.tex'), stub);
        yield* write(fakePath('tmp/run/b.tex'), stub);

        const outputs = yield* writeAndSplitDocuments(
          [
            '```latex',
            '\\section{Stub}',
            'Shared template content, revised.',
            '```',
          ],
          ['a.tex', 'b.tex'],
          { baseFiles: ['a.tex', 'b.tex'] },
        );

        // Both base files score identically, so there is no evidence which one
        // the block revises — refusing to guess beats corrupting one of them.
        expect(outputs).toEqual([]);
      }).pipe(Effect.provide(nodePlatformLayer)),
  );
});

describe('assignByContentSimilarity', () => {
  it('never routes a quoted original to a different, merely-similar file', () => {
    const costOriginal =
      'shared preamble line\ncontent about cost analysis\nshared footer line';
    const archOriginal =
      'shared preamble line\ncontent about system architecture\nshared footer line';
    const costRevision =
      'shared preamble line\ncontent about revised cost analysis\nshared footer line';

    const assigned = assignByContentSimilarity(
      [costOriginal, costRevision],
      [
        { name: 'cost.tex', content: `${costOriginal}\n` },
        { name: 'arch.tex', content: `${archOriginal}\n` },
      ],
    );

    // The revision claims cost.tex; the verbatim quote of cost.tex must stay
    // unmatched instead of falling back to arch.tex (which it resembles well
    // above the threshold through the shared boilerplate).
    expect(assigned[1]?.name).toBe('cost.tex');
    expect(assigned[0]).toBeNull();
  });
});
