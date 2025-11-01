// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import { parseAgentConfig, type AgentConfig } from '@agent/core/AgentConfig';

// Local imports
import {
  AgentSetting,
  AgentType,
  AgentCategory,
} from '@agent/core/AgentDataclass';
import { XmlOutputManager } from '@agent/output/XmlOutputManager';
import { AgentLogger } from '@logger/AgentLogger';
import { WorkspaceFS } from '@utils/files';

describe('XmlOutputManager markdown fallback', () => {
  const setting: AgentSetting = {
    agentType: AgentType.CoT,
    agentCategory: AgentCategory.Workflow,
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
    isMultipleOutput: false,
    filePatternsContain: [],
    tools: [],
  };

  const config: AgentConfig = parseAgentConfig({
    model: 'test',
    agent: 'a',
    instruction: '',
    useMultipleOutputs: false,
    inputFile: 'input.tex',
    toolConfig: {
      autoExtractFigure: false,
      autoExtractTikzFigure: false,
      attachTeXCount: false,
      attachDiagnostics: false,
      autoCompileInputPdf: false,
    },
  });

  it('writes tex file from markdown fenced latex block', async () => {
    const logger = new AgentLogger('TestXmlOutput');
    const manager = new XmlOutputManager(setting, config, logger);
    const outputXml = 'markdown_only.xml';
    const markdownContent =
      '```latex\n\\begin{document}\nhello\n\\end{document}\n```';

    await WorkspaceFS.write(outputXml, markdownContent);

    const texPath = await manager.splitScratchpadOutputXml(
      outputXml,
      setting.documentTag,
    );

    const written = await WorkspaceFS.read('markdown_only.tex');
    assert.ok(written.includes('hello'));

    await WorkspaceFS.delete(outputXml);
    await WorkspaceFS.delete(texPath);
  });

  it('writes tex file from named document tag', async () => {
    const logger = new AgentLogger('TestXmlOutput');
    const manager = new XmlOutputManager(setting, config, logger);
    const outputXml = 'named_document.xml';
    const xmlContent =
      '<document name="input.tex"><![CDATA[\\begin{document}\nhello\n\\end{document}]]></document>';

    await WorkspaceFS.write(outputXml, xmlContent);

    const texPath = await manager.splitScratchpadOutputXml(
      outputXml,
      setting.documentTag,
    );

    const written = await WorkspaceFS.read('named_document.tex');
    assert.ok(written.includes('hello'));
    assert.ok(!written.includes('CDATA'));

    await WorkspaceFS.delete(outputXml);
    await WorkspaceFS.delete(texPath);
  });

  it('prefers named document over latex_document when both present', async () => {
    const logger = new AgentLogger('TestXmlOutput');
    const manager = new XmlOutputManager(setting, config, logger);
    const outputXml = 'both_tags.xml';
    const xmlContent = `<?xml version="1.0"?>
<latex_document>
  <![CDATA[\\begin{document}wrong\\end{document}]]>
  <document name="input.tex"><![CDATA[\\begin{document}right\\end{document}]]></document>
</latex_document>`;

    await WorkspaceFS.write(outputXml, xmlContent);

    const texPath = await manager.splitScratchpadOutputXml(
      outputXml,
      setting.documentTag,
    );

    const written = await WorkspaceFS.read('both_tags.tex');
    assert.ok(written.includes('right'));
    assert.ok(!written.includes('wrong'));

    await WorkspaceFS.delete(outputXml);
    await WorkspaceFS.delete(texPath);
  });

  it('writes tex file from plain LaTeX document block', async () => {
    const logger = new AgentLogger('TestXmlOutput');
    const manager = new XmlOutputManager(setting, config, logger);
    const outputXml = 'plain_latex.xml';
    const content =
      'some explanation\n\\documentclass{article}\n\\begin{document}\nhello\n\\end{document}\nmore text';

    await WorkspaceFS.write(outputXml, content);

    const texPath = await manager.splitScratchpadOutputXml(
      outputXml,
      setting.documentTag,
    );

    const written = await WorkspaceFS.read('plain_latex.tex');
    assert.ok(written.includes('\\documentclass'));
    assert.ok(written.includes('\\end{document}'));
    assert.ok(!written.includes('some explanation'));

    await WorkspaceFS.delete(outputXml);
    await WorkspaceFS.delete(texPath);
  });
});
