export class ToolResult {
  output?: string;
  error?: string;
  base64Image?: string;
  system?: string;
  isError: boolean;
  diagnostics?: any; // Additional error details like validation issues

  constructor({
    output,
    error,
    base64Image,
    system,
    isError = false,
    diagnostics,
  }: {
    output?: string;
    error?: string;
    base64Image?: string;
    system?: string;
    isError?: boolean;
    diagnostics?: any;
  }) {
    this.output = output;
    this.error = error;
    this.base64Image = base64Image;
    this.system = system;
    this.isError = isError;
    this.diagnostics = diagnostics;
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
