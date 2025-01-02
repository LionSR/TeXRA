import * as nunjucks from 'nunjucks';
import { debug, error, initializeLogging } from '../logger/logUtils';

const CHANNEL = 'PromptUtils';
initializeLogging(CHANNEL);

/**
 * Convert a list of files to a comma-separated string
 * @param files List of file paths
 * @returns Comma-separated string of file paths
 */
export function getListOfFiles(files: string[] | null | undefined): string {
  try {
    if (!files) {
      return '';
    }
    return files.filter((f) => f !== null).join(', ');
  } catch (err) {
    error(
      CHANNEL,
      `Error creating file list: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Render a prompt string using nunjucks templating
 * @param prompt The prompt template string
 * @param variables Variables to use in template rendering
 * @returns Rendered prompt string
 */
export async function renderPrompt(
  prompt: string,
  variables: { [key: string]: any },
): Promise<string> {
  try {
    const env = nunjucks.configure({ autoescape: false });
    const renderedPrompt = env.renderString(prompt, variables);
    // debug(CHANNEL, `Rendered prompt: ${renderedPrompt}`);
    return renderedPrompt;
  } catch (err) {
    error(
      CHANNEL,
      `Error rendering prompt: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}
