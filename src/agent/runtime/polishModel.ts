import { z } from 'zod';

import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { createTexraNunjucksEnvironment } from '@utils/prompt';
import { AbsoluteFS } from '@utils/files/absoluteFS';

let polishPromptPath: string | null = null;
let templatePromise: Promise<string> | null = null;

const PolishYamlSchema = z.object({
  prompts: z.object({ userRequest: z.string() }),
});

/**
 * Store the host-provided polish prompt YAML path. Call once during host
 * startup before text enhancement is used.
 */
export function initializePolishModel(pathToPromptYaml: string): void {
  polishPromptPath = pathToPromptYaml;
  templatePromise = null;
}

function loadPromptTemplate(): Promise<string> {
  if (templatePromise) return templatePromise;
  if (!polishPromptPath) {
    throw new Error(
      'Polish model not initialized. Call initializePolishModel() first.',
    );
  }
  templatePromise = (async () => {
    const content = await AbsoluteFS.read(polishPromptPath);
    const parsed = parseYamlWith(content, PolishYamlSchema);
    if (parsed.isErr()) {
      throw new Error(
        `Failed to parse polish prompt YAML at ${polishPromptPath}: ${parsed.error.message}`,
        { cause: parsed.error },
      );
    }
    return parsed.value.prompts.userRequest;
  })();
  return templatePromise;
}

/**
 * Render the polish prompt from the YAML template.
 * FILE_CONTEXT goes through nunjucks; user text is appended raw (safe from injection).
 */
export async function renderPolishPrompt(
  fileContext: string,
  text: string,
): Promise<string> {
  const [template, { default: nunjucks }] = await Promise.all([
    loadPromptTemplate(),
    import('nunjucks'),
  ]);
  const environment = createTexraNunjucksEnvironment(nunjucks);
  return (
    environment.renderString(template, { FILE_CONTEXT: fileContext }) + text
  );
}
