import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { OutputFileProcessor } from '@agent/output/OutputFileProcessor';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { OutputFileInfo, RoundOutput } from '@shared/schemas';
import {
  AbsoluteFS,
  TaskRunFileService,
  createExternalLocation,
} from '@utils/files';

const formatterMocks = vi.hoisted(() => ({
  runLatexFormatter: vi.fn(),
}));

vi.mock('@latex/texFormatter', () => ({
  runLatexFormatter: formatterMocks.runLatexFormatter,
}));

async function initFakePlatform(files: Record<string, string> = {}) {
  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform({ files, workspacePath: '/workspace' }));
}

function createXmlManager(
  documentTag = 'document',
  inputFiles: string[] = ['paper.tex'],
): XmlOutputManager {
  return new XmlOutputManager(
    {
      agentCategory: AgentCategory.Workflow,
      documentTag,
      endTag: '</documents>',
      temperature: 0,
      requiredFiles: {},
      requiredFilesInternal: {},
      defaultOutputFiles: [],
      filePatternsContain: [],
      tools: [],
      isRewrite: true,
      rounds: 1,
      prefills: [],
    },
    {
      inputFiles,
    } as AgentConfig,
    { debug: vi.fn(), info: vi.fn() } as unknown as AgentTrace,
    new TaskRunFileService(),
  );
}

function splitDocuments(
  manager: XmlOutputManager,
): ReturnType<XmlOutputManager['splitScratchpadMultipleOutputXml']> {
  return manager.splitScratchpadMultipleOutputXml(
    createExternalLocation('/tmp/run/output.xml'),
    'documents',
    0,
  );
}

describe('XmlOutputManager', () => {
  beforeEach(async () => {
    formatterMocks.runLatexFormatter.mockReset();
    await initFakePlatform({ '/tmp/run/output.xml': '<documents />' });
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

    await expect(AbsoluteFS.read('/tmp/run/paper.tex')).resolves.toBe(
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

    await expect(AbsoluteFS.read('/tmp/run/fragment.tex')).resolves.toBe(
      'Body only.\n',
    );
  });

  it('creates parent directories for extracted document names with subdirectories', async () => {
    const manager = createXmlManager();

    await manager.processMultipleLatexDocuments(
      [{ name: 'sections/main.tex', content: 'Nested section.\n' }],
      createExternalLocation('/tmp/run/output.xml'),
      0,
    );

    await expect(AbsoluteFS.read('/tmp/run/sections/main.tex')).resolves.toBe(
      'Nested section.\n',
    );
  });

  it('recovers documents from percent filename headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        'Here is the output:',
        '% main.tex',
        '\\section{Recovered}',
        '% sections/appendix.tex',
        'Appendix text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'sections/appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      '\\section{Recovered}\n',
    );
    await expect(
      AbsoluteFS.read('/tmp/run/sections/appendix.tex'),
    ).resolves.toBe('Appendix text.\n');
  });

  it('removes surrounding markdown fences from percent filename output', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '```latex',
        '% main.tex',
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
        '```',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
  });

  it('removes compact markdown fence info strings after percent headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '```latex',
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
        '```',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
  });

  it('removes spaced markdown fence info strings after percent headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '``` latex',
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
        '```',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
  });

  it('preserves fence-looking lines inside percent-header content', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '\\documentclass{article}',
        '\\begin{document}',
        '\\begin{verbatim}',
        '```',
        '\\end{verbatim}',
        '\\end{document}',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\begin{verbatim}',
        '```',
        '\\end{verbatim}',
        '\\end{document}',
        '',
      ].join('\n'),
    );
  });

  it('prefers named document fallback over percent filename comments', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '<document name="main.tex">',
        'Main body.',
        '% notes.tex',
        'Still main body.',
        '</document>',
        '<document name="appendix.tex">',
        'Appendix body.',
        '</document>',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      'Main body.\n% notes.tex\nStill main body.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix body.\n',
    );
    await expect(AbsoluteFS.exists('/tmp/run/notes.tex')).resolves.toBe(false);
  });

  it('prefers percent filename headers over single-document input recovery', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% declared.tex',
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['declared.tex']);
    await expect(AbsoluteFS.read('/tmp/run/declared.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Recovered.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await expect(AbsoluteFS.exists('/tmp/run/paper.tex')).resolves.toBe(false);
  });

  it('recovers dot-prefixed relative percent filename headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% ./main.tex',
        'Main text.',
        '% ./sections/appendix.tex',
        'Appendix text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'sections/appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      'Main text.\n',
    );
    await expect(
      AbsoluteFS.read('/tmp/run/sections/appendix.tex'),
    ).resolves.toBe('Appendix text.\n');
  });

  it('recovers hyphenated percent filename headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main-file.tex',
        'Main text.',
        '% sections/part-1.tex',
        'Part text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main-file.tex',
      'sections/part-1.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main-file.tex')).resolves.toBe(
      'Main text.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/sections/part-1.tex')).resolves.toBe(
      'Part text.\n',
    );
  });

  it('recovers underscore-prefixed percent filename headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% _macros.tex',
        '\\newcommand{\\R}{\\mathbb{R}}',
        '% _generated/main.tex',
        'Generated text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      '_macros.tex',
      '_generated/main.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/_macros.tex')).resolves.toBe(
      '\\newcommand{\\R}{\\mathbb{R}}\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/_generated/main.tex')).resolves.toBe(
      'Generated text.\n',
    );
  });

  it('recovers backslash-separated percent filename headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['% sections\\intro.tex', 'Intro text.'].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'sections/intro.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/sections/intro.tex')).resolves.toBe(
      'Intro text.\n',
    );
  });

  it('keeps percent filename comments inside a LaTeX document body', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '\\documentclass{article}',
        '\\begin{document}',
        '% notes.tex',
        'Still the main document.',
        '\\end{document}',
        '% appendix.tex',
        'Appendix text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '% notes.tex',
        'Still the main document.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix text.\n',
    );
  });

  it('keeps percent filename comments in a LaTeX document preamble', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '\\documentclass{article}',
        '% macros.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
        '% appendix.tex',
        'Appendix text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '% macros.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix text.\n',
    );
  });

  it('keeps multiple percent filename comments in a LaTeX document preamble', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '% macros.tex',
        '% notation.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix text.\n',
    );
  });

  it('does not treat pre-header LaTeX preamble comments as percent outputs', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '\\documentclass{article}',
        '% macros.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['paper.tex']);
    await expect(AbsoluteFS.read('/tmp/run/paper.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '% macros.tex',
        '\\begin{document}',
        'Body.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await expect(AbsoluteFS.exists('/tmp/run/macros.tex')).resolves.toBe(false);
  });

  it('falls back to single-document recovery for LaTeX content before the first percent header', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '\\section{Intro}',
        '% appendix.tex',
        'More text.',
        '% notes.tex',
        'Still the same fragment.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['paper.tex']);
    await expect(AbsoluteFS.read('/tmp/run/paper.tex')).resolves.toBe(
      [
        '\\section{Intro}',
        '% appendix.tex',
        'More text.',
        '% notes.tex',
        'Still the same fragment.',
        '',
      ].join('\n'),
    );
    await expect(AbsoluteFS.exists('/tmp/run/appendix.tex')).resolves.toBe(
      false,
    );
    await expect(AbsoluteFS.exists('/tmp/run/notes.tex')).resolves.toBe(false);
  });

  it('continues percent recovery for multi-input outputs after leading LaTeX content', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['\\section{Unroutable preface}', '% appendix.tex', 'Appendix.'].join(
        '\n',
      ),
    );
    const manager = createXmlManager('documents', ['main.tex', 'appendix.tex']);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['appendix.tex']);
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix.\n',
    );
  });

  it('allows percent headers after documentclass-only blocks', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '\\documentclass{article}',
        '% sections/intro.tex',
        '\\section{Intro}',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'sections/intro.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      '\\documentclass{article}\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/sections/intro.tex')).resolves.toBe(
      '\\section{Intro}\n',
    );
  });

  it('allows percent headers before later files with their own documentclass', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '\\documentclass{article}',
        '% appendix.tex',
        '\\documentclass{article}',
        '\\begin{document}',
        'Appendix.',
        '\\end{document}',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      '\\documentclass{article}\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Appendix.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
  });

  it('ignores commented end-document lines when detecting percent headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '% \\end{document}',
        '% notes.tex',
        'Still the main document.',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix text.\n',
    );
  });

  it('removes prefaced markdown fence delimiters from percent output', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        'Here are the files:',
        '```latex',
        '% main.tex',
        'Main text.',
        '```',
        'Done.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      'Main text.\n',
    );
  });

  it('preserves prefaced fence state across empty repeated headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        'Here are the files:',
        '```latex',
        '% main.tex',
        '% main.tex',
        'Main text.',
        '```',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      'Main text.\n',
    );
  });

  it('clears complete pre-header fences before the real percent output', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      'Main text.\n',
    );
  });

  it('keeps inner fence delimiters inside prefaced fenced percent output', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\begin{verbatim}',
        '```',
        '\\end{verbatim}',
        '\\end{document}',
        '',
      ].join('\n'),
    );
  });

  it('ignores prose after a fenced percent-header block until the next header', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% main.tex',
        '```latex',
        'Main text.',
        '```',
        'Done.',
        '% appendix.tex',
        'Appendix text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      'Main text.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix text.\n',
    );
  });

  it('ignores scratchpad percent filename mentions during recovery', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '<scratchpad>',
        '% main.tex',
        'Draft routing notes.',
        '</scratchpad>',
        '% main.tex',
        'Actual output.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['main.tex']);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      'Actual output.\n',
    );
    await expect(AbsoluteFS.exists('/tmp/run/main-2.tex')).resolves.toBe(false);
  });

  it('makes duplicate percent filename headers unique before writing', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['% chunk.tex', 'First.', '% chunk.tex', 'Second.'].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'chunk.tex',
      'chunk-2.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/chunk.tex')).resolves.toBe(
      'First.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/chunk-2.tex')).resolves.toBe(
      'Second.\n',
    );
  });

  it('avoids percent filename suffix collisions with explicit headers', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% chunk.tex',
        'First.',
        '% chunk-2.tex',
        'Explicit suffix.',
        '% chunk.tex',
        'Second duplicate.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'chunk.tex',
      'chunk-2.tex',
      'chunk-3.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/chunk.tex')).resolves.toBe(
      'First.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/chunk-2.tex')).resolves.toBe(
      'Explicit suffix.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/chunk-3.tex')).resolves.toBe(
      'Second duplicate.\n',
    );
  });

  it('does not reserve empty percent filename header blocks', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['% chunk.tex', '% chunk.tex', 'Actual content.'].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['chunk.tex']);
    await expect(AbsoluteFS.read('/tmp/run/chunk.tex')).resolves.toBe(
      'Actual content.\n',
    );
  });

  it('deduplicates percent filename headers after safe-path normalization', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% sections/main.tex',
        'Plain path.',
        '% sections/./main.tex',
        'Equivalent safe path.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'sections/main.tex',
      'sections/main-2.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/sections/main.tex')).resolves.toBe(
      'Plain path.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/sections/main-2.tex')).resolves.toBe(
      'Equivalent safe path.\n',
    );
  });

  it('deduplicates percent filename headers after final output path mapping', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '% output.tex',
        'Primary fallback.',
        '% output_extracted.tex',
        'Explicit extracted fallback.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'output.tex',
      'output_extracted-2.tex',
    ]);
    await expect(
      AbsoluteFS.read('/tmp/run/output_extracted.tex'),
    ).resolves.toBe('Primary fallback.\n');
    await expect(
      AbsoluteFS.read('/tmp/run/output_extracted-2.tex'),
    ).resolves.toBe('Explicit extracted fallback.\n');
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
    const manager = createXmlManager('documents');
    let roundOutputs: OutputFileInfo[] = [];
    const roundData: RoundOutput = {
      round: 0,
      rawOutput: null,
      outputs: [],
      compileFailures: [],
      xmlSummary: {
        tagContents: {},
        documents: [],
        singleOutputFile: null,
        sourceLocation: null,
      },
    };
    const processor = new OutputFileProcessor({
      agentSetting: {
        agentCategory: AgentCategory.Workflow,
        documentTag: 'documents',
        endTag: '</documents>',
        temperature: 0,
        requiredFiles: {},
        requiredFilesInternal: {},
        defaultOutputFiles: [],
        filePatternsContain: [],
        tools: [],
        isRewrite: true,
        rounds: 1,
        prefills: [],
      },
      baseFiles: [],
      streamId: 'stream',
      runtimeHost: { emit: vi.fn() } as unknown as AgentRuntimeHost,
      logger: { debug: vi.fn() } as unknown as AgentTrace,
      xmlManager: manager,
      setRoundOutputs: (_round, outputs) => {
        roundOutputs = outputs;
      },
      ensureRoundData: () => roundData,
    });

    await processor.processMultipleOutputs(
      createExternalLocation('/tmp/run/output.xml'),
      0,
      createExternalLocation('/tmp/run/output.xml'),
    );

    expect(roundOutputs).toHaveLength(2);
    expect(formatterMocks.runLatexFormatter).not.toHaveBeenCalled();
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      '\\[\n  f(x)=x^4-2x^2+1.\n\\]\n',
    );
  });

  it('recovers documents from bare filename labels with no % prefix', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
      ].join('\n'),
    );
    const manager = createXmlManager('documents', [
      'Draft/LeanMPSPaper/Draft3.tex',
      'Draft/LeanMPSPaper/endmatter.tex',
    ]);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'Draft/LeanMPSPaper/Draft3.tex',
      'Draft/LeanMPSPaper/endmatter.tex',
    ]);
    await expect(
      AbsoluteFS.read('/tmp/run/Draft/LeanMPSPaper/Draft3.tex'),
    ).resolves.toBe(
      '\\documentclass{article}\n\\begin{document}\nBody one.\n\\end{document}\n',
    );
    await expect(
      AbsoluteFS.read('/tmp/run/Draft/LeanMPSPaper/endmatter.tex'),
    ).resolves.toBe('End matter body.\n');
  });

  it('matches a bare label by basename when the model drops the directory prefix', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['Draft3.tex:', '```latex', 'Recovered by basename.', '```'].join('\n'),
    );
    const manager = createXmlManager('documents', [
      'Draft/LeanMPSPaper/Draft3.tex',
    ]);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'Draft/LeanMPSPaper/Draft3.tex',
    ]);
  });

  it('falls back to content-similarity matching for unlabeled fenced blocks against the original inputs', async () => {
    const appendicesOriginal =
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture with a shared Lean repository.\n';
    const costSectionOriginal =
      '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nPreliminary numbers from the local interactive logs.\n';

    await AbsoluteFS.write('/tmp/run/appendices.tex', appendicesOriginal);
    await AbsoluteFS.write('/tmp/run/cost_section.tex', costSectionOriginal);

    // Response order is deliberately swapped relative to inputFiles, and
    // neither fence carries any filename label, to prove the match is
    // driven by content rather than declaration or response order.
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
      ].join('\n'),
    );

    const manager = createXmlManager('documents', [
      'appendices.tex',
      'cost_section.tex',
    ]);

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
      'scratchpad',
      [
        createExternalLocation('/tmp/run/appendices.tex'),
        createExternalLocation('/tmp/run/cost_section.tex'),
      ],
    );

    expect(outputs.map((output) => output.source).sort()).toEqual([
      'appendices.tex',
      'cost_section.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/appendices.tex')).resolves.toBe(
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture with a persistent shared memory.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/cost_section.tex')).resolves.toBe(
      '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nRevised numbers from the local interactive logs.\n',
    );
  });
});
