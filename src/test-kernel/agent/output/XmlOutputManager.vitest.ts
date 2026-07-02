import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { assignByContentSimilarity } from '@agent/output/extraction/contentSimilarity';
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
      outputFiles: [],
    } as unknown as AgentConfig,
    {
      debug: vi.fn(),
      info: vi.fn(),
      domain: vi.fn(),
    } as unknown as AgentTrace,
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

  it('matches a bare label whose path uses Windows separators or a ./ prefix', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
  });

  it('drops a bare label line inside a synthesized single-input document body', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '\\section{Intro}',
        'Text.',
        '% paper.tex',
        'More text.',
        'paper.tex:',
        'Final text.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents', ['paper.tex']);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['paper.tex']);
    // The % header stays (it is a valid LaTeX comment); the bare label is
    // not LaTeX and must not leak into the recovered document.
    await expect(AbsoluteFS.read('/tmp/run/paper.tex')).resolves.toBe(
      '\\section{Intro}\nText.\n% paper.tex\nMore text.\nFinal text.\n',
    );
  });

  it('matches bare labels with leading underscores and emphasis decoration', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '_macros.tex:',
        '```latex',
        'Macro definitions.',
        '```',
        '',
        '**_helpers.tex**:',
        '```latex',
        'Helper macros.',
        '```',
      ].join('\n'),
    );
    const manager = createXmlManager('documents', [
      '_macros.tex',
      '_helpers.tex',
    ]);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      '_macros.tex',
      '_helpers.tex',
    ]);
  });

  it('keeps a bare label inside a verbatim block instead of splitting the fragment', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        'main.tex:',
        '\\section{Listing}',
        '\\begin{verbatim}',
        'appendix.tex:',
        '\\end{verbatim}',
        'Tail.',
        'appendix.tex:',
        'Appendix content.',
      ].join('\n'),
    );
    const manager = createXmlManager('documents', ['main.tex', 'appendix.tex']);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'appendix.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      '\\section{Listing}\n\\begin{verbatim}\nappendix.tex:\n\\end{verbatim}\nTail.\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/appendix.tex')).resolves.toBe(
      'Appendix content.\n',
    );
  });

  it('drops a bare label that triggers single-input prefix synthesis', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['\\section{Intro}', 'Text.', 'paper.tex:', 'More text.'].join('\n'),
    );
    const manager = createXmlManager('documents', ['paper.tex']);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual(['paper.tex']);
    await expect(AbsoluteFS.read('/tmp/run/paper.tex')).resolves.toBe(
      '\\section{Intro}\nText.\nMore text.\n',
    );
  });

  it('splits on a bare label even after preamble-only content', async () => {
    // Unlike a % header, a bare label is never a LaTeX comment, so the
    // "maybe this is a preamble comment" lookahead must not swallow the
    // label separating a preamble-only file from the next document.
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        'main.tex:',
        '\\documentclass{article}',
        '\\usepackage{amsmath}',
        'body.tex:',
        '\\begin{document}',
        'Hi.',
        '\\end{document}',
      ].join('\n'),
    );
    const manager = createXmlManager('documents', ['main.tex', 'body.tex']);

    const outputs = await splitDocuments(manager);

    expect(outputs.map((output) => output.source)).toEqual([
      'main.tex',
      'body.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/main.tex')).resolves.toBe(
      '\\documentclass{article}\n\\usepackage{amsmath}\n',
    );
    await expect(AbsoluteFS.read('/tmp/run/body.tex')).resolves.toBe(
      '\\begin{document}\nHi.\n\\end{document}\n',
    );
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

  // Agents like ocr/paper2slide declare one defaultOutputFiles entry while
  // accepting several attached input files. runReflectionFlow.ts then builds
  // baseFiles from outputFiles, not inputFiles, so baseFiles[i] no longer
  // corresponds to inputFiles[i].
  function createSingleArtifactManager(
    inputFiles: string[] = ['page1.png', 'page2.png'],
  ): XmlOutputManager {
    return new XmlOutputManager(
      {
        agentCategory: AgentCategory.Workflow,
        documentTag: 'documents',
        endTag: '</documents>',
        temperature: 0,
        requiredFiles: {},
        requiredFilesInternal: {},
        defaultOutputFiles: ['ocr_result.tex'],
        filePatternsContain: [],
        tools: [],
        isRewrite: true,
        rounds: 1,
        prefills: [],
      },
      {
        inputFiles,
        outputFiles: ['ocr_result.tex'],
      } as unknown as AgentConfig,
      {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        domain: vi.fn(),
      } as unknown as AgentTrace,
      new TaskRunFileService(),
    );
  }

  it('recovers an unlabeled fence under the declared output name for single-artifact agents', async () => {
    // Content-similarity matching against inputFiles must not run in this
    // shape (it would label the block with an input media name); instead the
    // single-document recovery names the block after the sole declared
    // output.
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['```latex', 'Unlabeled recovered content.', '```'].join('\n'),
    );

    const outputs =
      await createSingleArtifactManager().splitScratchpadMultipleOutputXml(
        createExternalLocation('/tmp/run/output.xml'),
        'documents',
        0,
        'scratchpad',
        [createExternalLocation('/tmp/run/ocr_result.tex')],
      );

    expect(outputs.map((output) => output.source)).toEqual(['ocr_result.tex']);
    await expect(AbsoluteFS.read('/tmp/run/ocr_result.tex')).resolves.toBe(
      'Unlabeled recovered content.\n',
    );
  });

  it('ignores bare labels naming an input when the agent declares outputFiles', async () => {
    // For single-artifact agents the inputs can be media files the response
    // mentions in prose; a `page1.png:` line must never become a document
    // named after the input. The fenced content is still recovered, but
    // under the sole declared output name.
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['page1.png:', '```latex', 'Transcribed content.', '```'].join('\n'),
    );

    const outputs =
      await createSingleArtifactManager().splitScratchpadMultipleOutputXml(
        createExternalLocation('/tmp/run/output.xml'),
        'documents',
        0,
        'scratchpad',
        [createExternalLocation('/tmp/run/ocr_result.tex')],
      );

    expect(outputs.map((output) => output.source)).toEqual(['ocr_result.tex']);
    await expect(AbsoluteFS.read('/tmp/run/ocr_result.tex')).resolves.toBe(
      'Transcribed content.\n',
    );
  });

  it('synthesizes an unlabeled prefix under the declared output name, not the input', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['\\section{Transcription}', 'Intro.', 'ocr_result.tex:', 'More.'].join(
        '\n',
      ),
    );

    const outputs = await createSingleArtifactManager([
      'paper.tex',
    ]).splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
      'scratchpad',
      [createExternalLocation('/tmp/run/ocr_result.tex')],
    );

    expect(outputs.map((output) => output.source)).toEqual(['ocr_result.tex']);
    await expect(AbsoluteFS.read('/tmp/run/ocr_result.tex')).resolves.toBe(
      '\\section{Transcription}\nIntro.\nMore.\n',
    );
  });

  it('recovers a bare label naming a declared output file', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['ocr_result.tex:', '```latex', 'Transcribed content.', '```'].join('\n'),
    );

    const outputs =
      await createSingleArtifactManager().splitScratchpadMultipleOutputXml(
        createExternalLocation('/tmp/run/output.xml'),
        'documents',
        0,
        'scratchpad',
        [createExternalLocation('/tmp/run/ocr_result.tex')],
      );

    expect(outputs.map((output) => output.source)).toEqual(['ocr_result.tex']);
    await expect(AbsoluteFS.read('/tmp/run/ocr_result.tex')).resolves.toBe(
      'Transcribed content.\n',
    );
  });

  it('leaves an unlabeled block unmatched when identical base files make the match ambiguous', async () => {
    const stub = '\\section{Stub}\nShared template content.\n';
    await AbsoluteFS.write('/tmp/run/a.tex', stub);
    await AbsoluteFS.write('/tmp/run/b.tex', stub);
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '```latex',
        '\\section{Stub}',
        'Shared template content, revised.',
        '```',
      ].join('\n'),
    );
    const manager = createXmlManager('documents', ['a.tex', 'b.tex']);

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
      'scratchpad',
      [
        createExternalLocation('/tmp/run/a.tex'),
        createExternalLocation('/tmp/run/b.tex'),
      ],
    );

    // Both base files score identically, so there is no evidence which one
    // the block revises — refusing to guess beats corrupting one of them.
    expect(outputs).toEqual([]);
  });

  it('routes the revision, not the echoed original, when the model quotes both', async () => {
    const costOriginal =
      '\\section{Computational cost}\nPreliminary numbers from the local interactive logs.\n';
    const archOriginal =
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture.\n';
    await AbsoluteFS.write('/tmp/run/cost.tex', costOriginal);
    await AbsoluteFS.write('/tmp/run/arch.tex', archOriginal);
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
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
      ].join('\n'),
    );
    const manager = createXmlManager('documents', ['cost.tex', 'arch.tex']);

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
      'scratchpad',
      [
        createExternalLocation('/tmp/run/cost.tex'),
        createExternalLocation('/tmp/run/arch.tex'),
      ],
    );

    expect(outputs.map((output) => output.source).sort()).toEqual([
      'arch.tex',
      'cost.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/cost.tex')).resolves.toBe(
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

    const manager = createXmlManager('documents', [
      'appendices.tex',
      'cost_section.tex',
    ]);
    const roundDataByRound = new Map<number, RoundOutput>();
    const ensureRound = (round: number): RoundOutput => {
      const existing = roundDataByRound.get(round);
      if (existing) return existing;
      const data: RoundOutput = {
        round,
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
      roundDataByRound.set(round, data);
      return data;
    };
    ensureRound(0).outputs = [
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
    let roundOutputs: OutputFileInfo[] = [];
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
        rounds: 2,
        prefills: [],
      },
      baseFiles: [
        createExternalLocation('/tmp/run/appendices.tex'),
        createExternalLocation('/tmp/run/cost_section.tex'),
      ],
      streamId: 'stream',
      runtimeHost: { emit: vi.fn() } as unknown as AgentRuntimeHost,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        domain: vi.fn(),
      } as unknown as AgentTrace,
      xmlManager: manager,
      setRoundOutputs: (_round, outputs) => {
        roundOutputs = outputs;
      },
      ensureRoundData: ensureRound,
    });

    await processor.processMultipleOutputs(
      createExternalLocation('/tmp/run/r1/output.xml'),
      1,
      createExternalLocation('/tmp/run/r1/output.xml'),
    );

    expect(roundOutputs.map((output) => output.source).sort()).toEqual([
      'appendices.tex',
      'cost_section.tex',
    ]);
    await expect(AbsoluteFS.read('/tmp/run/r1/cost_section.tex')).resolves.toBe(
      '% !TEX root = Draft3SM.tex\n\\section{Computational cost}\nFinal numbers from the interactive logs.\n',
    );
  });

  it('reports input files left unmatched by content-similarity recovery', async () => {
    const costOriginal =
      '\\section{Computational cost}\nPreliminary numbers from the local interactive logs.\n';
    const archOriginal =
      '\\appendix\n\\section{Agent architecture}\nThe formalization system uses a multi-agent architecture.\n';
    await AbsoluteFS.write('/tmp/run/cost.tex', costOriginal);
    await AbsoluteFS.write('/tmp/run/arch.tex', archOriginal);
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      [
        '```latex',
        '\\section{Computational cost}',
        'Final numbers from the local interactive logs.',
        '```',
      ].join('\n'),
    );
    const manager = createXmlManager('documents', ['cost.tex', 'arch.tex']);

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
      'scratchpad',
      [
        createExternalLocation('/tmp/run/cost.tex'),
        createExternalLocation('/tmp/run/arch.tex'),
      ],
    );

    expect(outputs.map((output) => output.source)).toEqual(['cost.tex']);
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

    // The snippet clears the routing threshold but is far too dissimilar to
    // be a credible revision, so it must not displace the exact copy (a
    // legitimately unchanged output) from its file.
    expect(assigned[0]?.name).toBe('f.tex');
    expect(assigned[1]).toBeNull();
  });
});
