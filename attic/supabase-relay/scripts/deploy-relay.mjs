#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const projectRef = process.env.SUPABASE_PROJECT_REF;
if (!projectRef) {
  console.error(
    'deploy-relay: SUPABASE_PROJECT_REF is not set. Export it with the target Supabase project ref before deploying.',
  );
  process.exit(1);
}

const args = [
  'functions',
  'deploy',
  'relay',
  '--no-verify-jwt',
  '--project-ref',
  projectRef,
];

const result = spawnSync('supabase', args, { stdio: 'inherit' });
if (result.error) {
  if (result.error.code === 'ENOENT') {
    console.error(
      'deploy-relay: supabase CLI not found on PATH. Install it and retry.',
    );
  } else {
    console.error('deploy-relay: failed to spawn supabase CLI:', result.error);
  }
  process.exit(1);
}
if (result.signal) {
  console.error(
    `deploy-relay: supabase CLI was killed by signal ${result.signal}`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
