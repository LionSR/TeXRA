const EMPTY_COUNTS = { files: 0, exports: 0, types: 0, duplicates: 0 };

// Flattens knip's per-issue-file shape (`{ file, files, exports, types,
// duplicates }`) into one finding per unused symbol, keyed by (file,
// category, name). A `duplicates` entry is a group of co-exported names that
// alias the same declaration; the group's own identity is the sorted,
// comma-joined member names, since knip doesn't give the group itself a name.
export function extractFindings(issues) {
  const findings = [];
  for (const issue of issues) {
    for (const entry of issue.files ?? []) {
      findings.push({ file: issue.file, category: 'files', name: entry.name });
    }
    for (const entry of issue.exports ?? []) {
      findings.push({
        file: issue.file,
        category: 'exports',
        name: entry.name,
      });
    }
    for (const entry of issue.types ?? []) {
      findings.push({ file: issue.file, category: 'types', name: entry.name });
    }
    for (const group of issue.duplicates ?? []) {
      const name = group
        .map((entry) => entry.name)
        .sort()
        .join(',');
      findings.push({ file: issue.file, category: 'duplicates', name });
    }
  }
  return findings;
}

export function findingKey(finding) {
  return `${finding.file} ${finding.category} ${finding.name}`;
}

export function compareFindings(a, b) {
  return (
    a.file.localeCompare(b.file) ||
    a.category.localeCompare(b.category) ||
    a.name.localeCompare(b.name)
  );
}

// Diffs by identity, not by count: a finding is "new" only if no baseline
// entry shares its (file, category, name), and a baseline entry is
// "resolved" only if nothing in the current run matches it. Both lists come
// back sorted for stable, readable CLI output.
export function diffFindings(current, baseline) {
  const baselineKeys = new Set(baseline.map(findingKey));
  const currentKeys = new Set(current.map(findingKey));
  return {
    newFindings: current
      .filter((finding) => !baselineKeys.has(findingKey(finding)))
      .toSorted(compareFindings),
    resolvedFindings: baseline
      .filter((finding) => !currentKeys.has(findingKey(finding)))
      .toSorted(compareFindings),
  };
}

export function countByCategory(findings) {
  const counts = { ...EMPTY_COUNTS };
  for (const { category } of findings) {
    counts[category] += 1;
  }
  return counts;
}

// Parses and validates the `--reporter json` stdout produced by `knip`.
// Split out from runKnip() so the parsing/validation logic is unit-testable
// without spawning the real knip binary.
export function parseKnipIssues(stdout, stderr) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (cause) {
    console.error(stdout);
    console.error(stderr);
    throw new Error('knip did not produce parseable JSON output', { cause });
  }
  if (!Array.isArray(parsed?.issues)) {
    console.error(stdout);
    console.error(stderr);
    throw new Error(
      'knip JSON output has no `issues` array; the --reporter json shape may have changed (see scripts/check-dead-code-ratchet.mjs)',
    );
  }
  return parsed.issues;
}

export function readBaseline(
  rawJson,
  baselinePath = 'config/ratchets/knip-baseline.json',
) {
  const data = JSON.parse(rawJson);
  if (!Array.isArray(data.findings)) {
    throw new Error(
      `${baselinePath} is missing a "findings" array; regenerate it (see scripts/check-dead-code-ratchet.mjs)`,
    );
  }
  return data.findings;
}
