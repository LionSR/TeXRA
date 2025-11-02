// Local imports - formatter implementations
import { runLatexIndent } from './formatter/latexindentpt';
import { runTexFmt } from './formatter/texfmt';

// Local imports - utilities
import { getConfig } from '@utils/config';

export async function runLatexFormatter(filePath: string): Promise<boolean> {
  const formatter = getConfig<string>('texra.latex.formatter', 'latexindent');
  if (formatter === 'none') {
    return true;
  }
  if (formatter === 'tex-fmt') {
    return runTexFmt(filePath);
  }
  return runLatexIndent(filePath);
}
