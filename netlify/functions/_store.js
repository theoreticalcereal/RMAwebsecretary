// Shared helper for reading/writing lesson data in Netlify Blobs.
// We store two JSON documents in a single "lesson-secretary" store:
//   "lessons"    -> array of lesson objects (recurring weekly or one-off)
//   "exceptions" -> array of exception objects (cancel/reschedule of a single occurrence)
//
// This is intentionally simple (whole-array read/write) rather than one blob
// per lesson, because the expected data size is tiny (a handful of lessons).

const { getStore, connectLambda } = require("@netlify/blobs");

function getLessonStore(event) {
  try {
    // Required in "Lambda compatibility mode", which is what Netlify
    // Functions use by default for CommonJS handlers like this one.
    connectLambda(event);
    // Deliberately using the default (eventual) consistency rather than
    // "strong" here. Strong consistency requires an 'uncachedEdgeURL'
    // property that isn't always present (e.g. some netlify dev / local
    // contexts), which surfaces as an opaque read failure. This app writes
    // a handful of times a day, so eventual consistency (propagates in
    // low single-digit seconds) is more than good enough and avoids that
    // failure mode entirely.
    return getStore({ name: "lesson-secretary" });
  } catch (err) {
    // Blobs setup failures are the most common cause of an opaque 500 on
    // every request. Wrap with a clearer message so it's diagnosable from
    // the function's JSON response instead of just "internal error".
    throw new Error(`Failed to initialize Blobs store: ${err.message || err}`);
  }
}

async function readLessons(store) {
  const data = await store.get("lessons", { type: "json" });
  return data || [];
}

async function writeLessons(store, lessons) {
  await store.setJSON("lessons", lessons);
}

async function readExceptions(store) {
  const data = await store.get("exceptions", { type: "json" });
  return data || [];
}

async function writeExceptions(store, exceptions) {
  await store.setJSON("exceptions", exceptions);
}

// Daily usage tracking for the natural-language assistant, keyed by
// "usage:YYYY-MM-DD:<userId>". One authenticated user should not
// affect another user's quota.
function todayKey(userId) {
  return `usage:${new Date().toISOString().slice(0, 10)}:${userId}`;
}

async function readUsage(store, userId) {
  const data = await store.get(todayKey(userId), { type: "json" });
  return {
    count: data?.count ?? 0,
    maintainerNotified: data?.maintainerNotified ?? false,
    userEmail: data?.userEmail || null,
  };
}

async function writeUsage(store, userId, usage) {
  await store.setJSON(todayKey(userId), usage);
}

const APPROVAL_SETTINGS_KEY = "approval_settings";
const PENDING_CHANGES_KEY = "pending_changes";

function getDefaultApprovalSettings() {
  return {
    mode: "manual",
    auto: {
      minHoursBefore: 24,
      requireReason: true,
      minReasonLength: 10,
    },
  };
}

async function readApprovalSettings(store) {
  const data = await store.get(APPROVAL_SETTINGS_KEY, { type: "json" });
  if (!data) return getDefaultApprovalSettings();

  return {
    mode: data.mode === "automatic" ? "automatic" : "manual",
    auto: {
      minHoursBefore: Math.max(0, Math.floor(Number(data?.auto?.minHoursBefore ?? 24))),
      requireReason: typeof data?.auto?.requireReason === "boolean" ? data.auto.requireReason : true,
      minReasonLength: Math.max(0, Math.floor(Number(data?.auto?.minReasonLength ?? 10))),
    },
  };
}

async function writeApprovalSettings(store, settings) {
  await store.setJSON(APPROVAL_SETTINGS_KEY, settings);
}

async function readPendingChanges(store) {
  const data = await store.get(PENDING_CHANGES_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function writePendingChanges(store, pendingChanges) {
  await store.setJSON(PENDING_CHANGES_KEY, pendingChanges);
}

// Lists every usage key for today, for the admin dashboard's "how many
// people used the assistant today" view. Netlify Blobs list() returns
// blobs by key prefix.
async function listTodayUsage(store) {
  const prefix = `usage:${new Date().toISOString().slice(0, 10)}:`;
  const { blobs } = await store.list({ prefix });
  const results = [];
  for (const blob of blobs) {
    const data = await store.get(blob.key, { type: "json" });
    results.push({
      userId: blob.key.slice(prefix.length),
      userEmail: data?.userEmail || null,
      count: data?.count ?? 0,
      maintainerNotified: data?.maintainerNotified ?? false,
    });
  }
  return results;
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function nextId(items) {
  return items.length ? Math.max(...items.map((i) => i.id)) + 1 : 1;
}

// Convert "16:00" -> 960 minutes-since-midnight, for easy comparison.
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// True if [aStart,aEnd) overlaps [bStart,bEnd), all "HH:MM" strings.
function timesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = toMinutes(aStart), ae = toMinutes(aEnd);
  const bs = toMinutes(bStart), be = toMinutes(bEnd);
  return as < be && bs < ae;
}

module.exports = {
  getLessonStore,
  readLessons,
  writeLessons,
  readExceptions,
  writeExceptions,
  readUsage,
  writeUsage,
  readApprovalSettings,
  writeApprovalSettings,
  readPendingChanges,
  writePendingChanges,
  listTodayUsage,
  jsonResponse,
  nextId,
  timesOverlap,
};
