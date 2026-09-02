// The Gradescope shim's four preconditions and the one argument it passes on.
//
// The Python adapter is where the real work happens and it has its own
// `--self-test`. What is pinned here is the JavaScript half: that "ready" means
// the same thing to `collect()` and to `healthCheck()` (they share `precheck`),
// and that the term label a user configures actually reaches the adapter.
// A configured key that reaches nothing is worse than no key at all: the user
// believes they have disambiguated two terms and they have not.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/lib/config.mjs";
import { adapterArgs, precheck } from "../src/connectors/grades-gradescope.mjs";

const withGradescope = (over) => ({
  ...DEFAULTS,
  connectors: {
    ...DEFAULTS.connectors,
    grades: { gradescope: { ...DEFAULTS.connectors.grades.gradescope, ...over } },
  },
});

test("adapterArgs passes termLabel through as --term, so the clock stops deciding", () => {
  assert.deepEqual(adapterArgs(withGradescope({ termLabel: "Fall 2026" })), ["--term", "Fall 2026"]);
});

test("adapterArgs sends nothing when no term is configured", () => {
  assert.deepEqual(adapterArgs(withGradescope({ termLabel: null })), []);
  assert.deepEqual(adapterArgs(withGradescope({ termLabel: "   " })), []);
  assert.deepEqual(adapterArgs({}), [], "a config with no gradescope block at all is not an error");
});

test("precheck refuses a disabled connector first, before touching Python", () => {
  const blocked = precheck({ cfg: withGradescope({ enabled: false }), exec: () => assert.fail("must not run Python") });
  assert.equal(blocked.step, "enabled");
  assert.match(blocked.fix, /extras\/gradescope\/README\.md/);
});

test("precheck names the Python command it could not run, because that is the fix", () => {
  const blocked = precheck({
    cfg: withGradescope({ enabled: true, python: "python3.12" }),
    exec: () => {
      throw new Error("spawn python3.12 ENOENT");
    },
  });
  assert.equal(blocked.step, "python");
  assert.match(blocked.detail, /python3\.12/);
  assert.match(blocked.fix, /connectors\.grades\.gradescope\.python/);
});
