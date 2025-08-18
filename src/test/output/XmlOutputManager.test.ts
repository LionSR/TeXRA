import { strict as assert } from 'assert';

// Local imports
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { AgentSetting, AgentType } from '@agent/core/AgentDataclass';
import type { AgentConfig } from '@agent/core/AgentConfig';
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS } from '@utils/files';

describe('XmlOutputManager.splitScratchpadOutputXml', () => {
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

  it('recovers LaTeX from Markdown code fence when XML tags missing', async () => {
    const manager = new XmlOutputManager(
      setting,
      config,
      new AgentLogger('XmlOutputTest'),
    );
    const xmlContent =
      '<scratchpad>think</scratchpad>\n```latex\n\\begin{document}\nhello\\end{document}\n```';
    const xmlFile = 'markdown-output.xml';
    await WorkspaceFS.writeFile(xmlFile, xmlContent);

    const texFile = await manager.splitScratchpadOutputXml(
      xmlFile,
      'latex_document',
    );
    const texContent = await WorkspaceFS.readFile(texFile);
    assert.ok(texContent.includes('hello'));

    await WorkspaceFS.delete(xmlFile);
    await WorkspaceFS.delete('markdown-output.tex');
  });
});
