from coauthor.agent_reflect import ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "adapt")


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--agent", type=str, default="adapt", choices=["adapt"], help="Mode of operation, either 'adapt'.")
    args = parser.parse_args()

    adapt = ThinkAndWrite(args, agent_path)
    adapt.run()


if __name__ == "__main__":
    main()
