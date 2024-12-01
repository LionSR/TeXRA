from coauthor.agent_reflect import ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "statement")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="statement_teaching",
        choices=["statement_teaching", "statement_diversity", "statement_research"],
    )
    args = parser.parse_args()

    agent = ThinkAndWrite(args, agent_path)
    agent.run()


if __name__ == "__main__":
    main()
