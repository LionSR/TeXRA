import type { ZodIssue } from 'zod';

// Define proper type for diagnostic information
export type ErrorDiagnostics =
  | ZodIssue[] // For validation errors
  | { name: string; stack?: string } // For regular errors
  | unknown; // For other types of diagnostics

type ToolResultInit = {
  output?: string;
  error?: string;
  base64Image?: string;
  system?: string;
  isError?: boolean;
  diagnostics?: ErrorDiagnostics;
  summary?: string;
};

export type ToolResultLike = ToolResult | string | ToolResultInit;

export class ToolResult {
  output?: string;
  error?: string;
  base64Image?: string;
  system?: string;
  isError: boolean;
  diagnostics?: ErrorDiagnostics; // Additional error details like validation issues
  summary?: string;

  constructor({
    output,
    error,
    base64Image,
    system,
    isError = false,
    diagnostics,
    summary,
  }: ToolResultInit = {}) {
    this.output = output;
    this.error = error;
    this.base64Image = base64Image;
    this.system = system;
    this.isError = isError;
    this.diagnostics = diagnostics;
    this.summary = summary;
  }

  static from(result: ToolResultLike): ToolResult {
    if (result instanceof ToolResult) {
      return result;
    }
    if (typeof result === 'string') {
      return new ToolResult({ output: result });
    }
    return new ToolResult(result ?? {});
  }

  // Simple method to get the content for model API
  toContent(): string {
    // For API responses, we need the actual content, not the summary
    if (this.error) return this.error;
    if (this.output) return this.output;
    if (this.system) return this.system;
    return '';
  }

  add(other: ToolResult): ToolResult {
    function combine(
      a: string | undefined,
      b: string | undefined,
      concat = true,
    ): string | undefined {
      if (a && b) {
        if (concat) return a + b;
        throw new Error('Cannot combine tool results');
      }
      return a || b;
    }

    return new ToolResult({
      output: combine(this.output, other.output),
      error: combine(this.error, other.error),
      base64Image: combine(this.base64Image, other.base64Image, false),
      system: combine(this.system, other.system),
      isError: this.isError || other.isError,
      diagnostics: this.diagnostics || other.diagnostics,
      summary: this.summary ?? other.summary,
    });
  }
}

export class CLIResult extends ToolResult {
  constructor(opts: {
    output?: string;
    error?: string;
    base64Image?: string;
    system?: string;
    isError?: boolean;
  }) {
    super(opts);
  }
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}
