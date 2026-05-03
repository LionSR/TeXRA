// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - templates
import latexPreamble from '../../resources/templates/chatExport.tex';

describe('Vitest kernel harness', () => {
  it('loads TeX templates as raw text', () => {
    expect(latexPreamble).toContain('\\documentclass');
  });
});
