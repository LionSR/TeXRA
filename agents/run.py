# agents/run.py
import coauthor as coa
from coauthor.agent_reflect import ThinkAndWrite, DirectWrite
from coauthor.prompt_utils import load_agent_settings_and_prompts
from pathlib import Path


def get_agent_class(agent_path: str, agent: str):
    """Determine agent class based on yaml settings"""
    settings_dict, _ = load_agent_settings_and_prompts(agent_path, agent)
    return DirectWrite if settings_dict.get("agent_type") == "direct" else ThinkAndWrite


def get_agent_name(base_agent: str, kwargs: dict) -> str:
    """Get agent name, appending _multiple if output_files exist"""
    if kwargs.get("output_files"):
        return f"{base_agent}_multiple"
    return base_agent


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--agent", type=str, required=True, help="Name of the agent to run")
    args = parser.parse_args()

    # Determine if this is a multiple agent
    agent_name = get_agent_name(args.agent, vars(args))

    # Get agent path from yaml location
    yaml_path = None
    agents_dir = Path(coa.get_agent_path(coa, "."))
    for yaml_file in agents_dir.rglob(f"{agent_name}.yaml"):
        yaml_path = yaml_file
        break

    if not yaml_path:
        raise ValueError(f"Could not find yaml file for agent: {agent_name}")

    agent_path = str(yaml_path.parent)

    # Get correct agent class from settings
    agent_class = get_agent_class(agent_path, agent_name)
    agent = agent_class(args, agent_path)
    agent.run()


if __name__ == "__main__":
    main()
