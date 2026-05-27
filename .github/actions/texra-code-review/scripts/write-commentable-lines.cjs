const fs = require('node:fs');

function ensureAnchor(anchors, filePath) {
  if (!anchors.has(filePath)) {
    anchors.set(filePath, { LEFT: new Set(), RIGHT: new Set() });
  }
  return anchors.get(filePath);
}

function addAnchor(anchors, filePath, side, line) {
  if (!filePath || !Number.isInteger(line) || line < 1) return;
  ensureAnchor(anchors, filePath)[side].add(line);
}

function ranges(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) {
    const last = result.at(-1);
    if (last && value === last.end + 1) {
      last.end = value;
    } else {
      result.push({ start: value, end: value });
    }
  }
  return result;
}

function parseCommentableLines(diffText) {
  const anchors = new Map();
  let currentPath = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diffText.split('\n')) {
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (fileMatch) {
      currentPath = fileMatch[2];
      inHunk = false;
      continue;
    }
    const oldFileMatch = line.match(/^--- a\/(.+)$/);
    if (oldFileMatch && currentPath == null) {
      currentPath = oldFileMatch[1];
      continue;
    }
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (newFileMatch) {
      currentPath = newFileMatch[1];
      inHunk = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10);
      newLine = Number.parseInt(hunkMatch[2], 10);
      inHunk = true;
      continue;
    }
    if (!currentPath || !inHunk) {
      continue;
    }
    if (line.startsWith('+')) {
      addAnchor(anchors, currentPath, 'RIGHT', newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      addAnchor(anchors, currentPath, 'LEFT', oldLine);
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return {
    note: 'Use these line anchors for GitHub inline review comments. RIGHT means head lines; LEFT means removed base lines.',
    files: [...anchors.entries()].map(([filePath, sides]) => ({
      path: filePath,
      right: ranges(sides.RIGHT),
      left: ranges(sides.LEFT),
    })),
  };
}

function formatRanges(items) {
  return (
    items
      .map((range) =>
        range.start === range.end
          ? `${range.start}`
          : `${range.start}-${range.end}`,
      )
      .join(', ') || '(none)'
  );
}

function toMarkdown(payload) {
  return [
    '# Commentable PR Lines',
    '',
    'Use only these line anchors for JSON `comments`. Use `RIGHT` for changed head lines and `LEFT` for removed base lines. Put all other findings in the review body.',
    '',
    ...payload.files.flatMap((file) => [
      `## ${file.path}`,
      `- RIGHT: ${formatRanges(file.right)}`,
      `- LEFT: ${formatRanges(file.left)}`,
      '',
    ]),
  ].join('\n');
}

function writeCommentableLines({
  diffPath = process.env.TEXRA_DIFF_FILE || '.texra-action/pr.diff',
  jsonPath = process.env.TEXRA_COMMENTABLE_LINES_JSON ||
    '.texra-action/commentable-lines.json',
  markdownPath = process.env.TEXRA_COMMENTABLE_LINES_MD ||
    '.texra-action/commentable-lines.md',
} = {}) {
  const payload = parseCommentableLines(fs.readFileSync(diffPath, 'utf8'));
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(markdownPath, `${toMarkdown(payload)}\n`);
  return payload;
}

if (require.main === module) {
  writeCommentableLines();
}

module.exports = {
  parseCommentableLines,
  toMarkdown,
  writeCommentableLines,
};
