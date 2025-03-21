// Third-party imports
import * as vscode from 'vscode';
import { XMLParser } from 'fast-xml-parser';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - core
import { XMLValidatorAgent } from '../AnthropicTool';

// Local imports - utils
import { getRelativePath } from '../utils/workspaceFileUtils';

const CHANNEL = 'XmlCommands';
logger.initialize(CHANNEL);

export const xmlCommands = {
  parseXml: 'coauthor.parseXml',
  validateAndFixXml: 'coauthor.validateAndFixXml',
};

export async function handleParseXml(): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      logger.warn(CHANNEL, 'No active editor found');
      vscode.window.showWarningMessage('Please open an XML file first');
      return;
    }

    // Check if it's an XML file
    if (!editor.document.fileName.toLowerCase().endsWith('.xml')) {
      logger.warn(
        CHANNEL,
        `File ${editor.document.fileName} is not an XML file`,
      );
      vscode.window.showWarningMessage(
        'This command only works with XML files',
      );
      return;
    }

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
export async function handleValidateAndFixXml(): Promise<void> {
  try {
    // Get active editor
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Please open an XML file first');
      return;
    }

    // Check if it's an XML file
    if (!editor.document.fileName.toLowerCase().endsWith('.xml')) {
      logger.warn(
        CHANNEL,
        `File ${editor.document.fileName} is not an XML file`,
      );
      vscode.window.showWarningMessage(
        'This command only works with XML files',
      );
      return;
    }

    // Initialize the validator agent
    const validator = XMLValidatorAgent.create();

    // Save the file first to make sure we're working with the latest content
    await editor.document.save();

    // Get the file path
    const filePath = getRelativePath(editor.document.fileName);

    // Use the validator to fix any XML errors
    logger.info(CHANNEL, `Starting XML validation for ${filePath}`);

    // Show progress while validating
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Validating and fixing XML using Claude',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Analyzing XML...' });

        // Use the standard fixIssues method
        const result = await validator.fixIssues(filePath);

        if (result) {
          progress.report({ message: 'Fixed successfully!' });
        } else {
          progress.report({ message: 'Could not fix all issues' });
        }

        // Return a Promise that resolves after 1.5 seconds to give user time to see the result
        return new Promise((resolve) => setTimeout(resolve, 1500));
      },
    );
  } catch (err) {
    logger.error(
      CHANNEL,
      `Error in validateAndFixXml command: ${err instanceof Error ? err.message : String(err)}`,
    );
    vscode.window.showErrorMessage(`Error validating XML: ${String(err)}`);
  }
}

export function registerXmlCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(xmlCommands.parseXml, handleParseXml),
    vscode.commands.registerCommand(
      xmlCommands.validateAndFixXml,
      handleValidateAndFixXml,
    ),
  );
  return xmlCommands;
}
