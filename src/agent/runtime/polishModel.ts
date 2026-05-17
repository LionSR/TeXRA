import * as path from 'path';

import * as nunjucks from 'nunjucks';
import * as yaml from 'yaml';
import { z } from 'zod';

import { AbsoluteFS } from '@utils/files';

const nunjucksEnv = nunjucks.configure({ autoescape: false });

let extensionPath: string | null = null;
let templatePromise: Promise<string> | null = null;

const PolishYamlSchema = z.object({
  prompts: z.object({ userRequest: z.string() }),
});

/**
 * Store the extension path so the YAML template can be located later.
 * Call once during extension activation.
 */
export function initializePolishModel(extPath: string): void {
  extensionPath = extPath;
}

function loadPromptTemplate(): Promise<string> {
  if (templatePromise) return templatePromise;
  if (!extensionPath) {
    throw new Error(
      'Polish model not initialized. Call initializePolishModel() first.',
    );
  }
  const yamlPath = path.join(
    extensionPath,
    'resources',
    'templates',
    'instructionPolish.yaml',
  );
  templatePromise = (async () => {
    const content = await AbsoluteFS.read(yamlPath);
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
