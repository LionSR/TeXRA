# agents/run.py
import coauthor as coa
from coauthor.logger import logger


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--agent", type=str, required=True, help="Name of the agent to run")
    args = parser.parse_args()
    logger.debug(f"Args: {args}")

    # Convert args to kwargs
    kwargs = vars(args)
    coa.run_agent(kwargs.pop("agent"), **kwargs)


if __name__ == "__main__":
    main()
