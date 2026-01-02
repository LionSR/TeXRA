// Third-party imports
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';

// Local imports - core
import { parseAgentConfig } from '@agent/core/AgentConfig';
import { executeAgent } from '@agent/runtime/executeAgent';
import { showLoggedErrorMessage } from '@common/errors';
import {
  getActiveEditorWithGuards,
  logGuardFailure,
} from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';

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
      await showLoggedErrorMessage(CHANNEL, 'Failed to parse XML', err);
    }
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error parsing XML', err);
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
    await showLoggedErrorMessage(CHANNEL, 'Error validating XML', err);
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
