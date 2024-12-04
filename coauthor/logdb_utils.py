import os
import sqlite3
import json

from datetime import datetime
from typing import Optional, List

from .config import TaskConfig, AgentSettings
from .logging_utils import logger
from .model_config import ModelConfig
from .state import State

HISTORY_DIR = "History"


def get_db_path() -> str:
    """Get path to SQLite database in current working directory"""
    if not os.path.exists(HISTORY_DIR):
        os.makedirs(HISTORY_DIR, exist_ok=True)
    return os.path.join(os.getcwd(), f"{HISTORY_DIR}/logs.db")


def init_db() -> None:
    """Initialize SQLite database with a single comprehensive table"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Update table schema to match all possible fields from TaskConfig and agent settings
    c.execute(
        """CREATE TABLE IF NOT EXISTS coauthor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME,
        agent TEXT,
        model TEXT,
        temperature FLOAT,  -- Added to match TaskConfig
        input_file TEXT,
        input_files TEXT,  -- JSON array of additional input files
        auxiliary_file TEXT,  -- Added to match TaskConfig
        auxiliary_files TEXT,  -- JSON array of auxiliary files
        figure_file TEXT,  -- Added to match TaskConfig
        figure_files TEXT,  -- JSON array of figure files
        reference_file TEXT,  -- Added to match TaskConfig
        reference_files TEXT,  -- JSON array of reference files
        edited_file TEXT,  -- Added to match TaskConfig
        output_files TEXT,  -- JSON array of target output files
        output_name_override TEXT,  -- Added to match TaskConfig
        actual_output_files TEXT,  -- JSON array of actual output files
        output_file TEXT,  -- Main output file
        is_reflection BOOLEAN,
        instruction TEXT,
        reflect BOOLEAN,
        auto_extract_figure BOOLEAN,
        auto_extract_tikz_figure BOOLEAN,
        auto_extract_tikz_figure_reflect BOOLEAN,
        include_tex_count BOOLEAN,
        use_prefill_from_input BOOLEAN,
        round_stats TEXT  -- JSON array of stats per round
    )"""
    )

    conn.commit()
    conn.close()


def logdb_start(task_config: TaskConfig, agent_settings: AgentSettings) -> int:
    """Initialize a new log entry and return its ID"""
    init_db()
    conn = sqlite3.connect(get_db_path())
    c = conn.cursor()

    # Convert lists to JSON strings for storage
    input_files = json.dumps(task_config.input_files) if task_config.input_files else None
    auxiliary_files = json.dumps(task_config.auxiliary_files) if task_config.auxiliary_files else None
    figure_files = json.dumps(task_config.figure_files) if task_config.figure_files else None
    reference_files = json.dumps(task_config.reference_files) if task_config.reference_files else None
    output_files = json.dumps(task_config.output_files) if task_config.output_files else None
    actual_output_files = json.dumps([])  # Initialize as empty

    # Initialize empty array for round stats
    round_stats = json.dumps([])

    c.execute(
        """INSERT INTO coauthor_logs (
        timestamp, agent, model, temperature,
        input_file, input_files, auxiliary_file, auxiliary_files,
        figure_file, figure_files, reference_file, reference_files,
        edited_file, output_files, output_name_override,
        actual_output_files, is_reflection, instruction, round_stats,
        reflect, auto_extract_figure, auto_extract_tikz_figure,
        auto_extract_tikz_figure_reflect, include_tex_count,
        use_prefill_from_input
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            datetime.now(),
            task_config.agent,
            task_config.model,
            agent_settings.temperature,
            task_config.input_file,
            input_files,
            task_config.auxiliary_file,
            auxiliary_files,
            task_config.figure_file,
            figure_files,
            task_config.reference_file,
            reference_files,
            task_config.edited_file,
            output_files,
            task_config.output_name_override,
            actual_output_files,
            False,  # is_reflection
            task_config.instruction,
            round_stats,
            task_config.reflect,
            task_config.auto_extract_figure,
            task_config.auto_extract_tikz_figure,
            task_config.auto_extract_tikz_figure_reflect,
            task_config.include_tex_count,
            task_config.use_prefill_from_input,
        ),
    )

    log_id = c.lastrowid
    conn.commit()
    conn.close()

    return log_id


def logdb_and_print_statistics(state: State, model_config: ModelConfig, log_id: Optional[int] = None) -> None:
    """Log statistics to SQLite and print them to console"""
    total_input_tokens = state.total_input_tokens
    total_output_tokens = state.total_output_tokens
    total_response_time = state.total_response_time

    # Print statistics to console
    logger.info(f"Total input tokens  : {total_input_tokens}")
    logger.info(f"Total output tokens : {total_output_tokens}")

    # Calculate caching statistics
    cache_read_tokens = state.total_cache_read_input_tokens
    cache_creation_tokens = state.total_cache_creation_input_tokens
    percentage_cached = 0

    if model_config.supports_prompt_caching:
        logger.info(f"Total input tokens (cache read): {cache_read_tokens}")
        logger.info(f"Total input tokens (cache create): {cache_creation_tokens}")

        total_input_tokens_all = cache_creation_tokens + cache_read_tokens
        percentage_cached = (cache_read_tokens / total_input_tokens_all * 100) if total_input_tokens_all > 0 else 0
        logger.info(f"Percentage cached: {percentage_cached}%")
        cost = model_config.compute_price(total_input_tokens, total_output_tokens, cache_creation_tokens, cache_read_tokens)
    elif model_config.supports_reasoning:
        logger.info(f"Total reasoning tokens: {state.total_reasoning_tokens}")
        cost = model_config.compute_price(total_input_tokens, total_output_tokens, reasoning_tokens=state.total_reasoning_tokens)
    else:
        cost = model_config.compute_price(total_input_tokens, total_output_tokens)

    logger.info(f"Total response time : {total_response_time} seconds")
    logger.warning(f"Total cost          : ${cost:.2f}")

    # Update statistics in database if we have a log ID
    if log_id is not None:
        conn = sqlite3.connect(get_db_path())
        c = conn.cursor()

        # Get current round from is_reflection
        c.execute("SELECT is_reflection, round_stats FROM coauthor_logs WHERE id = ?", (log_id,))
        row = c.fetchone()
        current_round = 1 if row[0] else 0
        round_stats = json.loads(row[1]) if row[1] else []

        # Create stats for current round
        round_stat = {
            "round": current_round,
            "input_tokens": total_input_tokens,
            "output_tokens": total_output_tokens,
            "response_time": total_response_time,
            "cost": cost,
            "cache_read_tokens": cache_read_tokens,
            "cache_creation_tokens": cache_creation_tokens,
            "percentage_cached": percentage_cached,
        }

        # Update or append round stats
        if current_round < len(round_stats):
            round_stats[current_round] = round_stat
        else:
            round_stats.append(round_stat)

        # Update the database
        c.execute(
            """UPDATE coauthor_logs SET
            round_stats = ?
            WHERE id = ?""",
            (json.dumps(round_stats), log_id),
        )

        conn.commit()
        conn.close()


def logdb_output_files(output_file: str, log_id: int, all_output_files: Optional[List[str]] = None) -> None:
    """
    Args:
        output_file: The current output file
        log_id: The log entry ID
        all_output_files: List of all output files for this round (optional)
    """
    if log_id is None:
        return

    import re

    round_match = re.search(r"_r(\d+)_", output_file)
    is_reflection = bool(round_match and int(round_match.group(1)) > 0)

    conn = sqlite3.connect(get_db_path())
    c = conn.cursor()

    # Get existing output files
    c.execute("SELECT actual_output_files FROM coauthor_logs WHERE id = ?", (log_id,))
    row = c.fetchone()
    actual_files = json.loads(row[0]) if row and row[0] else []

    # Add new output files if not already present
    if all_output_files:
        for file in all_output_files:
            if file not in actual_files:
                actual_files.append(file)
    elif output_file not in actual_files:  # Backward compatibility
        actual_files.append(output_file)

    # Update the database
    c.execute(
        """UPDATE coauthor_logs SET
        output_file = ?,
        actual_output_files = ?,
        is_reflection = ?
        WHERE id = ?""",
        (output_file, json.dumps(actual_files), is_reflection, log_id),
    )

    conn.commit()
    conn.close()


def get_task_info_from_db(log_id: int):
    """Retrieve task information for VS Code frontend"""
    conn = sqlite3.connect(get_db_path())
    c = conn.cursor()

    c.execute(
        """SELECT 
        timestamp, agent, model, temperature,
        input_file, output_file, instruction, round_stats,
        reflect, auto_extract_figure, auto_extract_tikz_figure,
        auto_extract_tikz_figure_reflect, include_tex_count,
        use_prefill_from_input,
        input_files, auxiliary_file, auxiliary_files,
        figure_file, figure_files, reference_file, reference_files,
        edited_file, output_files, output_name_override,
        actual_output_files
        FROM coauthor_logs WHERE id = ?""",
        (log_id,),
    )

    row = c.fetchone()
    if row:
        round_stats = json.loads(row[7])
        latest_stats = round_stats[-1] if round_stats else {}

        info = {
            "timestamp": row[0],
            "agent": row[1],
            "model": row[2],
            "temperature": row[3],
            "input_file": row[4],
            "output_file": row[5],
            "instruction": row[6],
            "total_input_tokens": latest_stats.get("input_tokens", 0),
            "total_output_tokens": latest_stats.get("output_tokens", 0),
            "total_response_time": latest_stats.get("response_time", 0),
            "total_cost": latest_stats.get("cost", 0),
            "percentage_cached": latest_stats.get("percentage_cached", 0),
            "round_stats": round_stats,
            "flags": {
                "reflect": row[8],
                "auto_extract_figure": row[9],
                "auto_extract_tikz_figure": row[10],
                "auto_extract_tikz_figure_reflect": row[11],
                "include_tex_count": row[12],
                "use_prefill_from_input": row[13],
            },
            "files": {
                "input_files": json.loads(row[14]) if row[14] else [],
                "auxiliary_file": row[15],
                "auxiliary_files": json.loads(row[16]) if row[16] else [],
                "figure_file": row[17],
                "figure_files": json.loads(row[18]) if row[18] else [],
                "reference_file": row[19],
                "reference_files": json.loads(row[20]) if row[20] else [],
                "edited_file": row[21],
                "output_files": json.loads(row[22]) if row[22] else [],
                "output_name_override": row[23],
                "actual_output_files": json.loads(row[24]) if row[24] else [],
            },
        }
        conn.close()
        return info

    conn.close()
    return None
