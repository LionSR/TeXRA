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

function createXmlManager(documentTag = 'document'): XmlOutputManager {
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
      inputFiles: ['paper.tex'],
    } as AgentConfig,
    { debug: vi.fn(), info: vi.fn() } as unknown as AgentTrace,
    new TaskRunFileService(),
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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

  it('makes duplicate percent filename headers unique before writing', async () => {
    await AbsoluteFS.write(
      '/tmp/run/output.xml',
      ['% chunk.tex', 'First.', '% chunk.tex', 'Second.'].join('\n'),
    );
    const manager = createXmlManager('documents');

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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

    const outputs = await manager.splitScratchpadMultipleOutputXml(
      createExternalLocation('/tmp/run/output.xml'),
      'documents',
      0,
    );

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
});
