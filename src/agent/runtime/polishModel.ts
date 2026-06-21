import * as nunjucks from 'nunjucks';
import * as yaml from 'yaml';
import { z } from 'zod';

import { AbsoluteFS } from '@utils/files/absoluteFS';

const nunjucksEnv = nunjucks.configure({ autoescape: false });

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
    return PolishYamlSchema.parse(yaml.parse(content)).prompts.userRequest;
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
  const template = await loadPromptTemplate();
  const rendered = nunjucksEnv.renderString(template, {
    FILE_CONTEXT: fileContext,
  });
  return rendered + text;
}
