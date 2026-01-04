// Local imports - replacement
import { ReplacementCategory } from '@replacement/types';

export const FONT_COMMAND_REPLACEMENTS: ReplacementCategory = {
  name: 'font_commands',
  description: 'Normalize deprecated font commands to modern equivalents',
  isRegex: false,
  patterns: (() => {
    const patterns: { [key: string]: string } = {};
    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'];
    letters.forEach((letter) => {
      patterns[`{\\rm ${letter}}`] = `\\mathrm{${letter}}`;
      patterns[`{\\bf ${letter}}`] = `\\mathbf{${letter}}`;
      patterns[`{\\it ${letter}}`] = `\\mathit{${letter}}`;
      patterns[`{\\sf ${letter}}`] = `\\mathsf{${letter}}`;
      patterns[`{\\tt ${letter}}`] = `\\mathtt{${letter}}`;
    });

    const uppercase = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    uppercase.forEach((letter) => {
      patterns[`{\\cal ${letter}}`] = `\\mathcal{${letter}}`;
    });

    return patterns;
  })(),
};

export default FONT_COMMAND_REPLACEMENTS;
