import coauthor as coa
import os

from coauthor.agent_reflect import ThinkAndWrite, DirectWrite

agent_path = coa.get_agent_path(coa, "prl")


class ReplyPRLBase:
    def get_user_vars(self):
        user_vars = super().get_user_vars()
        return user_vars


class ReplyPRLDirect(ReplyPRLBase, DirectWrite):
    pass


class ReplyPRLThink(ReplyPRLBase, ThinkAndWrite):
    pass


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

    rebuttal = ReplyPRLThink(args, agent_path)
    # rebuttal = ReplyPRLDirect(args, agent_path)

    rebuttal.run()


if __name__ == "__main__":
    main()
