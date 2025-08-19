import { strict as assert } from 'assert';

// Local imports
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS } from '@utils/files';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';

const setting: AgentSetting = {
  agentType: AgentType.CoT,
  documentTag: 'latex_document',
  temperature: 0,
  isRewrite: true,
  rounds: 1,
  prefills: [],
  outputExt: 'tex',
  endTag: '</latex_document>',
  requiredFiles: {},
  requiredFilesInternal: {},
  defaultOutputFiles: [],
  filePatternsContain: [],
  tools: [],
};

const config: AgentConfig = {
  model: 'test',
  agent: 'a',
  instruction: '',
  inputFile: 'input.tex',
  inputFiles: null,
  referenceFile: null,
  referenceFiles: null,
  auxiliaryFile: null,
  auxiliaryFiles: null,
  mediaFile: null,
  mediaFiles: null,
  outputFiles: null,
  editedFile: null,
  toolConfig: {
    reflect: false,
    usePrefillFromInput: false,
    autoExtractFigure: false,
    autoExtractTikzFigure: false,
    attachTeXCount: false,
    attachDiagnostics: false,
    printInputPrompt: false,
    autoCompileInputPdf: false,
  },
};

describe('XmlOutputManager markdown fallback', () => {
  it('writes tex file from markdown fenced latex block', async () => {
    const logger = new AgentLogger('TestXmlOutput');
    const manager = new XmlOutputManager(setting, config, logger);
    const outputXml = 'markdown_only.xml';
    const markdownContent =
      '```latex\n\\begin{document}\nhello\n\\end{document}\n```';

    await WorkspaceFS.writeFile(outputXml, markdownContent);

    const texPath = await manager.splitScratchpadOutputXml(
      outputXml,
      setting.documentTag,
    );

    const written = await WorkspaceFS.readFile('markdown_only.tex');
    assert.ok(written.includes('hello'));

    await WorkspaceFS.delete(outputXml);
    await WorkspaceFS.delete(texPath);
  });
});

describe('XmlOutputManager named-document fallback', () => {
  it('writes tex file when latex_document uses name attribute', async () => {
    const logger = new AgentLogger('TestXmlOutput');
    const manager = new XmlOutputManager(setting, config, logger);
    const outputXml = 'named_document.xml';
    const namedContent =
      '<latex_document name="input.tex"><![CDATA[\\begin{document}\nhello\n\\end{document}]]></latex_document>';

    await WorkspaceFS.writeFile(outputXml, namedContent);

    const texPath = await manager.splitScratchpadOutputXml(
      outputXml,
      setting.documentTag,
    );

    const written = await WorkspaceFS.readFile('named_document.tex');
    assert.ok(written.includes('hello'));

    await WorkspaceFS.delete(outputXml);
    await WorkspaceFS.delete(texPath);
  });
});
