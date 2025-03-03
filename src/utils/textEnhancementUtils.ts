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
 * Polishes instruction text using Claude AI model
 * Corrects spelling, grammar, and formatting for LaTeX, XML, and Markdown
 *
 * @param text The text to polish
 * @returns Promise with the polished text or error message
 */
export async function polishTextWithAI(
  text: string,
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

    // Setup the prompt
    const prompt = `Please review the following text and correct any spelling errors, typos, grammatical mistakes, or punctuation issues. Preserve the original meaning and tone without adding new content or changing the structure unless necessary for clarity.

Also, please follow these specific formatting rules:
1. If you spot inline LaTeX formulas, ensure they are wrapped with $ symbols (e.g., $E=mc^2$)
2. If you spot XML tags, fix any unbalanced or unpaired tags
3. If you spot Markdown syntax (like headers, lists, emphasis, links), fix any incorrect syntax

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
