// Third-party imports
import { XMLParser } from 'fast-xml-parser';

// Local imports - core
import { runGuardedFileCommand } from '@frontend/editor/activeFileGuards';
import * as logger from '@logger/logUtils';

const CHANNEL = 'XmlCommands';

export async function handleParseXml(): Promise<void> {
  await runGuardedFileCommand(
    {
      channel: CHANNEL,
      action: 'parse XML',
      resourceName: 'XML',
      allowedExtensions: ['.xml'],
      errorMessage: 'Error parsing XML',
    },
    async ({ editor }) => {
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
      logger.debug(
        CHANNEL,
        `Parsed XML:\n${JSON.stringify(parsedXml, null, 2)}`,
      );
    },
  );
}
