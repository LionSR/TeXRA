import coauthor as coa

from coauthor import AgentMerge

agent_path = coa.get_agent_path(coa, ".")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--agent", type=str, default="merge", help="Agent to choose.")
    args = parser.parse_args()

    merge = AgentMerge(args, agent_path)
    print(f"Merge args: {args}")
    merge.run()


if __name__ == "__main__":
    main()
