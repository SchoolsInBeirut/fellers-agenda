// Normalize, dedupe, classify, and diff agenda items. Pure functions only.

const TYPE_PATTERNS = [
  [/\b(exam|midterm|final)\b/i, "exam"],
  [/\b(project|report|paper|presentation)\b/i, "project"],
  [/\blab\b/i, "lab"],
  [/\b(quiz)\b/i, "quiz"],
  [/\b(hw|homework|assignment|problem set|pset)\b/i, "homework"],
];

export function classifyType(title, sourceType) {
  for (const [re, type] of TYPE_PATTERNS) if (re.test(title)) return type;
  if (sourceType === "quiz") return "quiz";
  if (sourceType === "dropbox") return "homework";
  return "other";
}

export function normTitle(title) {
  return (title ?? "")
    .toLowerCase()
    .replace(/\b(due|closes?|opens?|available|submission|dropbox)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Combine submission evidence for one deliverable seen through two sources.
 * Ranking is deliberate: true (proof of completion) outranks false (proof of
 * non-submission) outranks null (nothing observed). A source that saw nothing
 * must never be able to erase a source that saw a finished attempt or a grade.
 */
export function mergeSubmitted(a, b) {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return null;
}

/**
 * Index one course's gradebook rows by normalized item title.
 * Category rollups ("Homeworks", "Asynchronous Quizzes") land in here too, but
 * they never collide with real items because matching is exact - see applyGrades.
 */
export function gradeIndex(rows) {
  const idx = new Map();
  for (const row of rows ?? []) {
    const key = normTitle(row?.name ?? "");
    if (key) idx.set(key, row);
  }
  return idx;
}

/**
 * A posted grade is the only completion signal D2L reliably gives a student:
 * the quiz endpoint reports attemptsUsed:0 / bestScore:null even for quizzes
 * that have already been graded (verified on ART 101, 2026-08-31). So a grade
 * with points earned promotes an item to submitted:true.
 *
 * Matching is EXACT on the normalized title, never fuzzy: titlesMatch() would
 * happily let the grade for "Homework 1" claim "Homework 10". A 0-point grade
 * is ignored because it cannot distinguish "never turned in" from "did badly".
 *
 * @param items            agenda items
 * @param indexByCourseId  Map<courseId, Map<normTitle, gradeRow>>
 */
export function applyGrades(items, indexByCourseId) {
  if (!indexByCourseId || indexByCourseId.size === 0) return items;
  return items.map((item) => {
    const row = indexByCourseId.get(item.courseId)?.get(normTitle(item.title));
    if (!row) return item;
    const earned = typeof row.pointsNumerator === "number" && row.pointsNumerator > 0;
    if (!earned) return item;
    return {
      ...item,
      submitted: mergeSubmitted(item.submitted, true),
      sources: [...new Set([...item.sources, "grade"])],
      grade: row.displayGrade ?? null,
    };
  });
}

function titlesMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const setA = new Set(a.split(" "));
  const setB = new Set(b.split(" "));
  const inter = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 && inter / union >= 0.6;
}

/** Merge items that refer to the same deliverable (same course, same due time, similar title). */
export function dedupe(items) {
  const out = [];
  for (const item of items) {
    const match = out.find(
      (o) =>
        o.courseId === item.courseId &&
        o.due === item.due &&
        titlesMatch(normTitle(o.title), normTitle(item.title)),
    );
    if (!match) {
      out.push({ ...item, sources: [...item.sources] });
      continue;
    }
    // Merge into a NEW object replacing the matched one (immutability)
    const merged = {
      ...match,
      sources: [...new Set([...match.sources, ...item.sources])],
      submitted: mergeSubmitted(match.submitted, item.submitted),
      url: match.url ?? item.url,
      type: match.type === "other" ? item.type : match.type,
    };
    out[out.indexOf(match)] = merged;
  }
  return out;
}

/** Drop approx-dated items when an exact item with a matching title exists within 14 days. */
export function reconcileApprox(items) {
  const exact = items.filter((i) => !i.approx);
  return items.filter((i) => {
    if (!i.approx) return true;
    const dupe = exact.find(
      (e) =>
        e.courseId === i.courseId &&
        titlesMatch(normTitle(e.title), normTitle(i.title)) &&
        Math.abs(new Date(e.due) - new Date(i.due)) < 14 * 86400000,
    );
    return !dupe;
  });
}

/** Stable identity for diffing across runs (due date may change, title shouldn't). */
export function itemKey(item) {
  return `${item.courseId}::${item.type}::${normTitle(item.title)}`;
}

export function diffSnapshots(prev, curr) {
  const prevMap = new Map((prev?.items ?? []).map((i) => [itemKey(i), i]));
  const currItems = curr.items ?? [];

  const newItems = currItems.filter((i) => !prevMap.has(itemKey(i)));
  const changedDates = currItems.filter((i) => {
    const old = prevMap.get(itemKey(i));
    return old && old.due !== i.due;
  }).map((i) => ({ ...i, previousDue: prevMap.get(itemKey(i)).due }));
  const nowSubmitted = currItems.filter((i) => {
    const old = prevMap.get(itemKey(i));
    return old && !old.submitted && i.submitted;
  });

  const prevAnnIds = new Set((prev?.announcements ?? []).map((a) => `${a.courseId}:${a.id}`));
  const newAnnouncements = (curr.announcements ?? []).filter(
    (a) => !prevAnnIds.has(`${a.courseId}:${a.id}`),
  );

  return { newItems, changedDates, nowSubmitted, newAnnouncements };
}

/**
 * D2L's calendar feed posts BOTH an availability event and the real deadline for
 * the same deliverable, yielding twin items with identical itemKey but different
 * dues. The authoritative twin is the one corroborated beyond the calendar feed
 * (quiz/content/dropbox source, or a real submitted boolean); calendar-only
 * ghosts are dropped. If no twin is corroborated, all are kept (can't decide).
 */
export function collapseCalendarTwins(items) {
  const groups = new Map();
  for (const item of items) {
    const k = itemKey(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    if (group.some((i) => i.type === "exam")) {
      // Exam twins: calendar row = the session itself, content row = window
      // close. The session date is the one that matters; union the sources.
      const earliest = [...group].sort((a, b) => a.due.localeCompare(b.due))[0];
      out.push({
        ...earliest,
        sources: [...new Set(group.flatMap((i) => i.sources))],
        submitted: group.reduce((acc, i) => mergeSubmitted(acc, i.submitted), null),
      });
      continue;
    }
    const corroborated = group.filter(
      (i) => i.sources.some((s) => s !== "calendar") || i.submitted !== null,
    );
    out.push(...(corroborated.length > 0 ? corroborated : group));
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}
