// Standard library imports
// (none needed)

// Third-party imports
import Anthropic from '@anthropic-ai/sdk';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getApiKey } from './secretUtils';
import { extractTextFromTag } from './xmlUtils';

const CHANNEL = 'TextEnhancement';

/**
 * Text Enhancement Utilities
 *
 * This module contains utilities for enhancing and polishing text content.
 * It can be extended with additional text processing functions in the future,
 * such as:
 * - Text summarization
 * - Format conversion (e.g., from plain text to LaTeX)
 * - Code formatting
 * - Text generation based on templates
 * - Text simplification or complexity adjustment
 */

/**
 * Interface for file context information
 */
export interface FileContext {
  agent?: string;
  inputFile?: string;
  inputFiles?: string[];
  referenceFile?: string;
  referenceFiles?: string[];
  auxiliaryFile?: string;
  auxiliaryFiles?: string[];
  figureFile?: string;
  figureFiles?: string[];
  outputFiles?: string[];
}

/**
 * Polishes instruction text using Claude AI model
 * Corrects spelling, grammar, and formatting for LaTeX, XML, and Markdown
 * Also corrects file references if fileContext is provided
 *
 * @param text The text to polish
 * @param fileContext Optional context about files being used in the task
 * @returns Promise with the polished text or error message
 */
export async function polishTextWithAI(
  text: string,
  fileContext?: FileContext,
): Promise<{ success: boolean; text: string; error?: string }> {
  try {
    // Get the API key from secrets
    const apiKey = await getApiKey('anthropic');
    if (!apiKey) {
      return {
        success: false,
        text: text,
        error: 'No Anthropic API key found. Please set your API key first.',
      };
    }

    // Build file context string if available
    let fileContextString = '';
    if (fileContext) {
      fileContextString = 'Current context:\n';

      // Add agent and model information
      if (fileContext.agent) {
        fileContextString += `Agent: ${fileContext.agent}\n`;
      }

      // Add files section header if there are any files
      const hasFiles =
        fileContext.inputFile ||
        (fileContext.inputFiles && fileContext.inputFiles.length > 0) ||
        fileContext.referenceFile ||
        (fileContext.referenceFiles && fileContext.referenceFiles.length > 0) ||
        fileContext.auxiliaryFile ||
        (fileContext.auxiliaryFiles && fileContext.auxiliaryFiles.length > 0) ||
        fileContext.figureFile ||
        (fileContext.figureFiles && fileContext.figureFiles.length > 0) ||
        (fileContext.outputFiles && fileContext.outputFiles.length > 0);

      if (hasFiles) {
        fileContextString += '\nFiles in the task:\n';

        // Add main input file
        if (fileContext.inputFile) {
          fileContextString += `Input File: ${fileContext.inputFile}\n`;
        }

        // Add arrays of files
        const fileArrays = [
          { name: 'Input Files', files: fileContext.inputFiles },
          { name: 'Reference Files', files: fileContext.referenceFiles },
          { name: 'Auxiliary Files', files: fileContext.auxiliaryFiles },
          { name: 'Figure Files', files: fileContext.figureFiles },
          { name: 'Output Files', files: fileContext.outputFiles },
        ];

        for (const { name, files } of fileArrays) {
          if (files && files.length > 0) {
            fileContextString += `${name}: ${files.join(', ')}\n`;
          }
        }

        // Add single files
        if (fileContext.referenceFile) {
          fileContextString += `Reference File: ${fileContext.referenceFile}\n`;
        }
        if (fileContext.auxiliaryFile) {
          fileContextString += `Auxiliary File: ${fileContext.auxiliaryFile}\n`;
        }
        if (fileContext.figureFile) {
          fileContextString += `Figure File: ${fileContext.figureFile}\n`;
        }
      }
    }

    // Setup the prompt
    const prompt = `Please review the following instruction text and correct any spelling errors, typos, grammatical mistakes, or punctuation issues. Preserve the original meaning and tone without adding new content or changing the structure unless necessary for clarity.

${fileContextString ? fileContextString + '\n' : ''}This text will be used as an instruction for editing the files mentioned above. If the text contains references to these files, please ensure they are correctly spelled and match the exact filenames.

Also, please follow these specific formatting rules:
1. If you spot inline LaTeX formulas, ensure they are wrapped with $ symbols (e.g., $E=mc^2$)
2. If you spot XML tags, fix any unbalanced or unpaired tags
3. If you spot Markdown syntax (like headers, lists, emphasis, links), fix any incorrect syntax
4. If there are partial or ambiguous references to filenames from the context provided above, correct them to use the proper full filename

Return the corrected text wrapped in <corrected_text> XML tags.

Text to correct:
${text}`;

    // Use the Anthropic SDK
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.beta.messages.create({
      model: 'claude-3-7-sonnet-20250219',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });

    // Extract the response text
    let responseText = '';
    if (
      response.content &&
      response.content.length > 0 &&
      response.content[0].type === 'text'
    ) {
      responseText = response.content[0].text;
    } else {
      // Handle the case where the expected structure isn't found
      logger.warn(CHANNEL, 'Unexpected response format from API');
      responseText = JSON.stringify(response.content);
    }

    // Extract the corrected text using the utility function
    const correctedText = extractTextFromTag(responseText, 'corrected_text');

    // Trim leading and trailing newlines from the text
    const trimmedText = correctedText
      ? correctedText.trim()
      : responseText.trim();

    return {
      success: true,
      text: trimmedText,
    };
  } catch (error) {
    logger.error(
      CHANNEL,
      `Error polishing text: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      success: false,
      text: text,
      error: `Error polishing text: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
