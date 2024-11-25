import os
import sqlite3
import json
from datetime import datetime
from typing import Optional, List

from .state import State
from .logging_utils import logger
from .model_config import ModelConfig
from .config import TaskConfig


def get_db_path() -> str:
    """Get path to SQLite database in current working directory"""
    if not os.path.exists("Versions"):
        os.makedirs("Versions", exist_ok=True)
    return os.path.join(os.getcwd(), "Versions/logs.db")


def init_db() -> None:
    """Initialize SQLite database with a single comprehensive table"""
    db_path = get_db_path()
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    # Single table containing all necessary information
    c.execute(
        """CREATE TABLE IF NOT EXISTS coauthor_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME,
        agent TEXT,
        model TEXT,
        input_file TEXT,
        input_files TEXT,  -- JSON array of additional input files
        auxiliary_files TEXT,  -- JSON array of auxiliary files
        figure_inputs TEXT,  -- JSON array of figure inputs
        reference_files TEXT,  -- JSON array of sample files
        output_files TEXT,  -- JSON array of target output files from task_config
        actual_output_files TEXT,  -- JSON array of actual output files from agent
        output_file TEXT,  -- Main output file
        is_reflection BOOLEAN,
        instruction TEXT,
        reflect BOOLEAN,  -- From args.reflect
        auto_extract_figure BOOLEAN,  -- Flag
        auto_extract_tikz_figure BOOLEAN,  -- Flag
        auto_extract_tikz_figure_reflect BOOLEAN,  -- Flag
        include_tex_count BOOLEAN,  -- Flag
        use_prefill_from_input BOOLEAN,  -- Flag
        round_stats TEXT  -- JSON array of stats per round
    )"""
    )

    conn.commit()
    conn.close()


def log_db_start(task_config: TaskConfig) -> int:
    """Initialize a new log entry and return its ID

    Args:
        task_config (TaskConfig): Configuration for task execution
        agent_settings (AgentSettings): Configuration for agent behavior
    """
    init_db()
    conn = sqlite3.connect(get_db_path())
    c = conn.cursor()

    # Convert lists to JSON strings for storage
    input_files = json.dumps(task_config.input_files) if task_config.input_files else None
    auxiliary_files = json.dumps(task_config.auxiliary_files) if task_config.auxiliary_files else None
    figure_inputs = json.dumps(task_config.figure_inputs) if task_config.figure_inputs else None
    reference_files = json.dumps(task_config.reference_files) if task_config.reference_files else None
    output_files = json.dumps(task_config.output_files) if task_config.output_files else None
    actual_output_files = json.dumps([])  # Initialize as empty, will be updated by log_db_output_files

    # Initialize empty array for round stats
    round_stats = json.dumps([])

    c.execute(
        """INSERT INTO coauthor_logs (
        timestamp, agent, model, input_file, input_files,
        auxiliary_files, figure_inputs, reference_files, output_file, output_files,
        actual_output_files, is_reflection,
        instruction, round_stats, reflect,
        auto_extract_figure, auto_extract_tikz_figure,
        auto_extract_tikz_figure_reflect, include_tex_count,
        use_prefill_from_input
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            datetime.now(),
            task_config.agent,
            task_config.model,
            task_config.input_file,
            input_files,
            auxiliary_files,
            figure_inputs,
            reference_files,
            None,  # output_file - will be updated later by log_db_output_files
            output_files,
            actual_output_files,
            False,  # is_reflection - will be updated during reflection
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


def log_db_and_print_statistics(state: State, model_config: ModelConfig, log_id: Optional[int] = None, prompt_caching: bool = False) -> None:
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

    if prompt_caching:
        logger.info(f"Total input tokens (cache read): {cache_read_tokens}")
        logger.info(f"Total input tokens (cache create): {cache_creation_tokens}")

        total_input_tokens_all = cache_creation_tokens + cache_read_tokens
        percentage_cached = (cache_read_tokens / total_input_tokens_all * 100) if total_input_tokens_all > 0 else 0
        logger.info(f"Percentage cached: {percentage_cached}%")
        cost = model_config.compute_price(total_input_tokens, total_output_tokens, cache_creation_tokens, cache_read_tokens)
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


def log_db_output_files(output_file: str, log_id: int, all_output_files: Optional[List[str]] = None) -> None:
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
        timestamp, agent, model, input_file, output_file,
        instruction, round_stats, reflect,
        auto_extract_figure, auto_extract_tikz_figure,
        auto_extract_tikz_figure_reflect, include_tex_count,
        use_prefill_from_input,
        input_files, auxiliary_files, figure_inputs, reference_files,
        output_files, actual_output_files
        FROM coauthor_logs WHERE id = ?""",
        (log_id,),
    )

    row = c.fetchone()
    if row:
        round_stats = json.loads(row[6])
        latest_stats = round_stats[-1] if round_stats else {}

        info = {
            "timestamp": row[0],
            "agent": row[1],
            "model": row[2],
            "input_file": row[3],
            "output_file": row[4],
            "instruction": row[5],
            "total_input_tokens": latest_stats.get("input_tokens", 0),
            "total_output_tokens": latest_stats.get("output_tokens", 0),
            "total_response_time": latest_stats.get("response_time", 0),
            "total_cost": latest_stats.get("cost", 0),
            "percentage_cached": latest_stats.get("percentage_cached", 0),
            "round_stats": round_stats,  # Include all rounds' stats
            "flags": {
                "reflect": row[7],
                "auto_extract_figure": row[8],
                "auto_extract_tikz_figure": row[9],
                "auto_extract_tikz_figure_reflect": row[10],
                "include_tex_count": row[11],
                "use_prefill_from_input": row[12],
            },
            "files": {
                "input_files": json.loads(row[13]) if row[13] else [],
                "auxiliary_files": json.loads(row[14]) if row[14] else [],
                "figure_inputs": json.loads(row[15]) if row[15] else [],
                "reference_files": json.loads(row[16]) if row[16] else [],
                "target_output_files": json.loads(row[17]) if row[17] else [],
                "actual_output_files": json.loads(row[18]) if row[18] else [],
            },
        }
        conn.close()
        return info

    conn.close()
    return None
