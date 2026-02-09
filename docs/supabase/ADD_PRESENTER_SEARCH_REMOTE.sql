-- Migration: Add presenter and search as remote tool-use agents,
-- and sync descriptions/tools for existing remote agents.
--
-- Prerequisites:
-- 1. Run the tools column migration first:
--    supabase/migrations/20260209_add_tools_to_remote_agents.sql
--
-- 2. Upload the YAML files to Supabase Storage:
--    - Copy from: resources/tool_use_agents/presenter.yaml
--    - Upload to: Storage > agent-configs > researcher/presenter.yaml
--
--    - Copy from: resources/tool_use_agents/search.yaml
--    - Upload to: Storage > agent-configs > researcher/search.yaml
--
-- Then run this SQL in Supabase SQL Editor:

-- =============================================================================
-- NEW AGENTS: presenter and search (tool-use)
-- =============================================================================

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'presenter',
  'Interactive scientific presentation builder with visual QA.',
  'researcher/presenter.yaml',
  ARRAY['researcher'],
  'toolUse',
  ARRAY['todo_write', 'bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'ls', 'extract_figures', 'extract_bib_entries', 'extract_tikz_figures', 'wolfram', 'arxiv_search', 'arxiv_metadata', 'web_search', 'web_fetch']
);

INSERT INTO remote_agents (name, description, storage_path, visibility, agent_category, tools)
VALUES (
  'search',
  'Research assistant with web search and literature discovery tools.',
  'researcher/search.yaml',
  ARRAY['researcher'],
  'toolUse',
  ARRAY['bash', 'read_file', 'glob', 'grep', 'ls', 'extract_figures', 'extract_bib_entries', 'extract_tikz_figures', 'arxiv_search', 'arxiv_metadata', 'download_arxiv_source', 'crossref_search', 'crossref_doi', 'zotero_add', 'zotero_search', 'zotero_export', 'web_search', 'web_fetch']
);

-- =============================================================================
-- SYNC: descriptions and agent_category for existing remote agents
-- =============================================================================

-- Fix transcribe_audio: sync trailing period from YAML, migrate agent_type → agent_category
UPDATE remote_agents
SET description = 'Transcribes audio with speaker identification and LaTeX math formatting.',
    agent_category = 'workflow'
WHERE name = 'transcribe_audio';

-- apply and apply_multiple: descriptions already match YAML, just ensure agent_category is set
UPDATE remote_agents
SET agent_category = 'workflow'
WHERE name IN ('apply', 'apply_multiple');

-- =============================================================================
-- BACKFILL: populate tools column for existing remote agents that have them
-- (apply and transcribe_audio are workflow agents with no tools column needed)
-- =============================================================================

-- No tools to backfill for existing agents (all workflow/CoT type).

-- =============================================================================
-- VERIFY
-- =============================================================================

SELECT name, description, agent_category, tools, visibility
FROM remote_agents
ORDER BY name;
