#!/usr/bin/env node
/**
 * Sync reference-agents YAML metadata to docs/supabase/SYNC_REFERENCE_AGENTS.sql.
 *
 * Usage:
 *   node scripts/sync-remote-agents.mjs
 *   node scripts/sync-remote-agents.mjs -o docs/supabase/SYNC_REFERENCE_AGENTS.sql
 *   node scripts/sync-remote-agents.mjs --check docs/supabase/SYNC_REFERENCE_AGENTS.sql
 *   node scripts/sync-remote-agents.mjs --exec
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const referenceAgentsDir = resolve(rootDir, 'reference-agents');

// Keep destructive cleanup explicit. The remote_agents table can contain agents
// that are not managed by reference-agents/.
const RETIRED_AGENT_NAMES = ['lean'];

function discoverYamlFiles(dir) {
  const files = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...discoverYamlFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
      files.push(path);
    }
  }

  return files;
}

function readAgentYaml(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const parsed = YAML.parse(text) ?? {};
  const settings = parsed.settings ?? {};
  const name = parsed.name ?? basename(filePath, '.yaml');
  const agentCategory =
    settings.agentCategory ?? parsed.agentCategory ?? 'workflow';
  const relativePath = relative(referenceAgentsDir, filePath);
  const relativeParts = relativePath.split(/[\\/]/);
  const subdir = relativeParts.length > 1 ? relativeParts.at(0) : '';

  return {
    name,
    description: parsed.description,
    inherits: parsed.inherits,
    agentCategory,
    tools: normalizeTools(settings.tools),
    subdir,
  };
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const names = tools
    .map((tool) => {
      if (typeof tool === 'string') {
        return tool;
      }
      if (tool && typeof tool === 'object' && typeof tool.name === 'string') {
        return tool.name;
      }
      return undefined;
    })
    .filter(Boolean);

  return names.length > 0 ? names : undefined;
}

function storagePath(agent) {
  if (agent.subdir === 'Lean4') {
    return `tool-use-lean/${agent.name}.yaml`;
  }
  if (agent.agentCategory === 'toolUse') {
    return `tool_use/${agent.name}.yaml`;
  }
  return `workflow/${agent.name}.yaml`;
}

function visibility(agent) {
  if (agent.subdir === 'Lean4') {
    return ['researcher', 'lean'];
  }
  return ['researcher'];
}

function resolveInheritedFields(agents) {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));

  function resolveDescription(agent, seen = new Set()) {
    if (agent.description || !agent.inherits || seen.has(agent.name)) {
      return agent.description;
    }

    seen.add(agent.name);
    const parent = byName.get(agent.inherits);
    if (!parent) {
      return agent.description;
    }

    agent.description = resolveDescription(parent, seen);
    return agent.description;
  }

  for (const agent of agents) {
    resolveDescription(agent);
  }
}

function loadAgents() {
  if (!existsSync(referenceAgentsDir)) {
    throw new Error(
      `Missing reference agents directory: ${referenceAgentsDir}`,
    );
  }

  const agents = discoverYamlFiles(referenceAgentsDir).map(readAgentYaml);
  resolveInheritedFields(agents);

  return agents
    .map((agent) => ({
      ...agent,
      storagePath: storagePath(agent),
      visibility: visibility(agent),
    }))
    .sort(compareAgents);
}

function compareAgents(a, b) {
  const byGroup = agentGroup(a) - agentGroup(b);
  if (byGroup !== 0) {
    return byGroup;
  }
  return a.name.localeCompare(b.name);
}

function agentGroup(agent) {
  if (agent.agentCategory !== 'toolUse') {
    return 0;
  }
  return agent.subdir === 'Lean4' ? 2 : 1;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  return `ARRAY[${values.map(sqlString).join(', ')}]`;
}

function toolsValue(agent) {
  return agent.tools ? sqlArray(agent.tools) : 'NULL';
}

function sectionTitle(group) {
  switch (group) {
    case 0:
      return 'Workflow agents';
    case 1:
      return 'Tool-use agents';
    case 2:
      return 'Tool-use agents (Lean)';
    default:
      return 'Agents';
  }
}

function buildInsert(agent) {
  return [
    'INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)',
    'VALUES (',
    `  ${sqlString(agent.name)},`,
    `  ${sqlString(agent.description ?? '')},`,
    `  ${sqlString(agent.storagePath)},`,
    `  ${sqlArray(agent.visibility)},`,
    `  ${sqlString(agent.agentCategory)},`,
    `  ${toolsValue(agent)}`,
    ')',
    'ON CONFLICT (name) DO UPDATE SET',
    '  description    = EXCLUDED.description,',
    '  storage_path   = EXCLUDED.storage_path,',
    '  visibility     = EXCLUDED.visibility,',
    '  agent_category = EXCLUDED.agent_category,',
    '  tools          = EXCLUDED.tools;',
  ].join('\n');
}

function buildSql(agents) {
  const lines = [
    '-- Auto-generated by scripts/sync-remote-agents.mjs.',
    '-- Source of truth: reference-agents/**/*.yaml.',
    '-- Run `npm run sync:remote-agents` to refresh this file.',
    '',
    'ALTER TABLE remote_agents',
    'ADD COLUMN IF NOT EXISTS tools TEXT[] DEFAULT NULL;',
    '',
  ];

  const groups = new Map();
  for (const agent of agents) {
    const group = agentGroup(agent);
    const items = groups.get(group) ?? [];
    items.push(agent);
    groups.set(group, items);
  }

  for (const group of [...groups.keys()].sort()) {
    lines.push(
      '-- ---------------------------------------------------------------------------',
    );
    lines.push(`-- ${sectionTitle(group)}`);
    lines.push(
      '-- ---------------------------------------------------------------------------',
    );
    lines.push('');

    for (const agent of groups.get(group)) {
      lines.push(buildInsert(agent));
      lines.push('');
    }
  }

  if (RETIRED_AGENT_NAMES.length > 0) {
    lines.push(
      '-- ---------------------------------------------------------------------------',
    );
    lines.push('-- Cleanup stale entries (renamed/removed agents)');
    lines.push(
      '-- ---------------------------------------------------------------------------',
    );
    lines.push('');
    lines.push(
      `DELETE FROM remote_agents WHERE name IN (${RETIRED_AGENT_NAMES.map(sqlString).join(', ')});`,
    );
    lines.push('');
  }

  lines.push('-- Verify');
  lines.push('SELECT name, description, agent_category, tools, visibility');
  lines.push('FROM remote_agents');
  lines.push('ORDER BY agent_category, name;');

  return `${lines.join('\n')}\n`;
}

function checkOutput(path, sql) {
  const existing = readFileSync(path, 'utf8');
  if (existing !== sql) {
    console.error(`${path} is out of date. Run npm run sync:remote-agents.`);
    process.exit(1);
  }
  console.log(`${path} is up to date.`);
}

const { values: flags } = parseArgs({
  options: {
    check: { type: 'string' },
    exec: { type: 'boolean', default: false },
    output: { type: 'string', short: 'o' },
  },
});

const sql = buildSql(loadAgents());

if (flags.check) {
  checkOutput(resolve(rootDir, flags.check), sql);
} else if (flags.output) {
  const outputPath = resolve(rootDir, flags.output);
  writeFileSync(outputPath, sql);
  console.log(`Wrote ${relative(rootDir, outputPath)}`);
} else if (flags.exec) {
  execFileSync('supabase', ['db', 'execute', '--stdin'], {
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
} else {
  process.stdout.write(sql);
}
