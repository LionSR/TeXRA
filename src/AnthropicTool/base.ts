import { BetaToolUnionParam } from './types';

/**
 * Abstract base class for Anthropic-defined tools.
 */
export abstract class BaseAnthropicTool {
  /**
   * Executes the tool with the given arguments.
   * @param args - Tool arguments
   */
  abstract call(...args: any[]): Promise<ToolResult>;

  /**
   * Convert the tool to the format expected by Anthropic's API
   */
  abstract toParams(): BetaToolUnionParam;
}

/**
 * Represents the result of a tool execution.
 */
export class ToolResult {
  output?: string;
  error?: string;
  base64Image?: string;
  system?: string;
  isError: boolean;

  constructor({
    output = undefined,
    error = undefined,
    base64Image = undefined,
    system = undefined,
    isError = false,
  }: {
    output?: string;
    error?: string;
    base64Image?: string;
    system?: string;
    isError?: boolean;
  }) {
    this.output = output;
    this.error = error;
    this.base64Image = base64Image;
    this.system = system;
    this.isError = isError;
  }

  /**
   * Combines this result with another result.
   * @param other - The other result to combine with
   */
  add(other: ToolResult): ToolResult {
    function combineFields(
      field1: string | undefined,
      field2: string | undefined,
      concatenate: boolean = true,
    ): string | undefined {
      if (field1 && field2) {
        if (concatenate) {
          return field1 + field2;
        }
        throw new Error('Cannot combine tool results');
      }
      return field1 || field2;
    }

    return new ToolResult({
      output: combineFields(this.output, other.output),
      error: combineFields(this.error, other.error),
      base64Image: combineFields(this.base64Image, other.base64Image, false),
      system: combineFields(this.system, other.system),
      isError: this.isError || other.isError,
    });
  }
}

/**
 * Represents a successful CLI output result.
 */
export class CLIResult extends ToolResult {
  constructor({
    output = undefined,
    error = undefined,
    base64Image = undefined,
    system = undefined,
    isError = false,
  }: {
    output?: string;
    error?: string;
    base64Image?: string;
    system?: string;
    isError?: boolean;
  }) {
    super({ output, error, base64Image, system, isError });
  }
}

/**
 * Error thrown when a tool encounters an error.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
