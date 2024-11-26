import coauthor as coa
from coauthor.agent_reflect import ThinkAndWrite, DirectWrite

agent_path = coa.get_agent_path(coa, "prl")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="correct_prl",
        choices=["correct_prl", "polish_prl"],
    )
    args = parser.parse_args()

    if args.agent.startswith("correct"):
        edit_prl = DirectWrite(args, agent_path)
    else:
        edit_prl = ThinkAndWrite(args, agent_path)
    edit_prl.run()


if __name__ == "__main__":
    main()
