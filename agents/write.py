from coauthor.agent_reflect import ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "write")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="paper2cover",
        choices=[
            "polish_cover",
            "paper2cover",
            "write_proposal",
            "slide2paper",
            "paper2slide",
            "paper2referee",
            "revise_referee_report",
            "paper2poster",
            "translate2chn",
        ],
    )
    args = parser.parse_args()

    agent = ThinkAndWrite(args, agent_path)
    agent.run()


if __name__ == "__main__":
    main()
