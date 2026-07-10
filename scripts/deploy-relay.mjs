#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const DEFAULT_PROJECT_REF = 'jntubmcgbhwtcktubelv';
const projectRef = process.env.SUPABASE_PROJECT_REF ?? DEFAULT_PROJECT_REF;

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
