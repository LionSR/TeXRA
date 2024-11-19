from coauthor.agent_reflect import DirectWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "adapt")


class Adapt(DirectWrite):
    def get_user_vars(self):
        user_vars = super().get_user_vars()
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument("--agent", type=str, default="adapt", choices=["adapt"], help="Mode of operation, either 'adapt'.")
    args = parser.parse_args()

    adapt = Adapt(args, agent_path)
    adapt.run()


if __name__ == "__main__":
    main()
