import OpenAI from 'openai';
import * as vscode from 'vscode';

interface ConnectionResult {
  connector: string;
  choice: string;
}

/**
 * Determines the best way to connect two strings in a LaTeX context using GPT-4
 * @param str1 First string
 * @param str2 Second string
 * @param openaiApiKey Optional OpenAI API key
 * @returns Promise containing the best connector and the model's choice
 */
export async function bestConnectionMethod(
  str1: string,
  str2: string,
  openaiApiKey?: string,
): Promise<ConnectionResult> {
  // If API key not provided, try to get it from VS Code settings
  if (!openaiApiKey) {
    openaiApiKey = vscode.workspace
      .getConfiguration('coauthor.apiKeys')
      .get<string>('openai');

    if (!openaiApiKey) {
      throw new Error(
        'OpenAI API key not found in settings (coauthor.apiKeys.openai)',
      );
    }
  }

  // Define the strings A, B, C
  const A = str1 + str2;
  const B = str1 + ' ' + str2;
  const C = str1 + '\n' + str2;

  // Set up the prompt for the GPT model
  const prompt =
    `Given three strings from a LaTeX document:\n` +
    `A: ${A}\n` +
    `B: ${B}\n` +
    `C: ${C}\n` +
    `Which is more english and latex grammatically correct? Output 'A', 'B', or 'C' directly without giving any reason.`;

  try {
    // Initialize OpenAI client
    const client = new OpenAI({
      apiKey: openaiApiKey,
    });

    // Query the model
    const completion = await client.chat.completions.create({
      model: 'gpt-4-turbo',
      temperature: 0,
      n: 10,
      messages: [
        {
          role: 'system',
          content:
            'You are an assistant trained to determine the most grammatically correct string in a LaTeX document context.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    // Extract and process choices
    const choices = completion.choices.map(
      (choice) => choice.message.content?.trim() ?? '',
    );

    // Determine majority vote
    const choiceCounts = new Map<string, number>();
    choices.forEach((choice) => {
      choiceCounts.set(choice, (choiceCounts.get(choice) ?? 0) + 1);
    });

    let majorityChoice = '';
    let maxCount = 0;
    choiceCounts.forEach((count, choice) => {
      if (count > maxCount) {
        maxCount = count;
        majorityChoice = choice;
      }
    });

    // Map choices to connectors
    const caseDict: { [key: string]: string } = {
      A: '',
      B: ' ',
      C: '\n',
    };

    if (majorityChoice in caseDict) {
      return {
        connector: caseDict[majorityChoice],
        choice: majorityChoice,
      };
    } else {
      console.log(
        `Invalid choice: ${majorityChoice}. Defaulting to adding a space.`,
      );
      return {
        connector: ' ',
        choice: 'B',
      };
    }
  } catch (error) {
    console.error('Error in bestConnectionMethod:', error);
    return {
      connector: ' ',
      choice: 'B',
    };
  }
}

// Example usage:
// async function test() {
//   // const result = await bestConnectionMethod("Hello", "world", "your-api-key");
//   const result = await bestConnectionMethod('Hello', 'world');
//   console.log(result);
// }
// test();
