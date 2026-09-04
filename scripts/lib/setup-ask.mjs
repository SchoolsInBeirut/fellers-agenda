// ===========================================================================
//  setup-ask.mjs - asking, with the terminal injected
// ===========================================================================
//
//  Every function here takes its input source as an argument rather than
//  reaching for `process.stdin`, which is what makes the wizard's question flow
//  testable: a test passes a canned asker and gets the same validation, the
//  same re-prompting and the same give-up behaviour a person would.
//
//  THE BOUNDED RETRY IS NOT DECORATION. Under `--yes` the asker always returns
//  the fallback, so a validated question whose fallback does not pass its own
//  validator would loop forever printing one complaint. Every loop here is
//  bounded and returns `null` when it gives up, so the caller decides what a
//  give-up means rather than the wizard hanging.
// ===========================================================================

/** How many times a validated question re-asks before returning null. */
export const TRIES = 5;

/**
 * Thrown when stdin ends while a question is still on screen - Ctrl+D, a
 * closed pipe, a terminal that went away. It is NOT a normal answer and must
 * never be treated as one: the wizard stops, and the caller maps it to a
 * prerequisite failure.
 */
export class SetupEofError extends Error {
  constructor(message = "stdin ended before the question was answered") {
    super(message);
    this.name = "SetupEofError";
  }
}

/**
 * Is there a terminal to ask questions in?
 *
 * `SETUP_FAKE_TTY` is read HERE and nowhere else. It exists so the EOF path
 * above can be tested from a spawned process, which by construction has no
 * real TTY - without it, the "no terminal" guard fires first and the bug is
 * unreachable from a test. It only ever makes the wizard ask MORE questions,
 * so it cannot skip a prompt or a confirmation.
 */
export const hasTty = (stdin = process.stdin, env = process.env) =>
  Boolean(stdin?.isTTY) || env?.SETUP_FAKE_TTY === "1";

/**
 * One question, with the terminal's own end-of-input wired in.
 *
 * `readline/promises`' `question()` resolves when a line arrives and does
 * NOTHING when the stream closes first: the promise stays pending forever, the
 * `await` never returns, and `main()`'s `finally` never runs. Node then sees an
 * event loop with nothing left in it and exits 0 - a wizard that wrote no
 * files, printed no error, and reported success. So the `close` event is the
 * other half of the race, and it rejects.
 */
function askOnce(rl, prompt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn) => (v) => {
      if (settled) return;
      settled = true;
      rl.off?.("close", onClose);
      fn(v);
    };
    const onClose = () => done(reject)(new SetupEofError());
    rl.once?.("close", onClose);
    Promise.resolve(rl.question(prompt)).then(done(resolve), done(reject));
  });
}

/**
 * The asker the wizard uses.
 *
 * @param {{question: (q: string) => Promise<string>}|null} rl
 *   a `node:readline/promises` interface, or null to accept every fallback
 *   without printing anything - which is exactly what `--yes` wants.
 */
export function makeAsk(rl) {
  return async function ask(question, fallback = "") {
    if (!rl) return fallback;
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = String(await askOnce(rl, `      ${question}${suffix}\n      > `)).trim();
    return answer || fallback;
  };
}

/** A y/n question. Anything starting with y is yes; everything else is no. */
export const yesNo = async (ask, question, fallback = "n") => /^y/i.test(String(await ask(`${question} (y/n)`, fallback)));

/**
 * Ask until `ok(answer)` holds, at most TRIES times. Returns the accepted
 * answer, or null when it gave up.
 *
 * @param {(q:string, f:string)=>Promise<string>} ask
 * @param {(a:string)=>boolean} ok
 * @param {(a:string)=>string} complaint  what to print about a rejected answer
 * @param {(s:string)=>void} [log]
 */
export async function askUntil(ask, question, fallback, ok, complaint, log = console.log) {
  for (let i = 0; i < TRIES; i += 1) {
    const answer = String(await ask(question, fallback)).trim().toLowerCase();
    if (ok(answer)) return answer;
    log(`      ${complaint(answer)}`);
  }
  return null;
}

/** `askUntil` for a closed set of answers. */
export const askChoice = (ask, question, choices, fallback, log) =>
  askUntil(
    ask,
    `${question} (${choices.join(" / ")})`,
    fallback,
    (a) => choices.includes(a),
    (a) => `"${a}" is not one of ${choices.join(", ")}. Try again.`,
    log,
  );
