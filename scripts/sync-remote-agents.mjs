#!/usr/bin/env node
/**
 * Sync prompts/agents/remote YAML metadata to docs/supabase/SYNC_REMOTE_AGENTS.sql.
 *
 * Usage:
 *   node scripts/sync-remote-agents.mjs
 *   node scripts/sync-remote-agents.mjs -o docs/supabase/SYNC_REMOTE_AGENTS.sql
 *   node scripts/sync-remote-agents.mjs --check
 *   node scripts/sync-remote-agents.mjs --check path/to/other.sql
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const remoteAgentsDir = resolve(rootDir, 'prompts/agents/remote');
// Keep these docs-side paths synchronized with the remote_agent_docs detector
// in .github/workflows/ci.yml so docs-only changes still run this drift check.
const configPath = resolve(rootDir, 'docs/supabase/remote-agents.config.json');
const defaultOutputPath = 'docs/supabase/SYNC_REMOTE_AGENTS.sql';

// Placement and visibility for each agent in prompts/agents/remote/. The YAML files
// are the source of truth for description / tools / agentCategory; folder and
// visibility live in docs/supabase/remote-agents.config.json so the generated
// SQL stays aligned with production without editing every YAML.
const { agents: AGENT_PLACEMENT, retired: RETIRED_AGENT_NAMES } =
  loadPlacementConfig();

function loadPlacementConfig() {
  const raw = JSON.parse(readFileSync(configPath, 'utf8'));
  return {
    agents: raw.agents ?? {},
    retired: Array.isArray(raw.retired) ? raw.retired : [],
  };
}

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
  const explicitCategory =
    settings.agentCategory ?? parsed.agentCategory ?? undefined;

  return {
    name,
    description: parsed.description,
    inherits: parsed.inherits,
    agentCategory: explicitCategory ?? 'workflow',
    explicitCategory: explicitCategory !== undefined,
    tools: normalizeTools(settings.tools),
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

function placementFor(agent) {
  const placement = AGENT_PLACEMENT[agent.name];
  if (!placement) {
    throw new Error(
      `Agent "${agent.name}" has no placement entry in ${relative(rootDir, configPath)}. ` +
        `Add { "folder": "...", "visibility": [...] } for it.`,
    );
  }
  if (typeof placement.folder !== 'string' || !placement.folder) {
    throw new Error(
      `Agent "${agent.name}" placement is missing a "folder" string.`,
    );
  }
  if (
    !Array.isArray(placement.visibility) ||
    placement.visibility.length === 0
  ) {
    throw new Error(
      `Agent "${agent.name}" placement is missing a non-empty "visibility" array.`,
    );
  }
  return placement;
}

function storagePath(agent, placement) {
  return `${placement.folder}/${agent.name}.yaml`;
}

function resolveInheritedFields(agents) {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));

  function walkParents(agent, visit, seen = new Set()) {
    if (seen.has(agent.name)) {
      return;
    }
    seen.add(agent.name);

    visit(agent);

    if (!agent.inherits) {
      return;
    }
    const parent = byName.get(agent.inherits);
    if (parent) {
      walkParents(parent, visit, seen);
    }
  }

  for (const agent of agents) {
    walkParents(agent, (current) => {
      if (!agent.description && current.description) {
        agent.description = current.description;
      }
      if (!agent.tools && current.tools) {
        agent.tools = current.tools;
      }
      if (!agent.explicitCategory && current.explicitCategory) {
        agent.agentCategory = current.agentCategory;
        agent.explicitCategory = true;
      }
    });
  }
}

function loadAgents() {
  if (!existsSync(remoteAgentsDir)) {
    throw new Error(`Missing remote agents directory: ${remoteAgentsDir}`);
  }

  const agents = discoverYamlFiles(remoteAgentsDir).map(readAgentYaml);
  resolveInheritedFields(agents);

  return agents
    .map((agent) => {
      const placement = placementFor(agent);
      return {
        ...agent,
        storagePath: storagePath(agent, placement),
        visibility: placement.visibility,
        folder: placement.folder,
      };
    })
    .sort(compareAgents);
}

function compareAgents(a, b) {
  const byGroup = groupOrder(a) - groupOrder(b);
  if (byGroup !== 0) {
    return byGroup;
  }
  return a.name.localeCompare(b.name);
}

function groupKey(agent) {
  if (agent.agentCategory !== 'toolUse') {
    return 'workflow';
  }
  return agent.folder;
}

function groupOrder(agent) {
  const key = groupKey(agent);
  if (key === 'workflow') return 0;
  if (key === 'tool-use') return 1;
  return 2;
}

function groupSectionTitle(key) {
  if (key === 'workflow') return 'Workflow agents';
  if (key === 'tool-use') return 'Tool-use agents';
  if (key === 'tool-use-lean') return 'Tool-use agents (Lean)';
  return `Tool-use agents (${key})`;
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
    '-- Source of truth: prompts/agents/remote/**/*.yaml.',
    '-- Run `npm run sync:remote-agents` to refresh this file.',
    '',
    'ALTER TABLE remote_agents',
    'ADD COLUMN IF NOT EXISTS tools TEXT[] DEFAULT NULL;',
    '',
  ];

  const groups = new Map();
  for (const agent of agents) {
    const key = groupKey(agent);
    const items = groups.get(key) ?? [];
    items.push(agent);
    groups.set(key, items);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === 'workflow') return -1;
    if (b === 'workflow') return 1;
    if (a === 'tool-use') return -1;
    if (b === 'tool-use') return 1;
    return a.localeCompare(b);
  });

  for (const key of sortedKeys) {
    lines.push(
      '-- ---------------------------------------------------------------------------',
    );
    lines.push(`-- ${groupSectionTitle(key)}`);
    lines.push(
      '-- ---------------------------------------------------------------------------',
    );
    lines.push('');

    for (const agent of groups.get(key)) {
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

const { values: flags, positionals } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    output: { type: 'string', short: 'o' },
  },
  allowPositionals: true,
});

const sql = buildSql(loadAgents());

if (flags.check) {
  const target = positionals[0] ?? defaultOutputPath;
  checkOutput(resolve(rootDir, target), sql);
} else if (flags.output) {
  const outputPath = resolve(rootDir, flags.output);
  writeFileSync(outputPath, sql);
  console.log(`Wrote ${relative(rootDir, outputPath)}`);
} else {
  process.stdout.write(sql);
}
