#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';

const manifestPath =
  'docs/prds/2026-05-10-prd-cli-runcontext-logger-orchestration.manifest.json';
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const errors = [];

function expect(condition, message) {
  if (!condition) errors.push(message);
}

expect(
  manifest.status === 'in_progress' || manifest.status === 'complete',
  'manifest status must be in_progress or complete',
);
if (manifest.status === 'complete') {
  expect(
    manifest.validationStatus === 'complete_landed',
    'complete manifests must use validationStatus complete_landed',
  );
  expect(
    Array.isArray(manifest.currentAudit?.remainingGaps) &&
      manifest.currentAudit.remainingGaps.length === 0,
    'complete manifests must not list remaining gaps',
  );
} else {
  expect(
    manifest.validationStatus === 'not_validated',
    'in-progress manifests must remain not_validated until acceptance gates are verified',
  );
}
expect(Boolean(manifest.completionRule), 'manifest must state completionRule');
expect(existsSync(manifest.primaryPrd), `missing ${manifest.primaryPrd}`);
expect(
  manifest.trackingIssue === 'https://github.com/LionSR/TeXRA/issues/3838',
  'trackingIssue must point to issue #3838',
);

const expectedIds = new Set([3833, 3834, 3835, 3836, 3837]);
const seenIds = new Set();

for (const issue of manifest.issues ?? []) {
  seenIds.add(issue.id);
  expect(expectedIds.has(issue.id), `unexpected issue id ${issue.id}`);
  expect(
    issue.url === `https://github.com/LionSR/TeXRA/issues/${issue.id}`,
    `issue ${issue.id} url is inconsistent`,
  );
  expect(existsSync(issue.prd), `missing issue ${issue.id} PRD ${issue.prd}`);
  expect(Boolean(issue.sourceOfTruth), `issue ${issue.id} lacks sourceOfTruth`);
  expect(
    Array.isArray(issue.acceptance) && issue.acceptance.length > 0,
    `issue ${issue.id} lacks acceptance gates`,
  );
  if (manifest.status === 'complete') {
    expect(
      String(issue.status ?? '').includes('closed'),
      `complete manifest issue ${issue.id} must record closed status`,
    );
  }
}

for (const id of expectedIds) {
  expect(seenIds.has(id), `missing issue id ${id}`);
}

expect(
  manifest.globalInvariants?.includes('One owner per fact.'),
  'manifest must include the one-owner invariant',
);
expect(
  Array.isArray(manifest.recommendedOrder) &&
    manifest.recommendedOrder.length > 0,
  'manifest must include recommendedOrder',
);
expect(
  Array.isArray(manifest.references) &&
    manifest.references.some((reference) => {
      return (
        reference.path ===
          'references/openrouter-skills/skills/create-agent-tui/' &&
        reference.allowedUse?.includes('styling and interaction reference') &&
        reference.forbiddenUse?.includes('do not copy')
      );
    }),
  'manifest must mark the OpenRouter TUI reference as reference-only',
);

if (manifest.status === 'complete') {
  for (const followUp of manifest.focusedFollowUps ?? []) {
    expect(
      String(followUp.status ?? '').includes('closed'),
      `complete manifest follow-up ${followUp.id} must record closed status`,
    );
  }
}

if (errors.length > 0) {
  console.error('CLI orchestration manifest check failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
