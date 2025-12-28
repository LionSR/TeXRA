// Third-party imports
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';

// Local imports - core
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import {
  getActiveEditorWithGuards,
  logGuardFailure,
} from '@frontend/editor/activeFileGuards';

const CHANNEL = 'XmlCommands';
logger.initialize(CHANNEL);

export const xmlCommands = {
  parseXml: 'texra.parseXml',
  validateAndFixXml: 'texra.validateAndFixXml',
};

export async function handleParseXml(): Promise<void> {
  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.xml'],
      resourceName: 'XML',
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure(CHANNEL, 'parse XML', guardResult.status, 'XML');
      return;
    }

    const { editor } = guardResult;
    const content = editor.document.getText();
    logger.debug(
      CHANNEL,
      `Parsing XML content from: ${editor.document.fileName}`,
    );

    // Parse XML using the same configuration as OutputHandler
    const parser = new XMLParser({
      ignoreAttributes: false,
      // preserveOrder: true,
      parseTagValue: true,
      textNodeName: 'content',
      attributeNamePrefix: '',
    });

    try {
      const parsedXml = parser.parse(content);

      logger.debug(CHANNEL, 'Parsed XML(JSON)');
      logger.debug(
        CHANNEL,
        `Parsed structure: ${JSON.stringify(parsedXml, null, 2)}`,
      );
    } catch (err) {
      logger.error(CHANNEL, `Failed to parse XML: ${toErrorMessage(err)}`);
      vscode.window.showErrorMessage('Failed to parse XML content');
    }
  } catch (err) {
    logger.error(CHANNEL, `Error in parseXml command: ${toErrorMessage(err)}`);
    vscode.window.showErrorMessage('Error parsing XML');
  }
}

/**
 * Validate and fix XML errors using Claude
 */
export async function handleValidateAndFixXml(
  _context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.xml'],
      resourceName: 'XML',
      saveDocument: true,
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure(CHANNEL, 'validate XML', guardResult.status, 'XML');
      return;
    }

    const { relativePath: filePath } = guardResult;

    logger.info(CHANNEL, `Starting XML validation for ${filePath}`);

    const agentConfig = parseAgentConfig({
      agent: 'xml_validator',
      model: 'claude-3-7-sonnet-latest',
      inputFile: filePath,
    });

    await executeAgent(agentConfig);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in validateAndFixXml command: ${toErrorMessage(err)}`,
    );
    vscode.window.showErrorMessage(`Error validating XML: ${String(err)}`);
  }
}

export function registerXmlCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(xmlCommands.parseXml, handleParseXml),
    vscode.commands.registerCommand(xmlCommands.validateAndFixXml, () =>
      handleValidateAndFixXml(context),
    ),
  );
  return xmlCommands;
}
