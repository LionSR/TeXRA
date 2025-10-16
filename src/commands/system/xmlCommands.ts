// Third-party imports
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - core
import { executeAgent } from '@agent/runtime/executeAgent';

// Local imports - utils
import {
  getActiveEditorWithGuards,
  type ActiveFileGuardFailureReason,
} from '@utils/editor/activeFileGuards';

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
      logGuardFailure('parse XML', guardResult.status);
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
      logger.error(
        CHANNEL,
        `Failed to parse XML: ${err instanceof Error ? err.message : String(err)}`,
      );
      vscode.window.showErrorMessage('Failed to parse XML content');
    }
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in parseXml command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage('Error parsing XML');
  }
}

/**
 * Validate and fix XML errors using Claude
 */
export async function handleValidateAndFixXml(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const guardResult = await getActiveEditorWithGuards({
      allowedExtensions: ['.xml'],
      resourceName: 'XML',
      saveDocument: true,
    });

    if (guardResult.status !== 'ok') {
      logGuardFailure('validate XML', guardResult.status);
      return;
    }

    const { relativePath: filePath } = guardResult;

    logger.info(CHANNEL, `Starting XML validation for ${filePath}`);

    await executeAgent(
      {
        agent: 'xml_validator',
        model: 'claude-3-7-sonnet-latest',
        inputFile: filePath,
      },
      context,
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in validateAndFixXml command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(`Error validating XML: ${String(err)}`);
  }
}

function logGuardFailure(
  action: string,
  reason: ActiveFileGuardFailureReason,
): void {
  switch (reason) {
    case 'noEditor':
      logger.warn(CHANNEL, `Cannot ${action}: no active editor found.`);
      break;
    case 'unsupportedExtension':
      logger.warn(
        CHANNEL,
        `Cannot ${action}: active document is not an XML file.`,
      );
      break;
    case 'saveFailed':
      logger.error(
        CHANNEL,
        `Cannot ${action}: failed to save XML document before running command.`,
      );
      break;
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
