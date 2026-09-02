"""Optional Gradescope adapter: writes data/gradescope.json for the pipeline to merge.

OFF BY DEFAULT, AND DELIBERATELY SO. Read extras/gradescope/README.md before you
enable it -- it covers the terms-of-use question you should answer for yourself
first, and how to install the Python dependency.

DORMANT UNTIL CREDENTIALS EXIST. It does nothing until gradescope-credentials.json
exists next to this file, in one of two shapes:
  {"email": "...", "dpapiPassword": "<b64>"}  written by `--setup`: the Gradescope
    password DPAPI-sealed (CurrentUser scope). THE NORMAL SHAPE -- no plaintext
    password on disk. Windows only, because DPAPI is.
  {"email": "...", "password": "..."}   standalone plaintext (works, discouraged)

In both shapes `email` is the WHOLE address you log into Gradescope with. No
domain is ever appended to it: a Gradescope account is frequently not at the
institution's domain, and guessing one produced nothing but "Invalid
email/password combination".

WHY IT IS WORTH HAVING. Some courses collect everything on Gradescope, which
makes Gradescope the only place that knows whether that work is DONE. That
completion signal flows back into the agenda through applyGradescopeStatus(),
which matches on course plus fuzzy title -- so it also closes items that were
born from EMAIL (a professor announces "Hw1" by mail, the student submits
"Homework 1" on Gradescope, and the mail-born item closes itself).

Output (data/gradescope.json, or stdout under --json):
  {
    "generatedAt": "ISO",
    "term": {"filter": "...", "kept": N, "skipped": N},
    "courses":     [{"id","name","fullName","semester","year","code"}],
    "assignments": [{"courseCode","courseId","name","assignmentId","due","releaseAt",
                     "lateDue","submitted","status","grade","maxGrade","url"}],
    "errors": ["..."]
  }

  - `submitted` is TRI-STATE: true = Gradescope shows a submission or a grade,
    false = Gradescope explicitly says "No Submission", null = it did not say.
    null means UNKNOWN, never "not done" -- merge.mjs mergeSubmitted() ranks
    true > false > null for exactly this reason.
  - `assignments` includes UNDATED assignments (due: null). scrape.mjs drops those
    on its own (toItem returns null without a due date), and applyGradescopeStatus
    needs them: an undated Gradescope row can still prove an email-born item is done.
  - `courseCode` is normalized to the configured course code when the course is one
    of the tracked ones ("CHEM 11500" -> "CHEM 115"), so the byCode lookup hits.
  - `errors` also carries CANARY findings. gradescopeapi returns [] on ANY parse
    failure or lost session -- no exception, exit 0, "success with an empty
    agenda". So a course that had work last run and comes back empty this run
    (or a kept course whose every status cell went unreadable) is a FAILURE: the
    file is still written, the findings land in `errors`, and the run exits 1 so
    the caller raises a visible `gradescope:` pipeline error. See canary_findings().

API reality (gradescopeapi 1.8.1, verified against the installed package):
  - conn.account.get_assignments(course_id) -> list[Assignment] with fields
    assignment_id, name, release_date, due_date, late_due_date, submissions_status,
    grade, max_grade. For a STUDENT this comes from get_assignments_student_view(),
    which reads the status column of the course page: it sets "Submitted" when the
    cell parses as "points / max", otherwise it passes the cell text through
    ("No Submission", "Submitted", "Late", "Ungraded", ...).
  - conn.account.get_assignment_submission(s)() exist but are INSTRUCTOR-ONLY (they
    scrape /review_grades); a student session cannot use them. The student-visible
    status column above is the supported way to read submission state, and it is
    enough for this adapter.

Usage:
  python gradescope.py               # normal run (needs credentials)
  python gradescope.py --json        # same, but print the JSON to stdout and write
                                     #   nothing -- this is how the connector calls it
  python gradescope.py --setup       # prompt for email + password (hidden), DPAPI-seal,
                                     #   then VALIDATE the login immediately
  python gradescope.py --check       # no credentials needed: library + API surface,
                                     #   plus a login-form probe (no login attempted)
  python gradescope.py --self-test   # no credentials needed: test the status classifier
                                     #   and the empty-result canary
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent            # the repository root: extras/gradescope/../..
CREDS = HERE / "gradescope-credentials.json"
CONFIG = ROOT / "config.json"
OUT = ROOT / "data" / "gradescope.json"

# CurrentUser-scope DPAPI through PowerShell, with the secret on stdin and the
# result on stdout only -- never in argv (visible to every process on the
# machine) and never in a temp file (survives a crash).
DPAPI_DECRYPT_PS = (
    "$ErrorActionPreference='Stop'\n"
    "Add-Type -AssemblyName System.Security\n"
    "$b64 = [Console]::In.ReadToEnd()\n"
    "$enc = [Convert]::FromBase64String($b64.Trim())\n"
    "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, "
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n"
    "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))\n"
)
DPAPI_ENCRYPT_PS = (
    "$ErrorActionPreference='Stop'\n"
    "Add-Type -AssemblyName System.Security\n"
    "$plain = [Console]::In.ReadToEnd()\n"
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)\n"
    "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, "
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)\n"
    "[Console]::Out.Write([Convert]::ToBase64String($enc))\n"
)


def _dpapi_run(script: str, stdin_text: str, what: str) -> str:
    import subprocess

    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-Command", script],
        input=stdin_text, capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0 or not result.stdout:
        raise RuntimeError(f"DPAPI {what} failed: {(result.stderr or 'no output').strip()[:200]}")
    return result.stdout


def dpapi_decrypt(b64: str) -> str:
    return _dpapi_run(DPAPI_DECRYPT_PS, b64, "decrypt")


def dpapi_encrypt(plain: str) -> str:
    return _dpapi_run(DPAPI_ENCRYPT_PS, plain, "encrypt")


def load_credentials() -> tuple[str, str]:
    """(email, password) from gradescope-credentials.json, either shape.

    A malformed file RAISES rather than skipping. The caller turns the non-zero
    exit into a visible pipeline error, which is the loud failure this has to be:
    a silent empty result here would read as "nothing due on Gradescope", which
    is exactly the wrong thing to tell somebody.

    `email` is always the complete address. No domain is ever appended to a bare
    username -- a Gradescope login is often not at the institution's domain, and
    a guessed address just fails authentication in a way that looks like a wrong
    password.
    """
    creds = json.loads(CREDS.read_text(encoding="utf-8"))
    email = str(creds.get("email") or "").strip()
    if "@" not in email:
        raise RuntimeError(
            "gradescope-credentials.json needs a complete \"email\" (the whole address you "
            "log into Gradescope with) -- run `python gradescope.py --setup`"
        )
    if creds.get("dpapiPassword"):
        return email, dpapi_decrypt(creds["dpapiPassword"])
    password = str(creds.get("password") or "")
    if not password:
        raise RuntimeError(
            "gradescope-credentials.json is malformed: run `python gradescope.py --setup`"
        )
    return email, password


# The one selector gradescopeapi's _login_helpers.py depends on: it GETs the
# landing page, pulls the CSRF token out of the login form, and posts with it.
# If this stops resolving the library cannot log anyone in, no matter how right
# the password is.
LOGIN_URL = "https://www.gradescope.com"
LOGIN_FORM_SELECTOR = 'form[action="/login"] input[name="authenticity_token"]'


def probe_login_form() -> bool:
    """True when gradescope.com still serves the login form the library posts to.

    Uses NO credentials -- it is a plain GET of the landing page. requests and
    beautifulsoup4 are both already installed as gradescopeapi dependencies.

    RAISES on a network or parse failure rather than returning False, because
    "I could not look" and "the form is gone" are different answers and the
    callers report them differently.
    """
    import requests
    from bs4 import BeautifulSoup

    resp = requests.get(LOGIN_URL, timeout=20)
    resp.raise_for_status()
    return BeautifulSoup(resp.text, "html.parser").select_one(LOGIN_FORM_SELECTOR) is not None


def login_failure_hint() -> str:
    """The one stderr line to print when conn.login() raises ValueError.

    The library raises the SAME ValueError("Invalid credentials.") for a wrong
    password and for a login page it can no longer parse -- two failures with
    opposite fixes (re-run --setup vs. upgrade/patch the library). Re-probing the
    form tells them apart. Never echoes any credential.
    """
    try:
        form_ok = probe_login_form()
    except Exception as e:
        return f"credentials rejected by Gradescope (login-form probe failed too: {str(e)[:120]})"
    if not form_ok:
        return "login page changed (form selector gone) -- library drift, NOT bad credentials"
    return "credentials rejected by Gradescope"


# Status cell text that PROVES nothing was handed in.
NOT_SUBMITTED = ("no submission", "no submissions", "not submitted", "missing", "unsubmitted")
# Status cell text that PROVES something was handed in.
SUBMITTED_MARKERS = ("submitted", "ungraded", "graded", "late", "complete", "resubmit")


def normalize_status(status) -> str:
    return " ".join(str(status or "").split()).strip().lower()


def submission_state(status, grade=None):
    """Tri-state read of one Gradescope status cell. Pure; unit-tested by --self-test.

    Returns True (handed in), False (explicitly not handed in), or None (unknown).
    Order matters: "No Submission" contains "submission" but not "submitted", and is
    checked first regardless.
    """
    if grade is not None:
        return True
    text = normalize_status(status)
    if not text:
        return None
    for marker in NOT_SUBMITTED:
        if marker in text:
            return False
    if "/" in text:  # "8.0 / 10.0" -- a posted grade
        return True
    for marker in SUBMITTED_MARKERS:
        if marker in text:
            return True
    return None


def course_code_key(text) -> str:
    """'CHEM 11500' / 'CHEM-115' / 'chem115' -> 'CHEM115'. Mirrors completion.mjs normCourseCode.

    Separators include "." because LTI-provisioned Gradescope courses are named
    like "lti.202601.MATH.21000.001" -- the regex walks past the term prefix (its
    digits fail the 3-plus-optional-2 shape) and locks onto MATH210."""
    import re

    s = str(text or "").upper()
    m = re.search(r"([A-Z]{2,5})[\s.\-]*(\d{3})(\d{2})?(?![0-9])", s)
    if m:
        return f"{m.group(1)}{m.group(2)}"
    return re.sub(r"[^A-Z0-9]", "", s)


def load_tracked_courses() -> dict:
    """{course_code_key: config code} for the courses in config.json."""
    try:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return {course_code_key(c.get("code", "")): c.get("code", "") for c in cfg.get("courses", []) if c.get("code")}


def prev_assignment_counts() -> dict:
    """{courseCode: assignment count} from the EXISTING data/gradescope.json.

    Must be called BEFORE the new file overwrites it. An empty dict means "no
    baseline" -- no previous file, an unreadable one, or a previous run that
    found nothing anywhere -- and canary_findings() reads that as a first run
    and stays silent, because there is nothing to have regressed from.
    """
    if not OUT.exists():
        return {}
    try:
        prev = json.loads(OUT.read_text(encoding="utf-8"))
    except Exception:
        return {}  # a corrupt baseline is no baseline; never crash the run over it
    counts = {}
    for a in prev.get("assignments") or []:
        code = str(a.get("courseCode") or "")
        if code:
            counts[code] = counts.get(code, 0) + 1
    return counts


def canary_findings(prev_counts: dict, courses_out: list, assignments: list,
                    tracked_codes=None) -> list:
    """Loud-failure check on an otherwise "successful" run. Pure; unit-tested by --self-test.

    gradescopeapi's get_assignments returns [] on ANY parse failure or lost
    session (a 302 to /login renders as a 200 login page with zero rows). Nothing
    raises. So the only way to notice is to compare against what the last run saw:

      (a) a course that had N > 0 assignments last run and has ZERO now, while it
          is still kept in this run's courses (or is missing from them but is
          still a tracked course from config.json) -- HTML drift, a lost session,
          or the institution-level "require SSO" flip.
      (b) a kept course with >= 3 assignment rows whose `submitted` is None on
          every single one -- the status column moved or was renamed, so every
          completion signal silently became "unknown".

    `tracked_codes` is the config.json code set; when it is None every code in
    prev_counts is treated as in scope. It exists so that an UNTRACKED course
    legitimately dropped by the term filter (last term's ECON 101) does not fire
    rule (a), while a tracked course that vanished entirely still does.

    Returns human-readable finding strings (empty list = all clear). The caller
    appends them to the payload's errors[], prints them to stderr and exits 1.
    """
    if not prev_counts:
        return []  # first run: no baseline, nothing to compare, no canary

    tracked = set(tracked_codes) if tracked_codes is not None else None
    kept_codes = [str(c.get("code") or "") for c in courses_out]
    counts_now = {}
    for a in assignments:
        code = str(a.get("courseCode") or "")
        counts_now[code] = counts_now.get(code, 0) + 1

    findings = []
    for code, prev_n in sorted(prev_counts.items()):
        if prev_n <= 0 or counts_now.get(code, 0) > 0:
            continue
        in_scope = code in kept_codes or tracked is None or code in tracked
        if in_scope:
            findings.append(f"canary: {code} went {prev_n} -> 0 assignments")

    seen = set()
    for code in kept_codes:
        if code in seen:
            continue
        seen.add(code)
        rows = [a for a in assignments if str(a.get("courseCode") or "") == code]
        if len(rows) >= 3 and all(a.get("submitted") is None for a in rows):
            findings.append(f"canary: {code} statuses all unreadable (parse drift?)")
    return findings


def iso(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat() if value.tzinfo else value.isoformat()
    return str(value)


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def check() -> int:
    """No credentials needed. Confirm the library is importable and report its API."""
    try:
        from gradescopeapi.classes.account import Account
        from gradescopeapi.classes.assignments import Assignment
        from gradescopeapi.classes.connection import GSConnection  # noqa: F401
    except ImportError as e:
        print(f"gradescopeapi NOT installed ({e}): python -m pip install gradescopeapi", file=sys.stderr)
        return 1
    import dataclasses

    print("gradescopeapi: importable")
    print("Assignment fields: " + ", ".join(f.name for f in dataclasses.fields(Assignment)))
    print("submission status source: Assignment.submissions_status (+ .grade / .max_grade)")
    have = [n for n in ("get_courses", "get_assignments", "get_assignment_submission") if hasattr(Account, n)]
    print("Account methods present: " + ", ".join(have))
    print("student-usable: get_courses, get_assignments  |  instructor-only: get_assignment_submission(s)")
    if CREDS.exists():
        try:
            j = json.loads(CREDS.read_text(encoding="utf-8"))
            mode = "sealed" if j.get("dpapiPassword") else "plaintext"
        except Exception:
            mode = "UNREADABLE"
        print(f"credentials file present: True ({mode})")
    else:
        print("credentials file present: False")
    # Live drift check, no credentials and no login attempt: if this ever says
    # False, a "credentials rejected" failure is really library drift.
    try:
        print(f"login form reachable: {probe_login_form()}")
    except Exception as e:
        # Offline, blocked, or Gradescope down: --check must still exit 0.
        print(f"login form reachable: unknown ({str(e)[:120]})")
    print(f"tracked courses from config.json: {sorted(load_tracked_courses().values())}")
    return 0


def self_test() -> int:
    """No credentials needed. Exercise the pure status classifier."""
    cases = [
        ("No Submission", None, False),
        ("no submission", None, False),
        ("Submitted", None, True),
        ("Submitted Late", None, True),
        ("Late", None, True),
        ("Ungraded", None, True),
        ("8.0 / 10.0", None, True),
        ("", None, None),
        (None, None, None),
        ("No Submission", 9.0, True),  # a posted grade outranks a stale status cell
        ("Something New", None, None),  # unknown wording stays unknown, never guessed
    ]
    failures = 0
    for status, grade, expected in cases:
        got = submission_state(status, grade)
        ok = got is expected
        failures += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'} submission_state({status!r}, {grade!r}) -> {got!r} (want {expected!r})")
    codes = [
        ("CHEM 11500", "CHEM115"), ("CHEM 115", "CHEM115"), ("ART101", "ART101"), ("", ""),
        # LTI-provisioned names, in the shape Gradescope actually serves them
        ("lti.202601.MATH.21000.001", "MATH210"),
        ("lti.202601.ECON.10100.Y05", "ECON101"),
    ]
    for raw, expected in codes:
        got = course_code_key(raw)
        ok = got == expected
        failures += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'} course_code_key({raw!r}) -> {got!r} (want {expected!r})")

    # The empty-result canary: the check that stops a parse failure or a lost
    # session from reading as "nothing is due on Gradescope".
    def row(code, submitted=None):
        return {"courseCode": code, "submitted": submitted}

    def course(code):
        return {"code": code}

    tracked_codes = {"PHYS 221", "MATH 210", "CHEM 115", "HIST 140", "ART 101", "SEM 100"}
    # (label, prev_counts, courses_out, assignments, expected findings)
    canary_cases = [
        ("steady state",
         {"CHEM 115": 2}, [course("CHEM 115")], [row("CHEM 115", True), row("CHEM 115", False)],
         []),
        ("kept course emptied out",
         {"CHEM 115": 2}, [course("CHEM 115")], [],
         ["canary: CHEM 115 went 2 -> 0 assignments"]),
        ("tracked course vanished from the course list entirely",
         {"HIST 140": 1}, [course("CHEM 115")], [row("CHEM 115", True)],
         ["canary: HIST 140 went 1 -> 0 assignments"]),
        ("untracked course dropped by the term filter is not a regression",
         {"ECON 101": 14}, [course("CHEM 115")], [row("CHEM 115", True)],
         []),
        ("kept course with every status unreadable",
         {"MATH 210": 3}, [course("MATH 210")], [row("MATH 210"), row("MATH 210"), row("MATH 210")],
         ["canary: MATH 210 statuses all unreadable (parse drift?)"]),
        ("two unreadable rows are under the threshold",
         {"MATH 210": 2}, [course("MATH 210")], [row("MATH 210"), row("MATH 210")],
         []),
        ("one readable status clears the whole course",
         {"MATH 210": 3}, [course("MATH 210")], [row("MATH 210"), row("MATH 210"), row("MATH 210", False)],
         []),
        ("both rules fire at once",
         {"CHEM 115": 2, "MATH 210": 3}, [course("CHEM 115"), course("MATH 210")],
         [row("MATH 210"), row("MATH 210"), row("MATH 210")],
         ["canary: CHEM 115 went 2 -> 0 assignments",
          "canary: MATH 210 statuses all unreadable (parse drift?)"]),
        ("first run: no previous file, so nothing can have regressed",
         {}, [course("MATH 210")], [row("MATH 210"), row("MATH 210"), row("MATH 210")],
         []),
    ]
    for label, prev, courses_out, rows, expected in canary_cases:
        got = canary_findings(prev, courses_out, rows, tracked_codes)
        ok = got == expected
        failures += 0 if ok else 1
        print(f"{'ok  ' if ok else 'FAIL'} canary_findings [{label}] -> {got!r} (want {expected!r})")

    print(f"self-test: {'PASS' if failures == 0 else str(failures) + ' FAILURE(S)'}")
    return 0 if failures == 0 else 1


def setup() -> int:
    """Interactive: prompt for Gradescope email + password (hidden), DPAPI-seal the
    password into gradescope-credentials.json, then VALIDATE by logging in once.

    Exit codes: 0 sealed + login verified; 5 sealed but the login was refused
    (file kept -- re-run to correct); 1 anything else. A refusal prints
    login_failure_hint(), which says whether Gradescope really rejected the pair
    or the login page itself moved -- the second one is not the user's fault and
    re-running --setup will not fix it.
    """
    import getpass

    # The whole address, always. Gradescope accounts are frequently not at the
    # institution's domain, so there is nothing sensible to default to and
    # guessing one only produces a confusing authentication failure.
    email = input("Gradescope email (the whole address you log in with): ").strip()
    if "@" not in email:
        print("That does not look like an email address.", file=sys.stderr)
        return 1
    password = getpass.getpass("Gradescope password (input hidden): ")
    if not password:
        print("No password entered.", file=sys.stderr)
        return 1
    body = {
        "email": email,
        "dpapiPassword": dpapi_encrypt(password),
        "savedAt": datetime.now(timezone.utc).isoformat(),
    }
    CREDS.write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8")
    print(f"Sealed to {CREDS.name} (DPAPI, this Windows account only).")
    print("Validating login...")
    try:
        from gradescopeapi.classes.connection import GSConnection
    except ImportError:
        print("gradescopeapi not installed: python -m pip install gradescopeapi", file=sys.stderr)
        return 1
    conn = GSConnection()
    try:
        conn.login(email, password)
    except ValueError:
        print(f"Login refused: {login_failure_hint()}. File saved.", file=sys.stderr)
        return 5
    except Exception as e:
        print(f"Could not validate ({e}); file saved anyway.", file=sys.stderr)
        return 1
    student = (conn.account.get_courses() or {}).get("student") or {}
    print(f"Login OK - {len(student)} student course(s) visible. Gradescope is live from the next run.")
    return 0


def parse_term(argv) -> tuple:
    """--term "Fall 2026" -> ("Fall", "2026"). Absent or unparseable -> the clock.

    The label is what Gradescope itself shows on a course card, so a user can
    copy it verbatim rather than learning our spelling of it. Anything we cannot
    read falls back to the current semester rather than filtering everything out:
    a typo in a config file must not silently empty the gradebook.
    """
    import re

    now = datetime.now()
    default = ("Fall" if now.month >= 8 else ("Summer" if now.month >= 5 else "Spring"), str(now.year))
    if "--term" not in argv:
        return default
    i = argv.index("--term")
    raw = argv[i + 1] if i + 1 < len(argv) else ""
    m = re.search(r"(spring|summer|fall|winter)\D*(\d{4})", str(raw), re.I)
    if not m:
        print(f"--term {raw!r} not understood; using {default[0]} {default[1]}", file=sys.stderr)
        return default
    return (m.group(1).capitalize(), m.group(2))


def main() -> int:
    argv = sys.argv[1:]
    if "--check" in argv:
        return check()
    if "--self-test" in argv:
        return self_test()
    if "--setup" in argv:
        return setup()

    # --json prints the payload on stdout and writes nothing. That is how the
    # connector calls it: the connector owns where data lives for a given run,
    # and a subprocess writing into a directory it guessed at is a bug waiting
    # to happen.
    to_stdout = "--json" in argv

    if not CREDS.exists():
        if to_stdout:
            print(json.dumps({"generatedAt": datetime.now(timezone.utc).isoformat(),
                              "courses": [], "assignments": [],
                              "errors": ["no credentials file; the connector is dormant"]}))
            return 0
        print("no credentials file; skipping")
        return 0
    try:
        from gradescopeapi.classes.connection import GSConnection
    except ImportError:
        print("gradescopeapi not installed: python -m pip install gradescopeapi", file=sys.stderr)
        return 1

    try:
        email, password = load_credentials()
    except Exception as e:
        print(f"credentials: {e}", file=sys.stderr)
        return 1
    conn = GSConnection()
    try:
        conn.login(email, password)
    except ValueError:
        # One exception, two opposite fixes -- probe_login_form() tells them apart.
        print(login_failure_hint(), file=sys.stderr)
        return 1

    # Read the OUTGOING file's per-course counts before anything can overwrite it;
    # this is the canary's only baseline.
    prev_counts = prev_assignment_counts()
    tracked = load_tracked_courses()
    # Sep -> "Fall" etc., matching Gradescope's semester strings. Used only to
    # keep an UNTRACKED course from a finished term out of the payload -- last
    # term's course will happily hand back a dozen stale assignments otherwise.
    # Tracked courses are kept unconditionally.
    #
    # --term overrides the clock. The clock is wrong for anybody on a quarter
    # system, in a summer term, or reading last term's gradebook in January, and
    # it is what makes one course code taken twice ambiguous. The connector
    # passes connectors.grades.gradescope.termLabel through as --term.
    this_sem, this_year = parse_term(argv)
    errors = []
    courses_out = []
    assignments = []
    skipped = 0

    all_courses = conn.account.get_courses() or {}
    for course_id, course in (all_courses.get("student") or {}).items():
        short = getattr(course, "name", "") or ""
        full = getattr(course, "full_name", "") or ""
        year = str(getattr(course, "year", "") or "")
        semester = str(getattr(course, "semester", "") or "")
        key = course_code_key(short) or course_code_key(full)
        # Keep a course when it is one we are tracking, or when it is from the
        # CURRENT term (so a new course shows up before config.json knows about
        # it, without dragging a finished term's courses along).
        if key not in tracked and not (year == this_year and semester == this_sem):
            skipped += 1
            continue
        code = tracked.get(key, short or full)
        courses_out.append({
            "id": str(course_id), "name": short, "fullName": full,
            "semester": semester, "year": year, "code": code,
        })
        try:
            rows = conn.account.get_assignments(str(course_id)) or []
        except Exception as e:  # one course failing must not kill the rest
            errors.append(f"course {course_id} ({code}): {e}")
            print(f"course {course_id}: {e}", file=sys.stderr)
            continue
        for a in rows:
            grade = as_float(getattr(a, "grade", None))
            status = getattr(a, "submissions_status", None)
            assignment_id = getattr(a, "assignment_id", None)
            url = f"https://www.gradescope.com/courses/{course_id}"
            if assignment_id:
                url += f"/assignments/{assignment_id}"
            assignments.append({
                "courseCode": code,
                "courseId": str(course_id),
                "name": getattr(a, "name", "") or "",
                "assignmentId": str(assignment_id) if assignment_id else None,
                "due": iso(getattr(a, "due_date", None)),
                "releaseAt": iso(getattr(a, "release_date", None)),
                "lateDue": iso(getattr(a, "late_due_date", None)),
                "submitted": submission_state(status, grade),
                "status": normalize_status(status) or None,
                "grade": grade,
                "maxGrade": as_float(getattr(a, "max_grade", None)),
                "url": url,
            })

    # Logged in fine but a course that had work came back empty? That is a
    # failure, not an empty agenda. The findings ride along in errors[] so the
    # payload explains itself, and the non-zero exit makes the caller shout.
    findings = canary_findings(prev_counts, courses_out, assignments, tracked.values())
    errors.extend(findings)

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "term": {"filter": f"tracked courses or {this_sem} {this_year}", "kept": len(courses_out), "skipped": skipped},
        "courses": courses_out,
        "assignments": assignments,
        "errors": errors,
    }
    done = sum(1 for a in assignments if a["submitted"] is True)
    dated = sum(1 for a in assignments if a["due"])
    if to_stdout:
        print(json.dumps(payload))
    else:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(payload, indent=1), encoding="utf-8")
        print(
            f"wrote {OUT.name}: {len(assignments)} assignments across {len(courses_out)} courses "
            f"({dated} dated, {done} submitted, {len(errors)} errors)"
        )
    for finding in findings:
        print(finding, file=sys.stderr)
    # Exit 1 on a canary hit: the cycle runs WITHOUT Gradescope data rather than
    # with data that quietly says "nothing is due". Loud is the point.
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
