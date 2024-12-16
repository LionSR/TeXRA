import os
import sqlite3
import json
from datetime import datetime

from .agent_dataclass import AgentConfig, AgentSettings
from .agent_state import AgentGlobalState, AgentRoundState


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
        reflect BOOLEAN,
        auto_extract_figure BOOLEAN,
        auto_extract_tikz_figure BOOLEAN,
        auto_extract_tikz_figure_reflect BOOLEAN,
        include_tex_count BOOLEAN,
        use_prefill_from_input BOOLEAN,
        auto_confirmation BOOLEAN,
        global_state TEXT,  -- JSON object for global metrics
        round_states TEXT   -- JSON array of round-specific metrics
    )"""
    )

    conn.commit()
    conn.close()


def logdb_start(agent_config: AgentConfig, agent_settings: AgentSettings) -> int:
    """Initialize a new log entry and return its ID"""
    init_db()
    conn = sqlite3.connect(get_db_path())
    c = conn.cursor()

    # Convert lists to JSON strings for storage
    input_files = json.dumps(agent_config.input_files) if agent_config.input_files else None
    auxiliary_files = json.dumps(agent_config.auxiliary_files) if agent_config.auxiliary_files else None
    figure_files = json.dumps(agent_config.figure_files) if agent_config.figure_files else None
    reference_files = json.dumps(agent_config.reference_files) if agent_config.reference_files else None
    output_files = json.dumps(agent_config.output_files) if agent_config.output_files else None
    actual_output_files = json.dumps([])

    # Initialize empty state objects
    global_state = json.dumps({})
    round_states = json.dumps({})

    c.execute(
        """INSERT INTO coauthor_logs (
        timestamp, agent, model, temperature,
        input_file, input_files, auxiliary_file, auxiliary_files,
        figure_file, figure_files, reference_file, reference_files,
        edited_file, output_files, output_name_override,
        actual_output_files, instruction,
        global_state, round_states,
        reflect, auto_extract_figure, auto_extract_tikz_figure,
        auto_extract_tikz_figure_reflect, include_tex_count,
        use_prefill_from_input, auto_confirmation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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
            global_state,
            round_states,
            agent_config.reflect,
            agent_config.auto_extract_figure,
            agent_config.auto_extract_tikz_figure,
            agent_config.auto_extract_tikz_figure_reflect,
            agent_config.include_tex_count,
            agent_config.use_prefill_from_input,
            agent_config.auto_confirmation,
        ),
    )

    log_id = c.lastrowid
    if log_id is None:
        raise RuntimeError("Failed to create log entry - no ID returned")

    conn.commit()
    conn.close()

    return log_id


def update_statistics_in_db(log_id: int, global_state: AgentGlobalState, round_state: AgentRoundState, round: int) -> None:
    """Update statistics in the database.

    Args:
        log_id: The log entry ID
        global_state: The global state object containing all metrics
        round_state: The state for the current round
        round: The current round number
    """
    conn = sqlite3.connect(get_db_path())
    c = conn.cursor()

    # First, get existing round states
    c.execute("SELECT round_states FROM coauthor_logs WHERE id = ?", (log_id,))
    row = c.fetchone()
    existing_round_states = json.loads(row[0]) if row and row[0] else {}

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
    conn.close()


def logdb_output_files(output_file: str, log_id: int, all_output_files: list[str] | None = None) -> None:
    """Log output files to database."""
    if log_id is None:
        return

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
    elif output_file not in actual_files:
        actual_files.append(output_file)

    # Update the database
    c.execute(
        """UPDATE coauthor_logs SET
        actual_output_files = ?
        WHERE id = ?""",
        (json.dumps(actual_files), log_id),
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
        input_file, output_file, instruction,
        global_state, round_states,
        reflect, auto_extract_figure, auto_extract_tikz_figure,
        auto_extract_tikz_figure_reflect, include_tex_count,
        use_prefill_from_input, auto_confirmation,
        input_files, auxiliary_file, auxiliary_files,
        figure_file, figure_files, reference_file, reference_files,
        edited_file, output_files, output_name_override,
        actual_output_files
        FROM coauthor_logs WHERE id = ?""",
        (log_id,),
    )

    row = c.fetchone()
    if row:
        global_state = json.loads(row[7]) if row[7] else {}
        round_states = json.loads(row[8]) if row[8] else {}

        info = {
            "timestamp": row[0],
            "agent": row[1],
            "model": row[2],
            "temperature": row[3],
            "input_file": row[4],
            "output_file": row[5],
            "instruction": row[6],
            "total_input_tokens": global_state.get("total_input_tokens", 0),
            "total_output_tokens": global_state.get("total_output_tokens", 0),
            "total_response_time": global_state.get("total_response_time", 0),
            "round_states": round_states,
            "flags": {
                "reflect": row[9],
                "auto_extract_figure": row[10],
                "auto_extract_tikz_figure": row[11],
                "auto_extract_tikz_figure_reflect": row[12],
                "include_tex_count": row[13],
                "use_prefill_from_input": row[14],
                "auto_confirmation": row[15],
            },
            "files": {
                "input_files": json.loads(row[16]) if row[16] else [],
                "auxiliary_file": row[17],
                "auxiliary_files": json.loads(row[18]) if row[18] else [],
                "figure_file": row[19],
                "figure_files": json.loads(row[20]) if row[20] else [],
                "reference_file": row[21],
                "reference_files": json.loads(row[22]) if row[22] else [],
                "edited_file": row[23],
                "output_files": json.loads(row[24]) if row[24] else [],
                "output_name_override": row[25],
                "actual_output_files": json.loads(row[26]) if row[26] else [],
            },
        }
        conn.close()
        return info

    conn.close()
    return None
