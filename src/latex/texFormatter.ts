// Local imports - formatter implementations
import { runLatexIndent } from './formatter/latexindentpt';
import { runTexFmt } from './formatter/texfmt';

// Local imports - utilities
import { getConfig } from '../utils/configUtils';

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = getConfig<string>('latex.formatter', 'latexindent');
  if (formatter === 'tex-fmt') {
    return runTexFmt(filePath);
  }
  return runLatexIndent(filePath);
}
