#!/usr/bin/env node
/**
 * Generate (default) or apply (`npm run sync:remote-agents -- --apply`) the
 * remote-agents catalog SQL. Not committed. See
 * docs/supabase/SUPABASE_SETUP.md ("Updating the hosted catalog").
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import YAML from 'yaml';

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Tests point TEXRA_REMOTE_AGENTS_ROOT at a fixture checkout so --apply never
// touches a real working tree.
const rootDir = resolve(
  process.env.TEXRA_REMOTE_AGENTS_ROOT ?? join(scriptDir, '..'),
);
const remoteAgentsDir = resolve(rootDir, 'prompts/agents/remote');
const configPath = resolve(rootDir, 'docs/supabase/remote-agents.config.json');

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
      `Agent "${agent.name}" has no placement entry in docs/supabase/remote-agents.config.json. ` +
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
    '-- Generated by scripts/sync-remote-agents.mjs. Do not commit.',
    '-- Source of truth: prompts/agents/remote/**/*.yaml and',
    '-- docs/supabase/remote-agents.config.json.',
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

function generateRemoteAgentsSql() {
  return buildSql(loadAgents());
}

// Metadata rows are broken until the prompt body they point at exists in the
// agent-configs bucket, so --apply refuses to publish while any storage_path
// is missing (#10317). The check runs as SQL over the same connection as the
// apply itself; the RAISE makes the CLI exit non-zero.
// Distinctive text in the preflight RAISE when catalog storage paths are
// missing. The apply error path matches this marker so it can tell missing
// objects apart from every other preflight failure (#10332).
const STORAGE_PREFLIGHT_MISSING_MARKER =
  'catalog storage path(s) missing from the agent-configs bucket';

function buildStoragePreflightSql(agents) {
  const values = agents
    .map((agent) => `    (${sqlString(agent.storagePath)})`)
    .join(',\n');

  return [
    '-- Generated by scripts/sync-remote-agents.mjs. Do not commit.',
    '-- Preflight: fail if a catalog storage_path has no object in the',
    '-- agent-configs bucket, so metadata is never published ahead of the',
    '-- prompt body it points at.',
    'DO $$',
    'DECLARE',
    '  missing TEXT[];',
    'BEGIN',
    '  SELECT array_agg(expected.path ORDER BY expected.path) INTO missing',
    '  FROM (VALUES',
    values,
    '  ) AS expected(path)',
    '  WHERE NOT EXISTS (',
    '    SELECT 1',
    '    FROM storage.objects AS obj',
    "    WHERE obj.bucket_id = 'agent-configs'",
    '      AND obj.name = expected.path',
    '  );',
    '',
    '  IF missing IS NOT NULL THEN',
    `    RAISE EXCEPTION 'sync-remote-agents: % ${STORAGE_PREFLIGHT_MISSING_MARKER}: %. Upload the YAML prompt bodies first (docs/supabase/SUPABASE_SETUP.md, Part 7).',`,
    "      array_length(missing, 1), array_to_string(missing, ', ');",
    '  END IF;',
    'END;',
    '$$;',
    '',
  ].join('\n');
}

function runSupabaseQuery(args, options = {}) {
  const { captureOutput = false, env = {} } = options;
  const result = spawnSync('supabase', args, {
    stdio: captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    cwd: rootDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });

  const output = captureOutput
    ? `${result.stdout ?? ''}${result.stderr ?? ''}`
    : '';

  if (captureOutput) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error(
        'sync-remote-agents: supabase CLI not found on PATH. Install it and retry.',
      );
    } else {
      console.error(
        'sync-remote-agents: failed to spawn supabase CLI:',
        result.error,
      );
    }
    return { status: 1, output };
  }
  if (result.signal) {
    console.error(
      `sync-remote-agents: supabase CLI was killed by signal ${result.signal}`,
    );
    return { status: 1, output };
  }
  return { status: result.status ?? 1, output };
}

function applyRemoteAgentsSql() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  // Normalize once here and reject a set-but-blank ref before it can reach the
  // CLI as an empty SUPABASE_PROJECT_ID (#10452).
  const projectRef = process.env.SUPABASE_PROJECT_REF?.trim();
  const projectRefFile = resolve(rootDir, 'supabase/.temp/project-ref');
  const args = ['--yes', 'db', 'query', '-o', 'table'];
  const queryEnv = {};

  if (dbUrl) {
    args.push('--db-url', dbUrl);
  } else {
    if (process.env.SUPABASE_PROJECT_REF !== undefined && !projectRef) {
      console.error(
        'sync-remote-agents: SUPABASE_PROJECT_REF is set but empty after trimming. ' +
          'Set a non-empty SUPABASE_PROJECT_REF, set SUPABASE_DB_URL, or unset ' +
          "SUPABASE_PROJECT_REF to use this checkout's linked project.",
      );
      return 1;
    }
    if (projectRef) {
      // `supabase db query --linked` reads its target from
      // supabase/.temp/project-ref unless SUPABASE_PROJECT_ID is set. Pass the
      // requested ref through that env var instead of rewriting the checkout's
      // link file, so there is nothing to restore even if the process is
      // killed mid-query (#10316, #10329). The CLI trims the link file but
      // validates the env var as-is, so padding was normalized above (#10408).
      queryEnv.SUPABASE_PROJECT_ID = projectRef;
    } else if (!existsSync(projectRefFile)) {
      console.error(
        'sync-remote-agents: set SUPABASE_DB_URL or SUPABASE_PROJECT_REF, ' +
          'or run `supabase link` in this checkout.',
      );
      return 1;
    } else {
      // Falling back to the checkout's link file: the CLI ranks
      // SUPABASE_PROJECT_ID above supabase/.temp/project-ref, so scrub any
      // ambient value from the inherited env to keep the link file
      // authoritative (#10407). spawnSync drops env keys set to undefined.
      queryEnv.SUPABASE_PROJECT_ID = undefined;
    }
    args.push('--linked');
  }

  const sqlDir = mkdtempSync(join(tmpdir(), 'texra-remote-agents-'));
  try {
    const agents = loadAgents();

    if (agents.length > 0) {
      const preflightPath = join(sqlDir, 'remote-agents-preflight.sql');
      writeFileSync(preflightPath, buildStoragePreflightSql(agents));
      const preflight = runSupabaseQuery([...args, '-f', preflightPath], {
        captureOutput: true,
        env: queryEnv,
      });
      if (preflight.status !== 0) {
        // The marker text is embedded verbatim in the generated SQL (it is
        // the RAISE string literal), so a bare substring match over the
        // combined output could fire on an echoed query instead of the
        // raised exception. Only classify when the marker appears on a line
        // that also carries the Postgres ERROR: severity prefix, which is
        // how both the pgx path and the Management API report the RAISE
        // (#10409).
        const raisedMissingStorage = preflight.output
          .split('\n')
          .some(
            (line) =>
              line.includes('ERROR:') &&
              line.includes(STORAGE_PREFLIGHT_MISSING_MARKER),
          );
        if (raisedMissingStorage) {
          console.error(
            'sync-remote-agents: Storage preflight failed; catalog metadata was NOT applied. ' +
              'Upload the missing YAML prompt bodies to the agent-configs bucket ' +
              'first (docs/supabase/SUPABASE_SETUP.md, Part 7).',
          );
        } else {
          console.error(
            'sync-remote-agents: Storage preflight failed; catalog metadata was NOT applied. ' +
              'The error above describes the failure.',
          );
        }
        return preflight.status;
      }
    }

    const sqlPath = join(sqlDir, 'remote-agents.sql');
    writeFileSync(sqlPath, buildSql(agents));
    return runSupabaseQuery([...args, '-f', sqlPath], { env: queryEnv }).status;
  } finally {
    rmSync(sqlDir, { recursive: true, force: true });
  }
}

const { values: flags } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
  },
});

if (flags.apply) {
  process.exit(applyRemoteAgentsSql());
} else {
  process.stdout.write(generateRemoteAgentsSql());
}
