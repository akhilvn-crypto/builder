import unittest

from helpers import FIXTURES, TempProject, case, run, td


def findings(text, existing=None, external=None):
    doc = td.parse_test_cases(text)
    ex = td.parse_test_cases(existing) if existing else None
    return td.validate_doc(doc, ex, set(external or []))


def codes(text, **kw):
    return {f.code for f in findings(text, **kw) if f.severity == "error"}


def wrap(*blocks, module="# Mod\n\n"):
    return module + "\n".join(blocks)


class CanonicalContract(unittest.TestCase):
    def test_spec_example_is_valid(self):
        text = (FIXTURES / "valid-cases.md").read_text(encoding="utf-8")
        self.assertEqual(codes(text), set())

    def test_every_optional_part_is_optional(self):
        self.assertEqual(codes(wrap(case("TC-1", "Minimal"))), set())

    def test_inline_expected_alone_satisfies_expected_result(self):
        t = wrap("## TC-1: Inline\n\n### Steps\n1. Click the \"Go\" button -> Expected: The page shows \"Done\"\n")
        self.assertEqual(codes(t), set())

    def test_multiple_modules_and_moduleless_cases(self):
        t = (case("TC-1", "No module") + "\n# A\n\n" + case("TC-2", "In A", step="Open a")
             + "\n# B\n\n" + case("TC-3", "In B", step="Open b"))
        doc = td.parse_test_cases(t)
        self.assertEqual([c.module for c in doc.cases], [None, "A", "B"])
        self.assertEqual(codes(t), set())

    def test_crlf_files_parse_the_same(self):
        t = wrap(case("TC-1", "A")).replace("\n", "\r\n")
        self.assertEqual(codes(t), set())


class IdsAndTitles(unittest.TestCase):
    def test_missing_id_is_an_error(self):
        t = wrap("## Just a title\n\n### Steps\n1. Open the page\n\n### Expected Results\n- The page shows \"Hi\"\n")
        self.assertIn("ID_MISSING", codes(t))

    def test_duplicate_ids(self):
        self.assertIn("DUPLICATE_ID", codes(wrap(case("TC-1", "A"), case("TC-1", "B", step="Open another page"))))

    def test_id_already_saved(self):
        saved = wrap(case("TC-1", "A"))
        self.assertIn("DUPLICATE_ID", codes(wrap(case("TC-1", "B", step="Open another page")), existing=saved))

    def test_malformed_auto_id(self):
        self.assertIn("ID_FORMAT", codes(wrap(case("AUTO-XYZ", "A"))))
        self.assertEqual(codes(wrap(case("AUTO-0a1b2c3d", "A"))), set())

    def test_empty_title(self):
        self.assertIn("TITLE_MISSING", codes(wrap("## TC-1:\n\n### Steps\n1. Open\n\n### Expected Results\n- The page shows \"Hi\"\n")))


class ExpectedResults(unittest.TestCase):
    def test_missing(self):
        self.assertIn("EXPECTED_MISSING", codes(wrap("## TC-1: T\n\n### Steps\n1. Open the page\n")))

    def test_empty_section(self):
        self.assertIn("EXPECTED_EMPTY", codes(wrap("## TC-1: T\n\n### Steps\n1. Open the page\n\n### Expected Results\n")))

    def test_non_assertable_result_blocked(self):
        self.assertIn("EXPECTED_WEAK", codes(wrap(case("TC-1", "T", expected="It works"))))

    def test_vague_result_is_only_a_warning(self):
        t = wrap(case("TC-1", "T", expected="The form is submitted correctly"))
        self.assertEqual(codes(t), set())
        self.assertIn("EXPECTED_VAGUE", {f.code for f in findings(t)})

    def test_inline_expectation_repeated_in_results_warns(self):
        t = wrap("## TC-1: T\n\n### Steps\n1. Open the page -> Expected: The dashboard is displayed\n\n"
                 "### Expected Results\n- The dashboard is displayed\n- The URL contains \"/dashboard\"\n")
        self.assertEqual(codes(t), set())
        self.assertIn("EXPECTED_DUPLICATED", {f.code for f in findings(t)})

    def test_placeholders_blocked(self):
        self.assertIn("PLACEHOLDER_TEXT", codes(wrap(case("TC-1", "T", expected="TBD"))))
        self.assertIn("PLACEHOLDER_TEXT", codes(wrap(case("TC-1", "T", step="Enter <some value> in the field"))))


class DataAndSecrets(unittest.TestCase):
    def data_case(self, data, step="Enter {v} in the field"):
        return wrap(f"## TC-1: T\n\n### Test Data\n{data}\n\n### Steps\n1. {step}\n\n### Expected Results\n- The page shows \"Hi\"\n")

    def test_undeclared_variable(self):
        self.assertIn("VARIABLE_UNDECLARED", codes(self.data_case("- other: x")))

    def test_declared_variable_passes_and_unused_is_a_warning(self):
        t = self.data_case("- v: x\n- spare: y")
        self.assertEqual(codes(t), set())
        self.assertIn("VARIABLE_UNUSED", {f.code for f in findings(t)})

    def test_variable_in_inline_expected_must_be_declared(self):
        t = wrap("## TC-1: T\n\n### Steps\n1. Open the page -> Expected: Hello {who} is shown\n")
        self.assertIn("VARIABLE_UNDECLARED", codes(t))

    def test_env_must_be_a_name_not_a_value(self):
        self.assertIn("ENV_REF_INVALID", codes(self.data_case("- v: env:hunter2")))
        self.assertEqual(codes(self.data_case("- v: env:TEST_USER_PASSWORD")), set())

    def test_env_error_never_echoes_the_value(self):
        msgs = " ".join(f.message for f in findings(self.data_case("- v: env:hunter2")))
        self.assertNotIn("hunter2", msgs)

    def test_plain_value_for_credential_name_blocked(self):
        self.assertIn("SECRET_PLAIN_VALUE", codes(self.data_case("- password: s3cret-value", "Enter {password}")))
        self.assertIn("SECRET_PLAIN_VALUE", codes(self.data_case("- apiKey: abc", "Enter {apiKey}")))
        self.assertIn("SECRET_PLAIN_VALUE", codes(self.data_case("- user_token: abc", "Enter {user_token}")))

    def test_secret_value_never_echoed_in_findings(self):
        msgs = " ".join(f.message for f in findings(self.data_case("- password: s3cret-value", "Enter {password}")))
        self.assertNotIn("s3cret-value", msgs)

    def test_explicit_literal_for_fake_credential_is_allowed(self):
        self.assertEqual(codes(self.data_case("- wrong_password: literal:wrong-pass-1", "Enter {wrong_password}")), set())

    def test_innocent_names_are_not_flagged(self):
        for name in ("keyboard", "footprint", "pinned_item", "plan"):
            self.assertEqual(codes(self.data_case(f"- {name}: x", "Enter {%s}" % name)), set(), name)

    def test_token_shaped_values_blocked(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij"
        self.assertIn("SECRET_DETECTED", codes(self.data_case(f"- v: {jwt}")))

    def test_data_line_format(self):
        self.assertIn("DATA_FORMAT", codes(self.data_case("- no colon here")))


class StepsAndImplementation(unittest.TestCase):
    def test_selectors_and_code_blocked(self):
        for step in ("Click #submit-btn", "Run page.locator('.x').click()", "Click //div[@id='a']",
                     "Click [data-testid=login]", "await expect(x)"):
            self.assertIn("IMPLEMENTATION_DETAIL", codes(wrap(case("TC-1", "T", step=step))), step)

    def test_ordinary_prose_is_not_flagged(self):
        for step in ("Click the \"Sign in\" button", "Select option #1 from the list", "Open https://example.test/a#top"):
            self.assertEqual(codes(wrap(case("TC-1", "T", step=step))), set(), step)

    def test_steps_required(self):
        self.assertIn("STEPS_MISSING", codes(wrap("## TC-1: T\n\n### Expected Results\n- The page shows \"Hi\"\n")))

    def test_non_numbered_step_line(self):
        self.assertIn("STEP_FORMAT", codes(wrap("## TC-1: T\n\n### Steps\n- open\n\n### Expected Results\n- The page shows \"Hi\"\n")))

    def test_numbering_gap_is_warning_and_autofixable(self):
        t = wrap("## TC-1: T\n\n### Steps\n1. Open\n3. Click\n\n### Expected Results\n- The page shows \"Hi\"\n")
        self.assertIn("STEP_NUMBERING", {f.code for f in findings(t)})
        fixed, fixes = td.fix_safe(t)
        self.assertIn("3. Click", t)
        self.assertIn("2. Click", fixed)
        self.assertNotIn("STEP_NUMBERING", {f.code for f in findings(fixed)})


class StructureRules(unittest.TestCase):
    def test_stray_text_unknown_field_unknown_section(self):
        self.assertIn("STRAY_CONTENT", codes("Hello\n\n" + wrap(case("TC-1", "A"))))
        self.assertIn("UNKNOWN_FIELD", codes(wrap("## TC-1: T\nColour: red\n\n### Steps\n1. Open\n\n### Expected Results\n- The page shows \"Hi\"\n")))
        self.assertIn("UNKNOWN_SECTION", codes(wrap("## TC-1: T\n\n### Notes\n- x\n\n### Steps\n1. Open\n\n### Expected Results\n- The page shows \"Hi\"\n")))

    def test_duplicate_section(self):
        t = wrap("## TC-1: T\n\n### Steps\n1. Open\n\n### Steps\n1. Again\n\n### Expected Results\n- The page shows \"Hi\"\n")
        self.assertIn("DUPLICATE_SECTION", codes(t))

    def test_empty_optional_field(self):
        self.assertIn("FIELD_EMPTY", codes(wrap(case("TC-1", "T", extra="Tags:"))))

    def test_unusual_priority_and_order_are_warnings(self):
        t = wrap("## TC-1: T\nPriority: Urgent\n\n### Steps\n1. Open\n\n### Preconditions\n- x\n\n### Expected Results\n- The page shows \"Hi\"\n")
        w = {f.code for f in findings(t) if f.severity == "warning"}
        self.assertTrue({"PRIORITY_VALUE", "SECTION_ORDER"} <= w)
        self.assertEqual(codes(t), set())

    def test_empty_file(self):
        self.assertIn("NO_CASES", codes(""))

    def test_headings_inside_fences_are_content(self):
        t = wrap("## TC-1: T\n\n### Steps\n1. Open\n\n### Expected Results\n- The page shows \"Hi\"\n```\n## TC-2: not a case\n```\n")
        self.assertEqual([c.id for c in td.parse_test_cases(t).cases], ["TC-1"])


class DependenciesAndDuplicates(unittest.TestCase):
    def test_unknown_dependency(self):
        self.assertIn("DEPENDENCY_UNKNOWN", codes(wrap(case("TC-1", "A", extra="Depends on: TC-9"))))

    def test_dependency_on_saved_case_is_valid(self):
        saved = wrap(case("TC-9", "Saved"))
        self.assertEqual(codes(wrap(case("TC-1", "A", step="Open a", extra="Depends on: TC-9")), existing=saved), set())

    def test_external_ids_accepted(self):
        self.assertEqual(codes(wrap(case("TC-1", "A", extra="Depends on: TC-9")), external=["TC-9"]), set())

    def test_self_dependency(self):
        self.assertIn("DEPENDENCY_SELF", codes(wrap(case("TC-1", "A", extra="Depends on: TC-1"))))

    def test_cycle_of_three(self):
        t = wrap(case("TC-1", "A", extra="Depends on: TC-2"),
                 case("TC-2", "B", step="Open b", extra="Depends on: TC-3"),
                 case("TC-3", "C", step="Open c", extra="Depends on: TC-1"))
        self.assertIn("DEPENDENCY_CYCLE", codes(t))

    def test_cycle_through_saved_cases(self):
        saved = wrap(case("TC-9", "Saved", extra="Depends on: TC-1"))
        t = wrap(case("TC-1", "A", extra="Depends on: TC-9"))
        self.assertIn("DEPENDENCY_CYCLE", codes(t, existing=saved))

    def test_chain_without_cycle_is_fine(self):
        t = wrap(case("TC-1", "A"), case("TC-2", "B", step="Open b", extra="Depends on: TC-1"),
                 case("TC-3", "C", step="Open c", extra="Depends on: TC-1, TC-2"))
        self.assertEqual(codes(t), set())

    def test_bad_dependency_id_format(self):
        self.assertIn("DEPENDENCY_FORMAT", codes(wrap(case("TC-1", "A", extra="Depends on: nope"))))

    def test_same_scenario_twice_is_an_error(self):
        t = wrap(case("TC-1", "A"), case("TC-2", "B"))
        self.assertIn("DUPLICATE_SCENARIO", codes(t))

    def test_different_data_is_not_a_duplicate(self):
        a = "## TC-1: Short\n\n### Test Data\n- n: ab\n\n### Steps\n1. Enter {n}\n\n### Expected Results\n- The page shows \"Hi\"\n"
        b = a.replace("TC-1", "TC-2").replace("ab", "abcdef")
        self.assertEqual(codes(wrap(a, b)), set())

    def test_duplicate_of_saved_scenario(self):
        self.assertIn("DUPLICATE_SCENARIO", codes(wrap(case("TC-2", "Other")), existing=wrap(case("TC-1", "A"))))

    def test_same_title_same_module_warns(self):
        t = wrap(case("TC-1", "Same title"), case("TC-2", "Same title", step="Open b"))
        self.assertIn("DUPLICATE_TITLE", {f.code for f in findings(t)})


class FixSafe(unittest.TestCase):
    def test_formatting_only(self):
        messy = ("# Mod\n## TC-1: T  \nTags: a,b\n\n\n### Steps\n1. Open\n5. Click ->Expected:  Done\n"
                 "\n### Expected Results\n* The page shows \"Hi\"\n")
        fixed, fixes = td.fix_safe(messy)
        self.assertIn("Tags: a, b", fixed)
        self.assertIn("2. Click -> Expected: Done", fixed)
        self.assertIn("- The page shows", fixed)
        self.assertNotIn("\n\n\n", fixed)
        self.assertTrue(fixed.endswith("\n"))
        self.assertEqual(codes(fixed), set())

    def test_idempotent_and_meaning_preserving(self):
        text = (FIXTURES / "valid-cases.md").read_text(encoding="utf-8")
        once, _ = td.fix_safe(text)
        twice, fixes = td.fix_safe(once)
        self.assertEqual(once, twice)
        self.assertEqual(once, text)  # already canonical: unchanged


class ValidatorCli(TempProject):
    def test_exit_codes_and_report_shape(self):
        ok = self.write("ok.md", wrap(case("TC-1", "A")))
        code, out = run("validate-test-cases.py", ok)
        self.assertEqual((code, out["ok"], out["summary"]["cases"]), (0, True, 1))
        bad = self.write("bad.md", wrap("## No id\n"))
        code, out = run("validate-test-cases.py", bad)
        self.assertEqual((code, out["ok"]), (1, False))
        self.assertFalse(out["cases"][0]["valid"])

    def test_strict_fails_on_warnings(self):
        vague = self.write("v.md", wrap(case("TC-1", "A", expected="It is shown correctly")))
        self.assertEqual(run("validate-test-cases.py", vague)[0], 0)
        self.assertEqual(run("validate-test-cases.py", vague, "--strict")[0], 1)

    def test_fix_safe_writes_a_copy_and_never_edits_the_input(self):
        src = self.write("m.md", "# M\n## Untitled\n### Steps\n2. Open\n### Expected Results\n- The page shows \"Hi\"\n")
        before = src.read_bytes()
        out_path = self.root / "fixed.md"
        code, out = run("validate-test-cases.py", src, "--fix-safe", "--fix-output", out_path)
        self.assertEqual(src.read_bytes(), before)
        self.assertTrue(out_path.is_file())
        self.assertIn("1. Open", out_path.read_text(encoding="utf-8"))
        self.assertEqual(code, 1)  # still missing an ID: fix-safe never invents one
        code, out = run("validate-test-cases.py", src, "--fix-safe", "--fix-output", src)
        self.assertEqual(code, 2)

    def test_missing_file(self):
        code, out = run("validate-test-cases.py", self.root / "nope.md")
        self.assertEqual((code, out["error"]["code"]), (4, "FILE_MISSING"))


if __name__ == "__main__":
    unittest.main()
