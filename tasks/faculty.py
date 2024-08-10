from coauthor.base_tasks import ThinkAndWrite
import coauthor as coa

prompt_path = coa.get_prompt_path(coa, "faculty")


class ReviseApplicationDocument(ThinkAndWrite):
    def get_user_vars(self):
        user_vars = coa.get_user_vars_basic(self.args)

        if self.args.original_file:
            user_vars["INPUT_CONTENT"] = coa.read_file(self.args.original_file)

        coa.update_user_vars_single_output(self.args, user_vars)
        return user_vars

    # The handle_output method is inherited from ThinkAndWrite


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

    # The handle_output method is inherited from ThinkAndWrite


def main():
    parser = coa.get_common_argparser()
    parser.add_argument(
        "--task",
        type=str,
        default="statement_teaching",
        choices=["statement_teaching", "statement_diversity", "statement_research", "revise_nsf_grant", "revise_marie_curie"],
    )
    parser.add_argument("--original_file", type=str, help="Path to the original application document file")
    args = parser.parse_args()

    if args.task in ["statement_teaching", "statement_diversity", "statement_research"]:
        revise_document = ReviseApplicationDocument(args, prompt_path)
    elif args.task == "revise_nsf_grant":
        revise_document = ReviseGrant(args, prompt_path)
    elif args.task == "revise_marie_curie":
        revise_document = ReviseGrant(args, prompt_path)

    revise_document.run()


if __name__ == "__main__":
    main()
