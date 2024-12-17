import json
import logging
import os
import sqlite3
from datetime import datetime

from .agent_dataclass import AgentConfig, AgentSettings
from .agent_state import AgentGlobalState, AgentRoundState


HISTORY_DIR = "History"
logger = logging.getLogger(__name__)


def get_db_path() -> str:
    """Get path to SQLite database in current working directory."""
    if not os.path.exists(HISTORY_DIR):
        os.makedirs(HISTORY_DIR, exist_ok=True)
    return os.path.join(os.getcwd(), f"{HISTORY_DIR}/logs.db")


def init_db() -> None:
    """Initialize SQLite database with a single comprehensive table."""
    db_path = get_db_path()
    try:
        with sqlite3.connect(db_path) as conn:
            c = conn.cursor()
            c.execute(
                """CREATE TABLE IF NOT EXISTS coauthor_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME,
                agent TEXT,
                model TEXT,
                temperature FLOAT,
                input_file TEXT,
                input_files TEXT,
                auxiliary_file TEXT,
                auxiliary_files TEXT,
                figure_file TEXT,
                figure_files TEXT,
                reference_file TEXT,
                reference_files TEXT,
                edited_file TEXT,
                output_files TEXT,
                output_name_override TEXT,
                actual_output_files TEXT,
                output_file TEXT,
                instruction TEXT,
                tool_flags TEXT,  -- JSON object for all tool flags
                global_state TEXT,  -- JSON object for global metrics
                round_states TEXT   -- JSON array of round-specific metrics
            )"""
            )
            conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Database initialization failed: {e}")
        raise


def create_log_entry(agent_config: AgentConfig, agent_settings: AgentSettings) -> int:
    """Create a new log entry and return its ID."""
    init_db()
    try:
        with sqlite3.connect(get_db_path()) as conn:
            c = conn.cursor()

            input_files = json.dumps(agent_config.input_files) if agent_config.input_files else None
            auxiliary_files = json.dumps(agent_config.auxiliary_files) if agent_config.auxiliary_files else None
            figure_files = json.dumps(agent_config.figure_files) if agent_config.figure_files else None
            reference_files = json.dumps(agent_config.reference_files) if agent_config.reference_files else None
            output_files = json.dumps(agent_config.output_files) if agent_config.output_files else None
            actual_output_files = json.dumps([])

            tool_flags = json.dumps(
                {
                    "reflect": agent_config.reflect,
                    "auto_extract_figure": agent_config.auto_extract_figure,
                    "auto_extract_tikz_figure": agent_config.auto_extract_tikz_figure,
                    "auto_extract_tikz_figure_reflect": agent_config.auto_extract_tikz_figure_reflect,
                    "include_tex_count": agent_config.include_tex_count,
                    "use_prefill_from_input": agent_config.use_prefill_from_input,
                    "auto_confirmation": agent_config.auto_confirmation,
                }
            )

            global_state = json.dumps({})
            round_states = json.dumps({})

            c.execute(
                """INSERT INTO coauthor_logs (
                timestamp, agent, model, temperature,
                input_file, input_files, auxiliary_file, auxiliary_files,
                figure_file, figure_files, reference_file, reference_files,
                edited_file, output_files, output_name_override,
                actual_output_files, instruction,
                tool_flags, global_state, round_states
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    datetime.now(),
                    agent_config.agent,
                    agent_config.model,
                    agent_settings.temperature,
                    agent_config.input_file,
                    input_files,
                    agent_config.auxiliary_file,
                    auxiliary_files,
                    agent_config.figure_file,
                    figure_files,
                    agent_config.reference_file,
                    reference_files,
                    agent_config.edited_file,
                    output_files,
                    agent_config.output_name_override,
                    actual_output_files,
                    agent_config.instruction,
                    tool_flags,
                    global_state,
                    round_states,
                ),
            )

            log_id = c.lastrowid
            if log_id is None:
                raise RuntimeError("Failed to create log entry - no ID returned")

            conn.commit()
            return log_id
    except sqlite3.Error as e:
        logger.error(f"Failed to create log entry: {e}")
        raise


def update_log_statistics(log_id: int, global_state: AgentGlobalState, round_state: AgentRoundState, round: int) -> None:
    """Update statistics in the database for a specific log entry."""
    if log_id is None:
        logger.warning("No log ID provided, skipping statistics update")
        return

    try:
        with sqlite3.connect(get_db_path()) as conn:
            c = conn.cursor()

            # First, get existing round states
            c.execute("SELECT round_states FROM coauthor_logs WHERE id = ?", (log_id,))
            row = c.fetchone()
            if not row:
                logger.error(f"No log entry found for ID {log_id}")
                return

            existing_round_states = json.loads(row[0]) if row[0] else {}

            # Update the round states with the new state
            existing_round_states[str(round)] = round_state.to_dict()

            # Get the output file from the current round state
            output_file = round_state.output_file

            global_state_json = json.dumps(global_state.to_dict())
            round_states_json = json.dumps(existing_round_states)

            # Update the database
            c.execute(
                """UPDATE coauthor_logs SET
                global_state = ?,
                round_states = ?,
                output_file = ?
                WHERE id = ?""",
                (global_state_json, round_states_json, output_file, log_id),
            )

            conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Failed to update log statistics: {e}")
        raise


def update_log_output_files(log_id: int, output_file: str, all_output_files: list[str] | None = None) -> None:
    """Update output files for a specific log entry."""
    if log_id is None:
        logger.warning("No log ID provided, skipping output files update")
        return

    try:
        with sqlite3.connect(get_db_path()) as conn:
            c = conn.cursor()

            c.execute("SELECT actual_output_files FROM coauthor_logs WHERE id = ?", (log_id,))
            row = c.fetchone()
            if not row:
                logger.error(f"No log entry found for ID {log_id}")
                return

            actual_files = json.loads(row[0]) if row[0] else []

            if all_output_files:
                for file in all_output_files:
                    if file not in actual_files:
                        actual_files.append(file)
            elif output_file and output_file not in actual_files:
                actual_files.append(output_file)

            actual_files_json = json.dumps(actual_files)
            c.execute(
                """UPDATE coauthor_logs SET
                output_file = ?,
                actual_output_files = ?
                WHERE id = ?""",
                (output_file, actual_files_json, log_id),
            )

            conn.commit()
    except sqlite3.Error as e:
        logger.error(f"Failed to update output files: {e}")
        raise


def get_log_entry(log_id: int) -> dict[str, str | int | float | list[str] | dict]:
    """Retrieve complete log entry information for a specific ID."""
    try:
        with sqlite3.connect(get_db_path()) as conn:
            c = conn.cursor()
            c.execute("SELECT * FROM coauthor_logs WHERE id = ?", (log_id,))
            row = c.fetchone()
            if not row:
                raise ValueError(f"No log entry found for ID {log_id}")

            columns = [
                "id",
                "timestamp",
                "agent",
                "model",
                "temperature",
                "input_file",
                "input_files",
                "auxiliary_file",
                "auxiliary_files",
                "figure_file",
                "figure_files",
                "reference_file",
                "reference_files",
                "edited_file",
                "output_files",
                "output_name_override",
                "actual_output_files",
                "output_file",
                "instruction",
                "tool_flags",
                "global_state",
                "round_states",
            ]

            entry = {columns[i]: row[i] for i in range(len(columns))}

            json_fields = [
                "input_files",
                "auxiliary_files",
                "figure_files",
                "reference_files",
                "output_files",
                "actual_output_files",
                "tool_flags",
                "global_state",
                "round_states",
            ]

            for field in json_fields:
                if entry[field]:
                    entry[field] = json.loads(entry[field])

            return entry
    except sqlite3.Error as e:
        logger.error(f"Failed to retrieve log entry: {e}")
        raise
