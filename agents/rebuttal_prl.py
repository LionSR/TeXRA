import coauthor as coa
from coauthor.agent_reflect import ThinkAndWrite

agent_path = coa.get_agent_path(coa, "prl")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="draft_rebuttal",
        help="Mode of operation.",
        choices=["draft_rebuttal", "revise_rebuttal"],
    )

    args = parser.parse_args()

    agent = ThinkAndWrite(args, agent_path)
    agent.run()


if __name__ == "__main__":
    main()
