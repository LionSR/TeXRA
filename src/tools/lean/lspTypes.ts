/**
 * Minimal LSP shapes used by the Lean integrations.
 *
 * Keep these structural so Lean tooling is not coupled to the packaging
 * details of `vscode-languageserver-protocol`.
 */

type LspMarkupContent = {
  kind: 'plaintext' | 'markdown' | string;
  value: string;
};

type LspMarkedString = string | { language: string; value: string };

export interface LspHover {
  contents: LspMarkedString | LspMarkupContent | LspMarkedString[];
  range?: LspRange;
}

export interface LspDiagnostic {
  range: LspRange;
  message: string;
  severity?: number;
  source?: string;
}

export interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspPosition {
  line: number;
  character: number;
}
