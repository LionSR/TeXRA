/**
 * The module `builtIn:text`: a file's whole text, for the programs that
 * compare a file with what it was.
 */

/** The lines `read_file` shows in one call. */
const PAGE = 2000;

/** The whole text of file, read a page at a time: `read_file` numbers its
 *  lines and shows no more than a page of them. */
export const read = async (file) => {
  const lines = [];
  for (let start = 1; ; start += PAGE) {
    const { output } = await tools.read_file({
      path: file,
      range: { start, end: start + PAGE - 1 },
    });
    const page = output === '' ? [] : output.split('\n');
    lines.push(...page.map((line) => line.replace(/^ *\d+\t/, '')));
    if (page.length < PAGE) return lines.join('\n');
  }
};
