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
            "paper2cover",
            "proposal",
            "slide2paper",
            "paper2slide",
            "paper2referee",
            "revise_referee",
            "paper2poster",
            "translate2chn",
        ],
    )
    args = parser.parse_args()

    write_tex = ThinkAndWrite(args, agent_path)
    write_tex.run()


if __name__ == "__main__":
    main()
