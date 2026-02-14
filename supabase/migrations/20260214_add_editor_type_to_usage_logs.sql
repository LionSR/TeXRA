-- Migration: Add editor_type column to usage_logs
--
-- Tracks which editor the extension is running in (e.g., "Visual Studio Code", "Cursor", "Windsurf").

ALTER TABLE public.usage_logs ADD COLUMN IF NOT EXISTS editor_type TEXT;

COMMENT ON COLUMN public.usage_logs.editor_type IS 'Editor application name (e.g., Visual Studio Code, Cursor)';
