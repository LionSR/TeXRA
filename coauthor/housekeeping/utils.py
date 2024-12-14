import os
from datetime import datetime


def get_agent_first_name_chunk(agent):
    if agent.startswith("write_"):
        return agent.split("_")[1]
    elif "_" in agent:
        return agent.split("_")[0]
    elif "-" in agent:
        return agent.split("-")[0]
    else:
        return agent


def get_file_patterns(base, model, agent, num_rounds=4):
    patterns = []
    for round in range(num_rounds):
        patterns.extend(
            [
                f"{base}_{agent}_r{round}_{model}",
                f"{base}_{agent}_r{round}_{model}_diff",
                f"{base}_{agent}_r{round}_{model}_diffr{round}r{round-1}",
                f"{base}_{agent}_r{round}_full_{model}",
                f"{base}_{agent}_r{round}_full_{model}_diff",
                f"{base}_{agent}_r{round}_full_{model}_diffr{round}r{round-1}",
                f"{base}_{agent}_r{round}_{model}_thinking",
            ]
        )
    return patterns


def get_folder_datetime(input_dir, file_patterns, extensions):
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
