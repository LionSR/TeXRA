// Third-party imports
import { XMLParser } from 'fast-xml-parser';

// Local imports - core
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import {
  getActiveEditorWithGuards,
  logGuardFailure,
} from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';

const CHANNEL = 'XmlCommands';

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

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: true,
      textNodeName: 'content',
      attributeNamePrefix: '',
    });

    const parsedXml = parser.parse(content);
    logger.debug(CHANNEL, `Parsed XML:\n${JSON.stringify(parsedXml, null, 2)}`);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Error parsing XML', err);
  }
}
