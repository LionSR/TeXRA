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
process.exit(result.status ?? 1);
