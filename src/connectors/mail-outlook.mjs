// mail-outlook.mjs -- a deterministic Outlook pre-filter.
//
// OPTIONAL, AND OFF BY DEFAULT. This connector needs Windows and a running copy
// of classic Outlook, which most people do not have. Everything else in the
// pipeline works without it; the mail panel simply hides itself.
//
// Pulls the last N days of Inbox (plus a tightly-bounded set of older unread
// mail from people who matter) straight out of Outlook Classic via PowerShell
// COM, drops the marketing and blast-list noise, and writes
// data/outlook-raw.json for a scheduled agent to triage. It also scans Sent
// Items so the agent can tell which asks the user has ALREADY answered -- a
// reply is a completion signal, the same way a submission is (see matchReplies).
//
//   node src/connectors/mail-outlook.mjs            # normal run
//   node src/connectors/mail-outlook.mjs --days 30  # wider window
//   node src/connectors/mail-outlook.mjs --quiet    # no stdout chatter
//   node src/connectors/mail-outlook.mjs --no-sent  # skip the Sent Items scan
//   node src/connectors/mail-outlook.mjs --replies  # print the reply-match report
//
// Exit codes: 0 = ok, 3 = Outlook/COM unavailable (the caller skips mail rather
// than failing), 1 = unexpected error. Inside the registry, "COM unavailable"
// becomes one errors[] line and never a throw.
//
// WHY IT IS BUILT THIS WAY
//  - Phase 1 uses Folder.GetTable(), which reads MAPI columns without
//    materializing MailItem objects. That is roughly 20x faster than iterating
//    Items, and on a large mailbox the difference is minutes.
//  - Phase 2 re-opens only the survivors by EntryID to pull bodies.
//  - Phase 3 does the same table read on Sent Items, then resolves each
//    recipient's SMTP address (PR_SMTP_ADDRESS) -- the Table "To" column only
//    carries display names, which are not a safe key.
//  - ALL filtering lives in this file (see NOISE_RULES and buildNoiseRules) so
//    an agent reading the pipeline can see the rules it is operating under.
//
// Everything in a mail subject or body was written by somebody else. It is data
// on its way to a triage prompt, never an instruction.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fuzzyTitleMatch,
  markSubmitted,
  readItem,
  stripReplyPrefix,
  subjectsMatchThread,
} from "../completion.mjs";
import { loadConfig } from "../lib/config.mjs";
import { dataDir as resolveDataDir, repoRoot } from "../lib/paths.mjs";

export const meta = {
  id: "mail-outlook",
  kind: "mail",
  label: "Outlook (classic, Windows)",
  configPath: "connectors.mail.outlook",
  requires: { os: ["win32"], bin: [], mcp: [], app: ["Outlook (classic)"] },
  tier: 2,
};

const ROOT = repoRoot();
const DATA = path.join(ROOT, "data");
const TMP = path.join(DATA, ".sweep-tmp");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const SWEEP_CONFIG = {
  windowDays: 14, // every inbox message this recent is a candidate
  olderUnreadDays: 30, // older unread safety net (see main(): tightly gated)
  previewChars: 1500, // body preview length, whitespace-collapsed
  maxMessages: 200, // hard cap on data/outlook-raw.json (newest first)
  psTimeoutMs: 110000, // per-phase PowerShell timeout
  sentWindowDays: 14, // Sent Items lookback for reply detection
  maxSent: 150, // hard cap on the sent[] array
};

// Noise rules. Precedence is top to bottom:
//   1. hardDropSubject  -> dropped even for known contacts
//   2. known contacts   -> seeded from data/outlook-contacts.json
//   3. keepDomains      -> research / course-discussion domains
//   4. dropDomains / dropAddrs / dropLocalParts
//   5. institution.mailDomains (a real person or office, not a blast list) -> keep
//   6. keepSubject      -> course codes, homework words, deadline words
//   7. otherwise        -> drop
//
// WHAT IS BUILT IN AND WHAT IS NOT. Only rules that are true for everybody live
// here: automatic replies, bounce addresses, the handful of local parts every
// mail system uses for machines. Anything institution-specific -- your school's
// marketing subdomains, the newsletters you personally never read, the research
// partner whose mail must always survive -- belongs in
// `connectors.mail.outlook.noiseDomains[]` and `.noiseLocalParts[]`, because
// one person's spam is another person's advisor. buildNoiseRules() merges the
// two.
export const NOISE_RULES = {
  // 1. Pure churn, never worth a token.
  hardDropSubject: [
    /^activity summary for /i, // an LMS daily digest; the LMS sweep already has this
    /^submission receipt$/i, // an LMS upload confirmation; the sweep tracks submitted state
    /^automatic reply:/i,
    /^undeliverable:/i,
    /you have messages in quarantine/i,
  ],

  // 3. Always keep, whatever the subject says. Add the course-discussion and
  // grading services your school actually uses, through
  // `connectors.mail.outlook.keepDomains` - real homework details arrive
  // through them, and a subject line alone cannot tell them from a newsletter.
  keepDomains: [],

  // 4a. Bulk senders by domain. Universal offenders only.
  dropDomains: ["linkedin.com", "e.linkedin.com", "indeed.com", "glassdoor.com", "mailchimp.com", "substack.com"],

  // 4b. Machine senders, matched on the local part. Every mail system has these.
  dropLocalParts: ["noreply", "no-reply", "donotreply", "do-not-reply", "mailer-daemon", "bounce", "notifications"],

  // 4c. One-off addresses worth silencing.
  dropAddrs: [],

  // 6. Rescue anything that smells like coursework even from an unknown sender.
  // The course-code pattern is added by buildNoiseRules() from your own courses.
  keepSubject: [
    /\b(hw|homework|assignment|problem set|pset|project|exam|midterm|quiz|lab report)\b/i,
    /\b(due|deadline|submit by|reply by|rsvp)\b/i,
    /\b(reassessment|standard|sitting)\b/i,
  ],
};

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const domainOf = (addr) => String(addr || "").toLowerCase().split("@")[1] || "";
const localOf = (addr) => String(addr || "").toLowerCase().split("@")[0] || "";
const matchesAny = (patterns, text) => patterns.some((re) => re.test(text || ""));
const domainIn = (list, addr) => {
  const d = domainOf(addr);
  return list.some((x) => d === x || d.endsWith("." + x));
};

const strings = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : []);

/**
 * Build a regex that matches any CURRENT course code, in the forms professors
 * actually use ("MATH 210", "MATH21000", "CHEM-115", "ART 101").
 *
 * It gates the older-unread safety net, so last term's mail cannot leak back in
 * when this term's course list changes. With no courses configured it matches
 * nothing, which is the safe direction: the net simply stays closed.
 */
export function currentCourseRe(cfg) {
  const codes = (Array.isArray(cfg?.courses) ? cfg.courses : [])
    .map((c) => String(c?.code || ""))
    .filter(Boolean);
  if (!codes.length) return /$^/;
  const alts = codes.flatMap((code) => {
    const [dept, num] = code.split(/\s+/);
    if (!dept || !num) return [];
    return [`${dept}\\s*-?\\s*${num}(?:00)?`];
  });
  if (!alts.length) return /$^/;
  return new RegExp(`\\b(?:${alts.join("|")})\\b`, "i");
}

/**
 * The built-in rules plus everything this user put in their config. Pure: it
 * returns a new rules object and never touches NOISE_RULES.
 */
export function buildNoiseRules(cfg) {
  const own = cfg?.connectors?.mail?.outlook ?? {};
  const courseRe = currentCourseRe(cfg);
  return {
    ...NOISE_RULES,
    dropDomains: [...NOISE_RULES.dropDomains, ...strings(own.noiseDomains)],
    dropLocalParts: [...NOISE_RULES.dropLocalParts, ...strings(own.noiseLocalParts)],
    keepDomains: [...NOISE_RULES.keepDomains, ...strings(own.keepDomains)],
    dropAddrs: [...NOISE_RULES.dropAddrs, ...strings(own.dropAddrs)],
    keepSubject: [courseRe, ...NOISE_RULES.keepSubject],
    // Rule 5: mail from your own institution is from a person or an office
    // until proven otherwise, so it survives an unrecognised subject.
    personDomains: strings(cfg?.institution?.mailDomains),
  };
}

/**
 * Stable identity for a message across runs, usable from BOTH data/outlook-raw.json
 * (which has entryId) and data/outlook-mail.json (which does not -- the PAYLOAD v2 Mail
 * shape has no id field). Lets the scheduled agent tell "already triaged last run" from
 * "new since last run" without inventing a field the contract does not allow.
 */
export const mailKey = (m) =>
  `${String(m.addr || "").toLowerCase()}|${String(m.subj || "").trim()}|${m.recv}`;

/** Addresses+subjects the previous run already surfaced in data/outlook-mail.json. */
function loadAlreadySurfaced(dataDir = DATA) {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(dataDir, "outlook-mail.json"), "utf8"));
    return new Set((prev.mail || []).map(mailKey));
  } catch {
    return new Set();
  }
}

/** Previous run's triage output, used as the input to reply matching. */
function loadPreviousTriage(dataDir = DATA) {
  const read = (file, key) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf8"));
      return Array.isArray(parsed[key]) ? parsed[key] : [];
    } catch {
      return [];
    }
  };
  return { items: read("outlook-items.json", "items"), mail: read("outlook-mail.json", "mail") };
}

/** Load the contacts file as a Map of lowercase address -> tag. These always pass. */
export function loadKnownAddrs(dataDir = DATA) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "outlook-contacts.json"), "utf8"));
    return new Map(
      (raw.contacts || [])
        .map((c) => [String(c.addr || "").toLowerCase(), String(c.tag || "other")])
        .filter(([a]) => a),
    );
  } catch {
    return new Map();
  }
}

/**
 * Decide whether one message survives the noise filter.
 * Returns {keep: boolean, why: string} -- `why` is the rule that decided it.
 * PURE: it reads nothing but its arguments.
 */
export function classify(msg, knownAddrs = new Map(), rules = NOISE_RULES) {
  const addr = String(msg.addr || "").toLowerCase();
  const subj = msg.subj || "";
  const personDomains = rules.personDomains ?? [];

  if (matchesAny(rules.hardDropSubject, subj)) return { keep: false, why: "hardDropSubject" };
  if (knownAddrs.has(addr)) return { keep: true, why: "knownContact" };
  if (domainIn(rules.keepDomains, addr)) return { keep: true, why: "keepDomain" };
  if (rules.dropAddrs.includes(addr)) return { keep: false, why: "dropAddr" };
  if (domainIn(rules.dropDomains, addr)) return { keep: false, why: "dropDomain" };
  if (rules.dropLocalParts.includes(localOf(addr))) return { keep: false, why: "dropLocalPart" };
  if (personDomains.length && domainIn(personDomains, addr)) return { keep: true, why: "institutionPerson" };
  if (matchesAny(rules.keepSubject, subj)) return { keep: true, why: "keepSubject" };
  return { keep: false, why: "unmatched" };
}

// ---------------------------------------------------------------------------
// PowerShell COM bridge
// ---------------------------------------------------------------------------

function runPs(script, label) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `${label}.ps1`);
  fs.writeFileSync(file, script, "utf8");
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
    { encoding: "utf8", timeout: SWEEP_CONFIG.psTimeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label}: exit ${res.status} ${(res.stderr || "").slice(0, 400)}`);
  return res;
}

function readJsonOut(file) {
  const txt = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (!txt) return [];
  const parsed = JSON.parse(txt);
  return Array.isArray(parsed) ? parsed : [parsed];
}

const psDate = (d) =>
  `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Phase 1: fast MAPI table read -- metadata only, no MailItem materialization. */
function fetchHeaders(days, olderUnreadDays) {
  const outFile = path.join(TMP, "headers.json").replace(/\\/g, "\\\\");
  const now = new Date();
  const recentCut = psDate(new Date(now.getTime() - days * 86400000));
  const oldCut = psDate(new Date(now.getTime() - olderUnreadDays * 86400000));
  const script = `
$ErrorActionPreference = "Stop"
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")
$inbox = $ns.GetDefaultFolder(6)
$SMTP = "http://schemas.microsoft.com/mapi/proptag/0x5D01001F"
function Read-Table($filter) {
  $t = $inbox.GetTable($filter)
  $t.Columns.RemoveAll()
  [void]$t.Columns.Add("EntryID")
  [void]$t.Columns.Add("SenderName")
  [void]$t.Columns.Add("Subject")
  [void]$t.Columns.Add("ReceivedTime")
  [void]$t.Columns.Add("UnRead")
  [void]$t.Columns.Add($SMTP)
  $acc = New-Object System.Collections.ArrayList
  while (-not $t.EndOfTable) {
    $r = $t.GetNextRow()
    [void]$acc.Add([PSCustomObject]@{
      entryId = $r.Item(1); from = $r.Item(2); subj = $r.Item(3)
      recv = (Get-Date $r.Item(4)).ToString("o"); unread = [bool]$r.Item(5); addr = $r.Item(6)
    })
  }
  return $acc
}
$rows = New-Object System.Collections.ArrayList
foreach ($x in (Read-Table "[ReceivedTime] >= '${recentCut}'")) { [void]$rows.Add($x) }
foreach ($x in (Read-Table "[UnRead] = True AND [ReceivedTime] >= '${oldCut}' AND [ReceivedTime] < '${recentCut}'")) { [void]$rows.Add($x) }
ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress | Out-File -FilePath "${outFile}" -Encoding utf8
`;
  runPs(script, "headers");
  return readJsonOut(path.join(TMP, "headers.json"));
}

/** Phase 2: re-open the survivors by EntryID and pull bodies. */
function fetchBodies(entryIds) {
  if (!entryIds.length) return {};
  const idFile = path.join(TMP, "ids.json");
  fs.writeFileSync(idFile, JSON.stringify(entryIds), "utf8");
  const outFile = path.join(TMP, "bodies.json").replace(/\\/g, "\\\\");
  const inFile = idFile.replace(/\\/g, "\\\\");
  const script = `
$ErrorActionPreference = "Stop"
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")
$ids = Get-Content -Raw -Path "${inFile}" | ConvertFrom-Json
$acc = New-Object System.Collections.ArrayList
foreach ($id in $ids) {
  try {
    $m = $ns.GetItemFromID($id)
    $b = $m.Body
    if ($b -and $b.Length -gt 6000) { $b = $b.Substring(0, 6000) }
    [void]$acc.Add([PSCustomObject]@{ entryId = $id; body = $b; to = $m.To })
  } catch {
    [void]$acc.Add([PSCustomObject]@{ entryId = $id; body = ""; to = "" })
  }
}
ConvertTo-Json -InputObject @($acc) -Depth 3 -Compress | Out-File -FilePath "${outFile}" -Encoding utf8
`;
  runPs(script, "bodies");
  const rows = readJsonOut(path.join(TMP, "bodies.json"));
  return Object.fromEntries(rows.map((r) => [r.entryId, r]));
}

/**
 * Phase 3: Sent Items. Same fast table read, then a per-message recipient pass.
 *
 * The Table "To" column is display names only ("A. Mentor; J. Peer"), which
 * cannot be matched against a sender address, so each row is re-opened by EntryID and
 * every recipient is resolved through PR_SMTP_ADDRESS (0x39FE001F), falling back to
 * Recipient.Address. The window is short and the cap is low, so this is a handful of
 * items per run -- and no bodies are read here at all.
 */
function fetchSent(days, cap) {
  const outFile = path.join(TMP, "sent.json").replace(/\\/g, "\\\\");
  const cut = psDate(new Date(Date.now() - days * 86400000));
  const script = `
$ErrorActionPreference = "Stop"
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace("MAPI")
$sent = $ns.GetDefaultFolder(5)   # olFolderSentMail
$PR_SMTP = "http://schemas.microsoft.com/mapi/proptag/0x39FE001F"
# Some stores reject a [SentOn] restriction; the whole folder is small enough to
# read unfiltered, and JS re-applies the window either way.
try { $t = $sent.GetTable("[SentOn] >= '${cut}'") } catch { $t = $sent.GetTable() }
$t.Columns.RemoveAll()
[void]$t.Columns.Add("EntryID")
[void]$t.Columns.Add("Subject")
[void]$t.Columns.Add("SentOn")
[void]$t.Columns.Add("To")
$rows = New-Object System.Collections.ArrayList
while (-not $t.EndOfTable -and $rows.Count -lt ${cap}) {
  $r = $t.GetNextRow()
  $when = $null
  if ($r.Item(3)) { $when = (Get-Date $r.Item(3)).ToString("o") }
  [void]$rows.Add([PSCustomObject]@{ entryId = $r.Item(1); subj = $r.Item(2); sentAt = $when; toNames = $r.Item(4) })
}
$acc = New-Object System.Collections.ArrayList
foreach ($row in $rows) {
  $addrs = New-Object System.Collections.ArrayList
  try {
    $m = $ns.GetItemFromID($row.entryId)
    foreach ($rcp in $m.Recipients) {
      $a = $null
      try { $a = $rcp.PropertyAccessor.GetProperty($PR_SMTP) } catch { $a = $null }
      if (-not $a) { $a = $rcp.Address }
      if ($a -and ("$a").Contains("@")) { [void]$addrs.Add(("$a").ToLower()) }
    }
  } catch { }
  [void]$acc.Add([PSCustomObject]@{
    entryId = $row.entryId; subj = $row.subj; sentAt = $row.sentAt
    to = @($addrs); toNames = $row.toNames
  })
}
ConvertTo-Json -InputObject @($acc) -Depth 4 -Compress | Out-File -FilePath "${outFile}" -Encoding utf8
`;
  runPs(script, "sent");
  const cutMs = Date.now() - days * 86400000;
  return readJsonOut(path.join(TMP, "sent.json"))
    .filter((r) => r && r.entryId && r.sentAt)
    .map((r) => ({
      entryId: r.entryId,
      to: (Array.isArray(r.to) ? r.to : [r.to]).filter(Boolean).map((a) => String(a).toLowerCase()),
      toNames: String(r.toNames || ""),
      subj: r.subj || "",
      sentAt: new Date(r.sentAt).toISOString(),
    }))
    .filter((r) => new Date(r.sentAt).getTime() >= cutMs)
    .sort((a, b) => b.sentAt.localeCompare(a.sentAt))
    .slice(0, cap);
}

// ---------------------------------------------------------------------------
// Reply matching: a sent reply is a completion signal
// ---------------------------------------------------------------------------

/** "Dr. A. Mentor" -> "mentor"; "Records Office (Registrar)" -> "office". Display-name fallback key. */
function surnameToken(name) {
  const words = String(name || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Za-z ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^(dr|prof|mr|ms|mrs|the)$/i.test(w));
  return words.length ? words[words.length - 1].toLowerCase() : null;
}

/**
 * Did this sent message go to `addr`? Address overlap is the rule. The display-name
 * fallback fires ONLY when no SMTP address could be resolved at all (some legacy
 * X500 recipients), so a name collision can never override a real address mismatch.
 */
function recipientHit(sent, addr, fromName) {
  const a = String(addr || "").toLowerCase();
  if (a && sent.to.includes(a)) return "addr";
  if (sent.to.length === 0) {
    const surname = surnameToken(fromName);
    if (surname && sent.toNames.toLowerCase().includes(surname)) return "name";
  }
  return null;
}

/** The mail entry an outlook item was born from: hard reply-by first, then subject. */
function findSourceMail(view, mailList) {
  const dueMs = view.due ? Date.parse(view.due) : NaN;
  if (Number.isFinite(dueMs)) {
    const byDue = mailList.find((m) => m.replyBy && Date.parse(m.replyBy) === dueMs);
    if (byDue) return { mail: byDue, via: "replyBy" };
  }
  const bySubject = mailList.find((m) => fuzzyTitleMatch(view.title, stripReplyPrefix(m.subj)));
  return bySubject ? { mail: bySubject, via: "subject" } : null;
}

/**
 * Decide which mail asks and which mail-born items the user has already answered.
 *
 * PURE -- no I/O, no clock. A message counts as answered when ALL THREE hold:
 *   1. same thread   -- normalized subject match after stripping Re:/Fw: (normTitle folding)
 *   2. same person   -- a recipient of the reply is the sender of the original
 *   3. right order   -- the reply was sent strictly AFTER that message arrived
 *
 * Rule 3 is what stops "I replied last week" from closing a question somebody
 * asked yesterday. Without it, a long-running thread with a professor -- where
 * a reply from a fortnight ago shares the normalized subject of a message that
 * arrived this morning -- would silently mark this morning's ask as answered,
 * and the user would never see it. Ordering is the whole guard.
 *
 * Only `ty: "email"` items can be closed this way. A reply does not submit homework
 * and does not fill in a registration form, so task/homework/exam items are left alone.
 *
 * @param sentList  [{entryId, to:[addr], toNames, subj, sentAt}] from data/outlook-raw.json
 * @param items     data/outlook-items.json items (v2), or v1 snapshot items
 * @param mail      data/outlook-mail.json mail entries
 * @returns {{checked, answeredMail, answeredItems, items, unlinkedItems, candidates}}
 *          `items` is a NEW array with s:true on every answered email item.
 */
export function matchReplies(sentList, items, mail) {
  const sent = (sentList ?? [])
    .filter((s) => s && s.sentAt)
    .map((s) => ({
      entryId: s.entryId ?? null,
      subj: s.subj ?? "",
      sentAt: s.sentAt,
      sentMs: Date.parse(s.sentAt),
      to: (s.to ?? []).map((a) => String(a).toLowerCase()),
      toNames: String(s.toNames ?? ""),
    }))
    .filter((s) => Number.isFinite(s.sentMs));
  const mailList = (mail ?? []).filter(Boolean);
  const itemList = Array.isArray(items) ? items : [];

  const usedSent = new Set();
  const answeredMail = [];
  for (const m of mailList) {
    const recvMs = Date.parse(m.recv);
    if (!Number.isFinite(recvMs)) continue;
    const hits = sent
      .filter((s) => s.sentMs > recvMs)
      .filter((s) => recipientHit(s, m.addr, m.from))
      .filter((s) => subjectsMatchThread(s.subj, m.subj))
      .sort((a, b) => a.sentMs - b.sentMs);
    if (!hits.length) continue;
    const reply = hits[0];
    usedSent.add(reply.entryId);
    answeredMail.push({
      key: mailKey(m),
      id: m.id ?? null,
      from: m.from ?? "",
      addr: m.addr ?? "",
      subj: m.subj ?? "",
      recv: m.recv,
      tag: m.tag ?? null,
      hadAsk: !!m.ask,
      replyBy: m.replyBy ?? null,
      reply: { entryId: reply.entryId, subj: reply.subj, sentAt: reply.sentAt, to: reply.to },
    });
  }
  const answeredByKey = new Map(answeredMail.map((a) => [a.key, a]));

  const answeredIdx = new Map();
  const unlinkedItems = [];
  itemList.forEach((it, index) => {
    const view = readItem(it);
    if (view.type !== "email" || view.submitted === true) return;
    const link = findSourceMail(view, mailList);
    if (!link) {
      unlinkedItems.push({ k: view.key, t: view.title, d: view.due });
      return;
    }
    const answered = answeredByKey.get(mailKey(link.mail));
    if (!answered) return;
    answeredIdx.set(index, { ...answered, via: link.via });
  });

  const answeredItems = [...answeredIdx.entries()].map(([index, a]) => {
    const view = readItem(itemList[index]);
    return {
      k: view.key,
      t: view.title,
      d: view.due,
      via: a.via,
      mailSubj: a.subj,
      reply: a.reply,
    };
  });

  // Sent mail that reached someone we are tracking but answered nothing we know of.
  // Not a decision -- a hint for triage (the user may have replied under a new subject).
  const mailAddrs = new Set(mailList.map((m) => String(m.addr || "").toLowerCase()).filter(Boolean));
  const candidates = sent
    .filter((s) => !usedSent.has(s.entryId))
    .filter((s) => s.to.some((a) => mailAddrs.has(a)))
    .map((s) => ({
      entryId: s.entryId,
      subj: s.subj,
      sentAt: s.sentAt,
      to: s.to.filter((a) => mailAddrs.has(a)),
    }));

  return {
    checked: { sent: sent.length, items: itemList.length, mail: mailList.length },
    answeredMail,
    answeredItems,
    items: itemList.map((it, index) => (answeredIdx.has(index) ? markSubmitted(it) : it)),
    unlinkedItems,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function collapse(text, limit) {
  return String(text || "")
    .replace(/\r/g, " ")
    .replace(/https?:\/\/\S{60,}/g, "[link]") // tracking URLs eat the whole preview otherwise
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/**
 * The whole sweep, as a pure-ish function of its options: the caller supplies
 * the config and the data directory, so the registry path and the CLI path run
 * exactly the same code.
 *
 * Throws only when Outlook itself is unreachable. Everything softer -- a body
 * fetch that failed, a Sent Items scan that was refused -- is reported in the
 * returned payload and the sweep carries on.
 */
export function sweep({ cfg, dataDir = DATA, days, skipSent = false, log = () => {} }) {
  const window = Number(days) || SWEEP_CONFIG.windowDays;
  const rules = buildNoiseRules(cfg);
  const known = loadKnownAddrs(dataDir);
  log(`sweep: window ${window}d, ${known.size} known contacts`);

  const headers = fetchHeaders(window, Math.max(window, SWEEP_CONFIG.olderUnreadDays));

  // Older unread is a narrow safety net, not a second window. On a busy mailbox
  // "unread" on its own means nothing -- thousands of messages are unread and
  // always will be. Older mail survives only if it names a course being taken
  // this term or comes from a known human contact. Course-announcement
  // firehoses are deliberately excluded here: without that, last term's daily
  // digests flood the file every single run.
  const cutRecent = Date.now() - window * 86400000;
  const courseRe = currentCourseRe(cfg);
  const seen = new Set();
  const candidates = [];
  for (const h of headers) {
    if (!h || !h.entryId || seen.has(h.entryId)) continue;
    seen.add(h.entryId);
    const verdict = classify(h, known, rules);
    if (!verdict.keep) continue;
    if (new Date(h.recv).getTime() < cutRecent) {
      const tag = known.get(String(h.addr || "").toLowerCase());
      const humanContact = tag === "research" || tag === "admin" || tag === "other";
      if (!courseRe.test(h.subj || "") && !humanContact) continue;
    }
    candidates.push({ ...h, why: verdict.why });
  }
  candidates.sort((a, b) => String(b.recv).localeCompare(String(a.recv)));
  const kept = candidates.slice(0, SWEEP_CONFIG.maxMessages);
  log(`sweep: ${headers.length} scanned -> ${kept.length} kept`);

  let bodies = {};
  let bodyError = null;
  try {
    bodies = fetchBodies(kept.map((k) => k.entryId));
  } catch (err) {
    bodyError = err.message.slice(0, 300);
    log(`sweep: body fetch failed -- ${bodyError} (continuing with subjects only)`);
  }

  const surfaced = loadAlreadySurfaced(dataDir);
  const messages = kept.map((k) => {
    const msg = {
      entryId: k.entryId,
      from: k.from || "",
      addr: String(k.addr || "").toLowerCase(),
      subj: k.subj || "",
      recv: new Date(k.recv).toISOString(),
      unread: !!k.unread,
      preview: collapse(bodies[k.entryId]?.body, SWEEP_CONFIG.previewChars),
    };
    // true = a previous run already surfaced this message. An agent may still
    // re-triage it, but must NOT notify about it a second time.
    return { ...msg, seen: surfaced.has(mailKey(msg)) };
  });

  // Sent Items is never worth failing the sweep over. An empty sent[] means "no
  // reply evidence this run", which reads as UNKNOWN, not as "unanswered".
  let sent = [];
  let sentError = null;
  if (!skipSent) {
    try {
      sent = fetchSent(SWEEP_CONFIG.sentWindowDays, SWEEP_CONFIG.maxSent);
      log(`sweep: ${sent.length} sent messages in the last ${SWEEP_CONFIG.sentWindowDays}d`);
    } catch (err) {
      sentError = err.message.slice(0, 300);
      log(`sweep: sent scan failed -- ${sentError} (reply detection skipped)`);
    }
  }

  const prev = loadPreviousTriage(dataDir);
  const replies = matchReplies(sent, prev.items, prev.mail);
  if (replies.answeredItems.length || replies.answeredMail.length) {
    log(
      `sweep: replies -> ${replies.answeredItems.length} item(s) answered, ` +
      `${replies.answeredMail.length} mail thread(s) answered`,
    );
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }

  return {
    sweptAt: new Date().toISOString(),
    windowDays: window,
    scanned: headers.length,
    messages,
    sentWindowDays: SWEEP_CONFIG.sentWindowDays,
    bodyError,
    sentError,
    sent,
    replies,
  };
}

// -------------------------------------------------------- registry connector

/**
 * Mail that survived the filter, in the emission shape.
 *
 * `tag` and `gist` are deliberately coarse here: this connector is a PRE-filter,
 * and deciding what a message actually means is a job for a language model
 * reading data/outlook-raw.json, not for a regex. Everything lands as "info"
 * with an empty gist until something smarter fills them in.
 */
function toMail(msg) {
  return {
    id: msg.entryId ?? null,
    from: msg.from ?? "",
    addr: msg.addr ?? "",
    subj: msg.subj ?? "",
    recv: msg.recv,
    tag: "info",
    gist: "",
    ask: null,
    replyBy: null,
  };
}

export async function collect(ctx) {
  const own = ctx.cfg?.connectors?.mail?.outlook ?? {};
  let payload;
  try {
    payload = sweep({
      cfg: ctx.cfg,
      dataDir: ctx.dataDir,
      days: own.windowDays,
      skipSent: own.sentItemsScan === false,
      log: (msg) => ctx.log("info", msg),
    });
  } catch (err) {
    // Outlook not installed, not running, or COM refused. That is an ordinary
    // configuration on most machines, not a fault: one line, and the rest of
    // the agenda is built exactly as it would have been.
    return { mail: [], items: [], errors: [`${meta.id}: ${String(err.message).slice(0, 200)}`] };
  }

  try {
    fs.mkdirSync(ctx.dataDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.dataDir, "outlook-raw.json"), JSON.stringify(payload, null, 1), "utf8");
  } catch (err) {
    return { mail: payload.messages.map(toMail), items: [], errors: [`${meta.id}: could not write outlook-raw.json (${err.message})`] };
  }

  const errors = [];
  if (payload.bodyError) errors.push(`${meta.id}: body fetch failed (${payload.bodyError})`);
  if (payload.sentError) errors.push(`${meta.id}: sent scan failed, reply detection skipped (${payload.sentError})`);

  // Mail-derived deadline items are written by the triage step into
  // data/outlook-items.json, which scrape.mjs folds in separately. This
  // connector emits the mail itself and never invents a date for it.
  return { mail: payload.messages.map(toMail), items: [], errors };
}

export async function healthCheck(ctx) {
  void ctx;
  const fix = "start classic Outlook and sign in, then re-run; or set connectors.mail.outlook.enabled to false - mail is optional";
  if (process.platform !== "win32") {
    return { ok: false, detail: "this connector needs Windows and classic Outlook", fix: "set connectors.mail.outlook.enabled to false; everything else works without it" };
  }
  try {
    const rows = fetchHeaders(1, 1);
    return { ok: true, detail: `Outlook answered (${rows.length} message(s) in the last day)`, fix: null };
  } catch (err) {
    return { ok: false, detail: String(err.message).slice(0, 200), fix };
  }
}

// ---------------------------------------------------------------------- main

function main() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes("--quiet");
  const showReplies = argv.includes("--replies");
  const skipSent = argv.includes("--no-sent");
  const dIdx = argv.indexOf("--days");
  const days = dIdx >= 0 ? Number(argv[dIdx + 1]) || SWEEP_CONFIG.windowDays : SWEEP_CONFIG.windowDays;
  const log = (...a) => { if (!quiet) console.log(...a); };

  const cfg = loadConfig(null, { argv });
  const dataDir = resolveDataDir(argv, ROOT);

  let payload;
  try {
    payload = sweep({ cfg, dataDir, days, skipSent, log: (m) => log(m) });
  } catch (err) {
    console.error(`mail-outlook: Outlook unavailable -- ${err.message}`);
    process.exit(3);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "outlook-raw.json"), JSON.stringify(payload, null, 1), "utf8");
  log(`sweep: wrote outlook-raw.json (${payload.messages.length} messages, ${payload.sent.length} sent)`);
  if (showReplies) console.log(JSON.stringify(payload.replies, null, 1));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
