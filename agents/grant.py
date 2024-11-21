from coauthor.agent_reflect import ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "grant")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="revise_nsf_grant",
        choices=["revise_nsf_grant", "revise_marie_curie"],
    )
    args = parser.parse_args()

    revise_document = ThinkAndWrite(args, agent_path)
    revise_document.run()


if __name__ == "__main__":
    main()
