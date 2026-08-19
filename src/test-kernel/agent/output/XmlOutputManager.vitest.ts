import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { assignByContentSimilarity } from '@agent/implementations/flows/reflection/output/extraction/contentSimilarity';
import { OutputFileProcessor } from '@agent/implementations/flows/reflection/output/OutputFileProcessor';
import {
  createOutputState,
  ensureRoundData,
  type OutputDependencies,
} from '@agent/implementations/flows/reflection/output/outputState';
import { XmlOutputManager } from '@agent/implementations/flows/reflection/output/XmlOutputManager';
import type { FileLocation } from '@shared/schemas';
import { installPlatform } from '@test/support/setupPlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { createExternalLocation } from '@utils/files/fileLocation';
import { TaskRunFileService } from '@utils/files/taskRunStorage';

const formatterMocks = vi.hoisted(() => ({
  runLatexFormatter: vi.fn(),
}));

vi.mock('@latex/formatter/texFormatter', () => ({
  runLatexFormatter: formatterMocks.runLatexFormatter,
}));

interface XmlManagerOptions {
  outputFiles?: string[];
  /** Run-relative names of the files a similarity fallback may match against. */
  baseFiles?: string[];
  logger?: AgentTrace;
}

/**
 * Minimal OutputDependencies for OutputFileProcessor tests: the processor
 * reads only `baseFiles`, `logger`, and `runScope.streamId`.
 */
function processorDeps(overrides: {
  logger: AgentTrace;
  baseFiles?: FileLocation[];
}): OutputDependencies {
  return {
    baseFiles: overrides.baseFiles ?? [],
    logger: overrides.logger,
    runScope: { streamId: 'stream' },
  } as unknown as OutputDependencies;
}

function createXmlManager(
  inputFiles: string[] = ['paper.tex'],
  options: XmlManagerOptions = {},
): XmlOutputManager {
  const logger =
    options.logger ??
    spiedTrace(
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        domain: vi.fn(),
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
    new TaskRunFileService('xml-output-manager-test'),
    'xml-test@stream#1',
  );
}

async function writeAndSplitDocuments(
  output: string | readonly string[],
  inputFiles: string[] = ['paper.tex'],
  options: XmlManagerOptions = {},
): ReturnType<XmlOutputManager['splitScratchpadMultipleOutputXml']> {
  await AbsoluteFS.write(
    '/tmp/run/output.xml',
    typeof output === 'string' ? output : output.join('\n'),
  );
  return createXmlManager(inputFiles, options).splitScratchpadMultipleOutputXml(
    createExternalLocation('/tmp/run/output.xml'),
    0,
    'scratchpad',
    options.baseFiles?.map((name) =>
      createExternalLocation(`/tmp/run/${name}`),
    ),
  );
}

const RECOVERED_DOCUMENT_LINES = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Recovered.',
  '\\end{document}',
];
const RECOVERED_DOCUMENT_CONTENT = [...RECOVERED_DOCUMENT_LINES, ''].join('\n');

function expectSources(
  outputs: readonly { source: string }[],
  expected: readonly string[],
): void {
  expect(outputs.map((output) => output.source)).toEqual(expected);
}

async function expectWritten(path: string, content: string): Promise<void> {
  await expect(AbsoluteFS.read(`/tmp/run/${path}`)).resolves.toBe(content);
}

async function expectAbsent(path: string): Promise<void> {
  await expect(AbsoluteFS.exists(`/tmp/run/${path}`)).resolves.toBe(false);
}

async function assertRecoveredDocuments(
  outputs: readonly { source: string }[],
  files: Record<string, string>,
  absent: readonly string[] = [],
): Promise<void> {
  expectSources(outputs, Object.keys(files));
  for (const [source, content] of Object.entries(files)) {
    await expectWritten(source, content);
  }
  for (const path of absent) {
    await expectAbsent(path);
  }
}

/**
 * A recovery scenario against the default single `paper.tex` input: the raw
 * output lines, the files that must be written (keyed by run-relative path,
 * in expected source order), and any paths that must not be written.
 */
// Mutable tuple types: vitest's it.each infers spread-arg callback types only
// for mutable tuples (readonly tuples with optional elements hit its
// union-of-elements fallback).
type RecoveryCase = [
  name: string,
  output: string[],
  files: Record<string, string>,
  absent?: string[],
];

/** Same as RecoveryCase but with explicit input files. */
type LabeledRecoveryCase = [
  name: string,
  output: string[],
  inputFiles: string[],
  files: Record<string, string>,
  absent?: string[],
];

const RECOVERY_CASES: readonly RecoveryCase[] = [
  [
    'removes surrounding markdown fences from percent filename output',
    ['```latex', '% main.tex', ...RECOVERED_DOCUMENT_LINES, '```'],
    { 'main.tex': RECOVERED_DOCUMENT_CONTENT },
  ],
  [
    'removes compact markdown fence info strings after percent headers',
    ['% main.tex', '```latex', ...RECOVERED_DOCUMENT_LINES, '```'],
    { 'main.tex': RECOVERED_DOCUMENT_CONTENT },
  ],
  [
    'removes spaced markdown fence info strings after percent headers',
    ['% main.tex', '``` latex', ...RECOVERED_DOCUMENT_LINES, '```'],
    { 'main.tex': RECOVERED_DOCUMENT_CONTENT },
  ],
  [
    'recovers documents from percent filename headers',
    [
      'Here is the output:',
      '% main.tex',
      '\\section{Recovered}',
      '% sections/appendix.tex',
      'Appendix text.',
    ],
    {
      'main.tex': '\\section{Recovered}\n',
      'sections/appendix.tex': 'Appendix text.\n',
    },
  ],
  [
    'preserves fence-looking lines inside percent-header content',
    [
      '% main.tex',
      '\\documentclass{article}',
      '\\begin{document}',
      '\\begin{verbatim}',
      '```',
      '\\end{verbatim}',
      '\\end{document}',
    ],
    {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\begin{verbatim}',
        '```',
        '\\end{verbatim}',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ],
  [
    'prefers named document fallback over percent filename comments',
    [
      '<document name="main.tex">',
      'Main body.',
      '% notes.tex',
      'Still main body.',
      '</document>',
      '<document name="appendix.tex">',
      'Appendix body.',
      '</document>',
    ],
    {
      'main.tex': 'Main body.\n% notes.tex\nStill main body.\n',
      'appendix.tex': 'Appendix body.\n',
    },
    ['notes.tex'],
  ],
  [
    'prefers percent filename headers over single-document input recovery',
    ['% declared.tex', ...RECOVERED_DOCUMENT_LINES],
    { 'declared.tex': RECOVERED_DOCUMENT_CONTENT },
    ['paper.tex'],
  ],
  [
    'recovers dot-prefixed relative percent filename headers',
    [
      '% ./main.tex',
      'Main text.',
      '% ./sections/appendix.tex',
      'Appendix text.',
    ],
    {
      'main.tex': 'Main text.\n',
      'sections/appendix.tex': 'Appendix text.\n',
    },
  ],
  [
    'recovers hyphenated percent filename headers',
    ['% main-file.tex', 'Main text.', '% sections/part-1.tex', 'Part text.'],
    {
      'main-file.tex': 'Main text.\n',
      'sections/part-1.tex': 'Part text.\n',
    },
  ],
  [
    'recovers underscore-prefixed percent filename headers',
    [
      '% _macros.tex',
      '\\newcommand{\\R}{\\mathbb{R}}',
      '% _generated/main.tex',
      'Generated text.',
    ],
    {
      '_macros.tex': '\\newcommand{\\R}{\\mathbb{R}}\n',
      '_generated/main.tex': 'Generated text.\n',
    },
  ],
  [
    'recovers backslash-separated percent filename headers',
    ['% sections\\intro.tex', 'Intro text.'],
    {
      'sections/intro.tex': 'Intro text.\n',
    },
  ],
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
    'keeps percent filename comments in a LaTeX document preamble',
    [
      '% main.tex',
      '\\documentclass{article}',
      '% macros.tex',
      '\\begin{document}',
      'Body.',
      '\\end{document}',
      '% appendix.tex',
      'Appendix text.',
    ],
    {
      'main.tex': [
        '\\documentclass{article}',
        '% macros.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
        '',
      ].join('\n'),
      'appendix.tex': 'Appendix text.\n',
    },
  ],
  [
    'keeps multiple percent filename comments in a LaTeX document preamble',
    [
      '% main.tex',
      '\\documentclass{article}',
      '% macros.tex',
      '% notation.tex',
      '\\begin{document}',
      'Body.',
      '\\end{document}',
      '% appendix.tex',
      'Appendix text.',
    ],
    {
      'main.tex': [
        '\\documentclass{article}',
        '% macros.tex',
        '% notation.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
        '',
      ].join('\n'),
      'appendix.tex': 'Appendix text.\n',
    },
  ],
  [
    'does not treat pre-header LaTeX preamble comments as percent outputs',
    [
      '\\documentclass{article}',
      '% macros.tex',
      '\\begin{document}',
      'Body.',
      '\\end{document}',
    ],
    {
      'paper.tex': [
        '\\documentclass{article}',
        '% macros.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
        '',
      ].join('\n'),
    },
    ['macros.tex'],
  ],
  [
    'falls back to single-document recovery for LaTeX content before the first percent header',
    [
      '\\section{Intro}',
      '% appendix.tex',
      'More text.',
      '% notes.tex',
      'Still the same fragment.',
    ],
    {
      'paper.tex': [
        '\\section{Intro}',
        '% appendix.tex',
        'More text.',
        '% notes.tex',
        'Still the same fragment.',
        '',
      ].join('\n'),
    },
    ['appendix.tex', 'notes.tex'],
  ],
  [
    'allows percent headers after documentclass-only blocks',
    [
      '% main.tex',
      '\\documentclass{article}',
      '% sections/intro.tex',
      '\\section{Intro}',
    ],
    {
      'main.tex': '\\documentclass{article}\n',
      'sections/intro.tex': '\\section{Intro}\n',
    },
  ],
  [
    'allows percent headers before later files with their own documentclass',
    [
      '% main.tex',
      '\\documentclass{article}',
      '% appendix.tex',
      '\\documentclass{article}',
      '\\begin{document}',
      'Appendix.',
      '\\end{document}',
    ],
    {
      'main.tex': '\\documentclass{article}\n',
      'appendix.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        'Appendix.',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ],
  [
    'ignores commented end-document lines when detecting percent headers',
    [
      '% main.tex',
      '\\documentclass{article}',
      '\\begin{document}',
      '% \\end{document}',
      '% notes.tex',
      'Still the main document.',
      '\\end{document}',
      '% appendix.tex',
      'Appendix text.',
    ],
    {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '% \\end{document}',
        '% notes.tex',
        'Still the main document.',
        '\\end{document}',
        '',
      ].join('\n'),
      'appendix.tex': 'Appendix text.\n',
    },
  ],
  [
    'removes prefaced markdown fence delimiters from percent output',
    [
      'Here are the files:',
      '```latex',
      '% main.tex',
      'Main text.',
      '```',
      'Done.',
    ],
    { 'main.tex': 'Main text.\n' },
  ],
  [
    'preserves prefaced fence state across empty repeated headers',
    [
      'Here are the files:',
      '```latex',
      '% main.tex',
      '% main.tex',
      'Main text.',
      '```',
    ],
    { 'main.tex': 'Main text.\n' },
  ],
  [
    'clears complete pre-header fences before the real percent output',
    [
      'Example:',
      '```tex',
      'not output',
      '```',
      'Actual files:',
      '```latex',
      '% main.tex',
      'Main text.',
      '```',
    ],
    { 'main.tex': 'Main text.\n' },
  ],
  [
    'keeps inner fence delimiters inside prefaced fenced percent output',
    [
      'Here are the files:',
      '```latex',
      '% main.tex',
      '\\documentclass{article}',
      '\\begin{document}',
      '\\begin{verbatim}',
      '```',
      '\\end{verbatim}',
      '\\end{document}',
      '```',
      'Done.',
    ],
    {
      'main.tex': [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\begin{verbatim}',
        '```',
        '\\end{verbatim}',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ],
  [
    'ignores prose after a fenced percent-header block until the next header',
    [
      '% main.tex',
      '```latex',
      'Main text.',
      '```',
      'Done.',
      '% appendix.tex',
      'Appendix text.',
    ],
    {
      'main.tex': 'Main text.\n',
      'appendix.tex': 'Appendix text.\n',
    },
  ],
  [
    'ignores scratchpad percent filename mentions during recovery',
    [
      '<scratchpad>',
      '% main.tex',
      'Draft routing notes.',
      '</scratchpad>',
      '% main.tex',
      'Actual output.',
    ],
    { 'main.tex': 'Actual output.\n' },
    ['main-2.tex'],
  ],
  [
    'makes duplicate percent filename headers unique before writing',
    ['% chunk.tex', 'First.', '% chunk.tex', 'Second.'],
    {
      'chunk.tex': 'First.\n',
      'chunk-2.tex': 'Second.\n',
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
    {
      'chunk.tex': 'First.\n',
      'chunk-2.tex': 'Explicit suffix.\n',
      'chunk-3.tex': 'Second duplicate.\n',
    },
  ],
  [
    'does not reserve empty percent filename header blocks',
    ['% chunk.tex', '% chunk.tex', 'Actual content.'],
    { 'chunk.tex': 'Actual content.\n' },
  ],
  [
    'deduplicates percent filename headers after safe-path normalization',
    [
      '% sections/main.tex',
      'Plain path.',
      '% sections/./main.tex',
      'Equivalent safe path.',
    ],
    {
      'sections/main.tex': 'Plain path.\n',
      'sections/main-2.tex': 'Equivalent safe path.\n',
    },
  ],
];

const LABELED_RECOVERY_CASES: readonly LabeledRecoveryCase[] = [
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
    // The % header stays (it is a valid LaTeX comment); the bare label is
    // not LaTeX and must not leak into the recovered document.
    'drops a bare label line inside a synthesized single-input document body',
    [
      '\\section{Intro}',
      'Text.',
      '% paper.tex',
      'More text.',
      'paper.tex:',
      'Final text.',
    ],
    ['paper.tex'],
    {
      'paper.tex':
        '\\section{Intro}\nText.\n% paper.tex\nMore text.\nFinal text.\n',
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
  [
    'ignores bare labels inside pre-output example fences',
    [
      'Here is the label format:',
      '```text',
      'main.tex:',
      'example body',
      '```',
      '',
      'main.tex:',
      '```latex',
      'Real output.',
      '```',
    ],
    ['main.tex'],
    { 'main.tex': 'Real output.\n' },
    ['main-2.tex'],
  ],
  [
    'does not strip unrelated example and output fences as one wrapper',
    [
      '```text',
      'main.tex:',
      'example body',
      '```',
      '',
      'main.tex:',
      '```latex',
      'Real output.',
      '```',
    ],
    ['main.tex'],
    { 'main.tex': 'Real output.\n' },
    ['main-2.tex'],
  ],
  [
    'preserves a shared outer fence across filename-label splits',
    [
      'Here are the files:',
      '```latex',
      'main.tex:',
      'Main body.',
      'appendix.tex:',
      'Appendix body.',
      '```',
    ],
    ['main.tex', 'appendix.tex'],
    {
      'main.tex': 'Main body.\n',
      'appendix.tex': 'Appendix body.\n',
    },
  ],
  [
    'recovers headers after an unclosed non-LaTeX example fence',
    [
      'Example:',
      '```text',
      'The response should then provide the real file.',
      'main.tex:',
      'Real body.',
    ],
    ['main.tex'],
    { 'main.tex': 'Real body.\n' },
  ],
  [
    'recovers real filename-labelled outputs inside a prefaced text fence',
    [
      'Here are the files:',
      '```text',
      'main.tex:',
      'Main body.',
      'appendix.tex:',
      'Appendix body.',
      '```',
    ],
    ['main.tex', 'appendix.tex'],
    {
      'main.tex': 'Main body.\n',
      'appendix.tex': 'Appendix body.\n',
    },
  ],
  [
    'recovers a single plain output inside a prefaced text fence',
    [
      'Here is the file:',
      '```text',
      'main.tex:',
      'A plain paragraph with no command-looking LaTeX.',
      '```',
    ],
    ['main.tex'],
    { 'main.tex': 'A plain paragraph with no command-looking LaTeX.\n' },
  ],
  [
    'keeps inner fence delimiters inside fenced LaTeX fragments',
    [
      'main.tex:',
      '```latex',
      '\\begin{verbatim}',
      '```',
      '\\end{verbatim}',
      'Tail.',
      '```',
    ],
    ['main.tex'],
    { 'main.tex': '\\begin{verbatim}\n```\n\\end{verbatim}\nTail.\n' },
  ],
  [
    'strips an outer documents envelope before filename-label recovery',
    ['<documents>', 'main.tex:', 'Recovered body.', '</documents>'],
    ['main.tex'],
    { 'main.tex': 'Recovered body.\n' },
  ],
  [
    'strips an outer documents envelope inside a markdown wrapper',
    [
      '```xml',
      '<documents>',
      'main.tex:',
      'Recovered body.',
      '</documents>',
      '```',
    ],
    ['main.tex'],
    { 'main.tex': 'Recovered body.\n' },
  ],
  [
    'drops a bare label that triggers single-input prefix synthesis',
    ['\\section{Intro}', 'Text.', 'paper.tex:', 'More text.'],
    ['paper.tex'],
    { 'paper.tex': '\\section{Intro}\nText.\nMore text.\n' },
  ],
  [
    // Unlike a % header, a bare label is never a LaTeX comment, so the
    // "maybe this is a preamble comment" lookahead must not swallow the
    // label separating a preamble-only file from the next document.
    'splits on a bare label even after preamble-only content',
    [
      'main.tex:',
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      'body.tex:',
      '\\begin{document}',
      'Hi.',
      '\\end{document}',
    ],
    ['main.tex', 'body.tex'],
    {
      'main.tex': '\\documentclass{article}\n\\usepackage{amsmath}\n',
      'body.tex': '\\begin{document}\nHi.\n\\end{document}\n',
    },
  ],
];

describe('XmlOutputManager', () => {
  beforeEach(async () => {
    formatterMocks.runLatexFormatter.mockReset();
    await installPlatform({
      files: { '/tmp/run/output.xml': '<documents />' },
      workspacePath: '/workspace',
    });
  });

  it('writes extracted full-document outputs with one final newline', async () => {
    const manager = createXmlManager();

    await manager.processMultipleLatexDocuments(
      [
        {
          name: 'paper.tex',
          content:
            '\n\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n\n',
        },
      ],
      createExternalLocation('/tmp/run/output.xml'),
      0,
    );

    await expectWritten(
      'paper.tex',
      '\\documentclass{article}\n\\begin{document}\nHi.\n\\end{document}\n',
    );
  });

  it('keeps legacy trailing end-document removal and adds one final newline', async () => {
    const manager = createXmlManager();

    await manager.processMultipleLatexDocuments(
      [
        {
          name: 'fragment.tex',
          content: '\nBody only.\n\\end{document}\n\n',
        },
      ],
      createExternalLocation('/tmp/run/output.xml'),
      0,
    );

    await expectWritten('fragment.tex', 'Body only.\n');
  });

  it('creates parent directories for extracted document names with subdirectories', async () => {
    const manager = createXmlManager();

    await manager.processMultipleLatexDocuments(
      [{ name: 'sections/main.tex', content: 'Nested section.\n' }],
      createExternalLocation('/tmp/run/output.xml'),
      0,
    );

    await expectWritten('sections/main.tex', 'Nested section.\n');
  });

  it.each(RECOVERY_CASES)('%s', async (_name, output, files, absent = []) => {
    await assertRecoveredDocuments(
      await writeAndSplitDocuments(output),
      files,
      absent,
    );
  });

  it('continues percent recovery for multi-input outputs after leading LaTeX content', async () => {
    const outputs = await writeAndSplitDocuments(
      ['\\section{Unroutable preface}', '% appendix.tex', 'Appendix.'],
      ['main.tex', 'appendix.tex'],
    );

    expectSources(outputs, ['appendix.tex']);
    await expectWritten('appendix.tex', 'Appendix.\n');
  });

  it('deduplicates percent filename headers after final output path mapping', async () => {
    const outputs = await writeAndSplitDocuments([
      '% output.tex',
      'Primary fallback.',
      '% output_extracted.tex',
      'Explicit extracted fallback.',
    ]);

    expectSources(outputs, ['output.tex', 'output_extracted-2.tex']);
    await expectWritten('output_extracted.tex', 'Primary fallback.\n');
    await expectWritten(
      'output_extracted-2.tex',
      'Explicit extracted fallback.\n',
    );
  });

  it('does not auto-format extracted workflow outputs', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      `<documents><document name="main.tex">
\\[
  f(x)=x^4-2x^2+1.
\\]
</document><document name="appendix.tex">
Appendix.
</document></documents>`,
    );
    const manager = createXmlManager();
    const state = createOutputState();
    const processor = new OutputFileProcessor(
      state,
      processorDeps({ logger: spiedTrace() }),
      manager,
    );

    await processor.processMultipleOutputs(
      createExternalLocation('/tmp/run/output.xml'),
      0,
    );

    const roundOutputs = state.rounds.get(0)?.outputs ?? [];
    expect(roundOutputs).toHaveLength(2);
    expect(formatterMocks.runLatexFormatter).not.toHaveBeenCalled();
    await expectWritten('main.tex', '\\[\n  f(x)=x^4-2x^2+1.\n\\]\n');
  });

  it.each(LABELED_RECOVERY_CASES)(
    '%s',
    async (_name, output, inputFiles, files, absent = []) => {
      await assertRecoveredDocuments(
        await writeAndSplitDocuments(output, [...inputFiles]),
        files,
        absent,
      );
    },
  );

  it.each([
    [
      'matches a bare label by basename when the model drops the directory prefix',
      ['Draft3.tex:', '```latex', 'Recovered by basename.', '```'],
      ['Draft/LeanMPSPaper/Draft3.tex'],
      ['Draft/LeanMPSPaper/Draft3.tex'],
    ],
    [
      'matches a bare label whose path uses Windows separators or a ./ prefix',
      [
        'Draft\\LeanMPSPaper\\Draft3.tex:',
        '```latex',
        'Body via backslashes.',
        '```',
        '',
        './Draft/LeanMPSPaper/endmatter.tex:',
        '```latex',
        'Body via dot-slash.',
        '```',
      ],
      ['Draft/LeanMPSPaper/Draft3.tex', 'Draft/LeanMPSPaper/endmatter.tex'],
      ['Draft/LeanMPSPaper/Draft3.tex', 'Draft/LeanMPSPaper/endmatter.tex'],
    ],
    [
      'matches bare labels with leading underscores and emphasis decoration',
      [
        '_macros.tex:',
        '```latex',
        'Macro definitions.',
        '```',
        '',
        '**_helpers.tex_**:',
        '```latex',
        'Helper macros.',
        '```',
      ],
      ['_macros.tex', '_helpers.tex'],
      ['_macros.tex', '_helpers.tex'],
    ],
  ] satisfies readonly (readonly [
    string,
    readonly string[],
    readonly string[],
    readonly string[],
  ])[])('%s', async (_name, output, inputFiles, expectedSources) => {
    const outputs = await writeAndSplitDocuments(output, [...inputFiles]);

    expectSources(outputs, expectedSources);
  });

  it('falls back to content-similarity matching for unlabeled fenced blocks against the original inputs', async () => {
    await AbsoluteFS.write(
      '/tmp/run/appendices.tex',
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture with a shared Lean repository.\n',
    );
    await AbsoluteFS.write(
      '/tmp/run/cost_section.tex',
      '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nPreliminary numbers from the local interactive logs.\n',
    );

    // Response order is deliberately swapped relative to inputFiles, and
    // neither fence carries any filename label, to prove the match is
    // driven by content rather than declaration or response order.
    const outputs = await writeAndSplitDocuments(
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
    await expectWritten(
      'appendices.tex',
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture with a persistent shared memory.\n',
    );
    await expectWritten(
      'cost_section.tex',
      '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nRevised numbers from the local interactive logs.\n',
    );
  });

  // Agents like ocr/paper2slide declare one defaultOutputFiles entry while
  // accepting several attached input files. runReflectionFlow.ts then builds
  // baseFiles from outputFiles, not inputFiles, so baseFiles[i] no longer
  // corresponds to inputFiles[i].
  const singleArtifactOptions: XmlManagerOptions = {
    outputFiles: ['ocr_result.tex'],
    baseFiles: ['ocr_result.tex'],
  };
  const singleArtifactInputs = ['page1.png', 'page2.png'];

  it.each([
    [
      // Content-similarity matching against inputFiles must not run in this
      // shape (it would label the block with an input media name); instead
      // the single-document recovery names the block after the sole
      // declared output.
      'recovers an unlabeled fence under the declared output name for single-artifact agents',
      ['```latex', 'Unlabeled recovered content.', '```'],
      singleArtifactInputs,
      'Unlabeled recovered content.\n',
    ],
    [
      // For single-artifact agents the inputs can be media files the
      // response mentions in prose; a `page1.png:` line must never become a
      // document named after the input. The fenced content is still
      // recovered, but under the sole declared output name.
      'ignores bare labels naming an input when the agent declares outputFiles',
      ['page1.png:', '```latex', 'Transcribed content.', '```'],
      singleArtifactInputs,
      'Transcribed content.\n',
    ],
    [
      'synthesizes an unlabeled prefix under the declared output name, not the input',
      ['\\section{Transcription}', 'Intro.', 'ocr_result.tex:', 'More.'],
      ['paper.tex'],
      '\\section{Transcription}\nIntro.\nMore.\n',
    ],
    [
      'recovers a bare label naming a declared output file',
      ['ocr_result.tex:', '```latex', 'Transcribed content.', '```'],
      singleArtifactInputs,
      'Transcribed content.\n',
    ],
  ] satisfies readonly (readonly [
    string,
    readonly string[],
    readonly string[],
    string,
  ])[])('%s', async (_name, output, inputFiles, expectedContent) => {
    const outputs = await writeAndSplitDocuments(
      output,
      [...inputFiles],
      singleArtifactOptions,
    );

    expectSources(outputs, ['ocr_result.tex']);
    await expectWritten('ocr_result.tex', expectedContent);
  });

  it.each([
    [
      'coalesces repeated labels for the sole declared output',
      [
        'ocr_result.tex:',
        '```latex',
        'Page one transcription.',
        '```',
        '',
        'ocr_result.tex:',
        '```latex',
        'Page two transcription.',
        '```',
      ],
    ],
    [
      'coalesces unlabeled chunks after a sole-output header chunk',
      [
        'ocr_result.tex:',
        '```latex',
        'Page one transcription.',
        '```',
        '',
        'page2.png:',
        '```latex',
        'Page two transcription.',
        '```',
      ],
    ],
    [
      'concatenates multiple unlabeled fences under the sole declared output',
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
    ],
  ] satisfies readonly (readonly [string, readonly string[]])[])(
    '%s',
    async (_name, output) => {
      const outputs = await writeAndSplitDocuments(
        output,
        singleArtifactInputs,
        singleArtifactOptions,
      );

      expectSources(outputs, ['ocr_result.tex']);
      await expectWritten(
        'ocr_result.tex',
        'Page one transcription.\n\nPage two transcription.\n',
      );
      await expectAbsent('ocr_result-2.tex');
    },
  );

  it('does not coalesce explanatory fences after a sole-output header chunk', async () => {
    const outputs = await writeAndSplitDocuments(
      [
        'ocr_result.tex:',
        '```latex',
        'Page one transcription.',
        '```',
        '',
        'Explanation:',
        '```latex',
        '\\LaTeX{} example, not output.',
        '```',
      ],
      singleArtifactInputs,
      singleArtifactOptions,
    );

    expectSources(outputs, ['ocr_result.tex']);
    await expectWritten('ocr_result.tex', 'Page one transcription.\n');
  });

  it('does not concatenate later explanatory fences for single-input edits', async () => {
    const outputs = await writeAndSplitDocuments(
      [
        '```latex',
        'Revised paper body.',
        '```',
        '',
        'Explanation:',
        '```latex',
        '\\LaTeX{} example, not output.',
        '```',
      ],
      ['paper.tex'],
    );

    expectSources(outputs, ['paper.tex']);
    await expectWritten('paper.tex', 'Revised paper body.\n');
  });

  it('ignores scratchpad fenced blocks when recovering a single-input edit', async () => {
    const outputs = await writeAndSplitDocuments(
      [
        '<scratchpad>',
        'Draft attempt before I settled on the real revision:',
        '```latex',
        '\\section{Scratch}',
        'Rejected draft.',
        '```',
        '</scratchpad>',
        '```latex',
        '\\section{Final}',
        'Accepted revision.',
        '```',
      ],
      ['paper.tex'],
    );

    expectSources(outputs, ['paper.tex']);
    await expectWritten('paper.tex', '\\section{Final}\nAccepted revision.\n');
  });

  it('leaves an unlabeled block unmatched when identical base files make the match ambiguous', async () => {
    const stub = '\\section{Stub}\nShared template content.\n';
    await AbsoluteFS.write('/tmp/run/a.tex', stub);
    await AbsoluteFS.write('/tmp/run/b.tex', stub);

    const outputs = await writeAndSplitDocuments(
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
  });

  it('routes the revision, not the echoed original, when the model quotes both', async () => {
    await AbsoluteFS.write(
      '/tmp/run/cost.tex',
      '\\section{Computational cost}\nPreliminary numbers from the local interactive logs.\n',
    );
    await AbsoluteFS.write(
      '/tmp/run/arch.tex',
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture.\n',
    );

    const outputs = await writeAndSplitDocuments(
      [
        'The original cost section for reference:',
        '```latex',
        '\\section{Computational cost}',
        'Preliminary numbers from the local interactive logs.',
        '```',
        '',
        'And my revision:',
        '```latex',
        '\\section{Computational cost}',
        'Final numbers from the local interactive logs.',
        '```',
        '',
        '```latex',
        '\\appendix',
        '\\section{Agent architecture}',
        'The formalization system uses a revised multi-agent architecture.',
        '```',
      ],
      ['cost.tex', 'arch.tex'],
      { baseFiles: ['cost.tex', 'arch.tex'] },
    );

    expect(outputs.map((output) => output.source).sort()).toEqual([
      'arch.tex',
      'cost.tex',
    ]);
    await expectWritten(
      'cost.tex',
      '\\section{Computational cost}\nFinal numbers from the local interactive logs.\n',
    );
  });

  it('matches later-round unlabeled fences against the previous round outputs', async () => {
    // Round-0 originals are placeholders that no longer resemble the content
    // being revised; only the previous round's outputs do. The similarity
    // fallback must compare against those, or every later-round recovery
    // would score below the threshold and drop the round.
    await AbsoluteFS.ensureDir('/tmp/run/r0');
    await AbsoluteFS.ensureDir('/tmp/run/r1');
    await AbsoluteFS.write('/tmp/run/appendices.tex', 'placeholder A');
    await AbsoluteFS.write('/tmp/run/cost_section.tex', 'placeholder B');
    await AbsoluteFS.write(
      '/tmp/run/r0/appendices.tex',
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture with shared memory.\n',
    );
    await AbsoluteFS.write(
      '/tmp/run/r0/cost_section.tex',
      '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nPreliminary numbers from the interactive logs.\n',
    );
    await AbsoluteFS.write(
      '/tmp/run/r1/output.xml',
      [
        '```latex',
        '% !TEX root = Draft3SM.tex',
        '\\section{Computational cost}',
        'Final numbers from the interactive logs.',
        '```',
        '',
        '```latex',
        '\\appendix',
        '\\section{Agent architecture}',
        'The formalization system uses a revised multi-agent architecture with shared memory.',
        '```',
      ].join('\n'),
    );

    const manager = createXmlManager(['appendices.tex', 'cost_section.tex']);
    const state = createOutputState();
    ensureRoundData(state, 0).outputs = [
      {
        source: 'appendices.tex',
        round: 0,
        location: createExternalLocation('/tmp/run/r0/appendices.tex'),
        lineage: null,
        diff: null,
      },
      {
        source: 'cost_section.tex',
        round: 0,
        location: createExternalLocation('/tmp/run/r0/cost_section.tex'),
        lineage: null,
        diff: null,
      },
    ];
    const processor = new OutputFileProcessor(
      state,
      processorDeps({
        logger: spiedTrace(),
        baseFiles: [
          createExternalLocation('/tmp/run/appendices.tex'),
          createExternalLocation('/tmp/run/cost_section.tex'),
        ],
      }),
      manager,
    );

    await processor.processMultipleOutputs(
      createExternalLocation('/tmp/run/r1/output.xml'),
      1,
    );

    const roundOutputs = state.rounds.get(1)?.outputs ?? [];

    expect(roundOutputs.map((output) => output.source).sort()).toEqual([
      'appendices.tex',
      'cost_section.tex',
    ]);
    await expectWritten(
      'r1/cost_section.tex',
      '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nFinal numbers from the interactive logs.\n',
    );
  });

  it('reports input files left unmatched by content-similarity recovery', async () => {
    const logger = spiedTrace();
    await AbsoluteFS.write(
      '/tmp/run/cost.tex',
      '\\section{Computational cost}\nPreliminary numbers from the local interactive logs.\n',
    );
    await AbsoluteFS.write(
      '/tmp/run/arch.tex',
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture.\n',
    );

    const outputs = await writeAndSplitDocuments(
      [
        '```latex',
        '\\section{Computational cost}',
        'Final numbers from the local interactive logs.',
        '```',
      ],
      ['cost.tex', 'arch.tex'],
      { logger, baseFiles: ['cost.tex', 'arch.tex'] },
    );

    expectSources(outputs, ['cost.tex']);
    expect(logger.domain).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'missingOutputs',
        data: expect.objectContaining({ missing: ['arch.tex'] }),
      }),
    );
  });

  it('reports expected files left unmatched by filename-header recovery', async () => {
    const logger = spiedTrace();
    const outputs = await writeAndSplitDocuments(
      [
        'main.tex:',
        '```latex',
        'Main body.',
        '```',
        '',
        '```latex',
        'Appendix body with no label.',
        '```',
      ],
      ['main.tex', 'appendix.tex'],
      { logger },
    );

    expectSources(outputs, ['main.tex']);
    expect(logger.domain).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'missingOutputs',
        data: expect.objectContaining({ missing: ['appendix.tex'] }),
      }),
    );
  });

  it('logs discarded unclosed latex fences during similarity recovery', async () => {
    const logger = spiedTrace();
    await AbsoluteFS.write('/tmp/run/a.tex', 'Original A.');
    await AbsoluteFS.write('/tmp/run/b.tex', 'Original B.');

    const outputs = await writeAndSplitDocuments(
      ['```latex', 'Unclosed revised content.'],
      ['a.tex', 'b.tex'],
      { logger, baseFiles: ['a.tex', 'b.tex'] },
    );

    expect(outputs).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Dropped unclosed LaTeX fence'),
      expect.anything(),
    );
  });
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

  it('keeps an exact unchanged output over a weak stray snippet', () => {
    const original =
      'line one shared\nline two original content here\nline three original content here';
    const snippet =
      'line one shared\nwholly different discussion\nabout unrelated things';

    const assigned = assignByContentSimilarity(
      [original, snippet],
      [{ name: 'f.tex', content: `${original}\n` }],
    );

    // The snippet is too weak to be a credible revision, so it must not
    // displace the exact copy (a legitimately unchanged output) from its file.
    expect(assigned[0]?.name).toBe('f.tex');
    expect(assigned[1]).toBeNull();
  });

  it('can assign a candidate after another block resolves its initial tie', () => {
    const assigned = assignByContentSimilarity(
      ['common common common', 'AAA weak'],
      [
        { name: 'a.tex', content: 'AAA common common common' },
        { name: 'b.tex', content: 'BBB common common common' },
      ],
    );

    expect(assigned.filter(Boolean)).toHaveLength(2);
    expect(assigned[0]?.name).toBe('b.tex');
    expect(assigned[1]?.name).toBe('a.tex');
  });

  it('does not route a repeated block to a weaker secondary file', () => {
    const main =
      '\\documentclass{article}\n\\begin{document}\nMain result.\n\\end{document}';
    const mainRevision =
      '\\documentclass{article}\n\\begin{document}\nRevised main result.\n\\end{document}';
    const appendix =
      '\\documentclass{article}\n\\begin{document}\nAppendix result.\n\\end{document}';

    const assigned = assignByContentSimilarity(
      [mainRevision, mainRevision],
      [
        { name: 'main.tex', content: main },
        { name: 'appendix.tex', content: appendix },
      ],
    );

    expect(assigned[0]?.name).toBe('main.tex');
    expect(assigned[1]).toBeNull();
  });

  it('keeps one exact copy when unchanged output is repeated', () => {
    const original =
      '\\documentclass{article}\n\\begin{document}\nUnchanged.\n\\end{document}';

    const assigned = assignByContentSimilarity(
      [original, original],
      [{ name: 'main.tex', content: original }],
    );

    expect(assigned.filter(Boolean)).toHaveLength(1);
    expect(assigned[0]?.name).toBe('main.tex');
    expect(assigned[1]).toBeNull();
  });
});
