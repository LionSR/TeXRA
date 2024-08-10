from coauthor.base_agents import ThinkAndWrite
import coauthor as coa

agent_path = coa.get_agent_path(coa, "grant")


class ReviseGrant(ThinkAndWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)

        if self.args.input_files:
            user_vars["ADDITIONAL_INPUT_CONTENTS"] = coa.get_xml_format_from_files(self.args.input_files)

        if self.args.auxiliary_files:
            user_vars["AUXILIARY_FILE_CONTENTS"] = coa.get_xml_format_from_files(self.args.auxiliary_files)
        else:
            user_vars["AUXILIARY_FILE_CONTENTS"] = ""

        if self.args.output_files:
            user_vars["OUTPUT_FILES_ORDER"] = ", ".join(self.args.output_files)

        coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--agent",
        type=str,
        default="revise_nsf_grant",
        choices=["revise_nsf_grant", "revise_marie_curie"],
    )
    args = parser.parse_args()

    revise_document = ReviseGrant(args, agent_path)
    revise_document.run()


if __name__ == "__main__":
    main()
