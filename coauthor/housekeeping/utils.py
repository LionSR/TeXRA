import os
from datetime import datetime


def get_agent_first_name_chunk(agent: str) -> str:
    """Extract first component of agent name from write_X, X_Y, or X-Y format."""
    if agent.startswith("write_"):
        return agent.split("_")[1]
    elif "_" in agent:
        return agent.split("_")[0]
    elif "-" in agent:
        return agent.split("-")[0]
    else:
        return agent


def get_file_patterns(base: str, model: str, agent: str, total_rounds: int = 4) -> list[str]:
    """Generate list of file patterns for LaTeX outputs across multiple rounds."""
    patterns = []
    for curr_round in range(total_rounds):
        base_pattern = f"{base}_{agent}_r{curr_round}_{model}"
        full_pattern = f"{base}_{agent}_r{curr_round}_full_{model}"
        patterns.extend(
            [
                base_pattern,
                f"{base_pattern}_diff",
                f"{base_pattern}_diffr{curr_round}r{curr_round-1}",
                full_pattern,
                f"{full_pattern}_diff",
                f"{full_pattern}_diffr{curr_round}r{curr_round-1}",
                f"{base_pattern}_thinking",
            ]
        )
    return patterns


def get_folder_datetime(input_dir: str, file_patterns: list[str], extensions: list[str]) -> str:
    """Get formatted datetime string based on most recent file modification time."""
    most_recent_time = None
    for pattern in file_patterns:
        for ext in extensions:
            for search_dir in [os.path.join(input_dir, "build"), input_dir]:
                file_path = os.path.join(search_dir, f"{pattern}{ext}")
                if os.path.exists(file_path):
                    mod_time = os.path.getmtime(file_path)
                    if most_recent_time is None or mod_time > most_recent_time:
                        most_recent_time = mod_time

    timestamp = datetime.fromtimestamp(most_recent_time) if most_recent_time else datetime.now()
    return timestamp.strftime("%Y%m%d%H%M")
