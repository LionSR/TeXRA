import yaml


class PolishAgentConfig:
    def __init__(self, yaml_path: str):
        """Initialize the Polish Agent Config parser.

        Args:
            yaml_path (str): Path to the polish agent YAML file
        """
        with open(yaml_path, encoding="utf-8") as file:
            self.config = yaml.safe_load(file)

    @property
    def name(self) -> str:
        """Get the agent name."""
        return self.config.get("name", "")

    @property
    def settings(self) -> dict:
        """Get all settings."""
        return self.config.get("settings", {})

    @property
    def document_tag(self) -> str:
        """Get the document tag setting."""
        return self.settings.get("document_tag", "")

    @property
    def end_tag(self) -> str:
        """Get the end tag setting."""
        return self.settings.get("end_tag", "")

    @property
    def output_ext(self) -> str:
        """Get the output extension setting."""
        return self.settings.get("output_ext", "")

    @property
    def prefills(self) -> list[str]:
        """Get the prefills list."""
        return self.settings.get("prefills", [])

    @property
    def prompts(self) -> dict:
        """Get all prompts."""
        return self.config.get("prompts", {})

    @property
    def system_prompt(self) -> str:
        """Get the system prompt."""
        return self.prompts.get("system_prompt", "")

    @property
    def user_prefix(self) -> str:
        """Get the user prefix prompt."""
        return self.prompts.get("user_prefix", "")

    @property
    def user_request(self) -> str:
        """Get the user request prompt."""
        return self.prompts.get("user_request", "")

    @property
    def user_reflect(self) -> str:
        """Get the user reflect prompt."""
        return self.prompts.get("user_reflect", "")


def main():
    """Example usage of the PolishAgentConfig class."""
    config = PolishAgentConfig("../../agents/lecture/agent_polish.yaml")

    # Print some example properties
    print(f"Agent Name: {config.name}")
    print(f"Document Tag: {config.document_tag}")
    print(f"Output Extension: {config.output_ext}")
    print("\nPrefills:")
    for prefill in config.prefills:
        print(f"- {prefill}")

    # Print first few lines of each prompt
    print("\nPrompt Previews:")
    for prompt_name in ["system_prompt", "user_prefix", "user_request", "user_reflect"]:
        prompt_text = getattr(config, prompt_name)
        print(f"{prompt_name}: {prompt_text}")
        # preview = prompt_text.split("\n")[0] if prompt_text else ""
        # print(f"{prompt_name}: {preview[:100]}...")
        # print(f"{prompt_name}: {preview}")


if __name__ == "__main__":
    main()
