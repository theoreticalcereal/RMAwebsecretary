// Shared helper for reading/writing lesson data in Netlify Blobs.
// We store two JSON documents in a single "lesson-secretary" store:
//   "lessons"    -> array of lesson objects (recurring weekly or one-off)
//   "exceptions" -> array of exception objects (cancel/reschedule of a single occurrence)
//
// This is intentionally simple (whole-array read/write) rather than one blob
// per lesson, because the expected data size is tiny (a handful of lessons).

const { getStore, connectLambda } = require("@netlify/blobs");

function getLessonStore(event) {
  // Required in "Lambda compatibility mode", which is what Netlify Functions
  // use by default for CommonJS handlers like this one.
  connectLambda(event);
  return getStore({ name: "lesson-secretary", consistency: "strong" });
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
// "usage:YYYY-MM-DD:<visitorId>". Per-visitor (via a cookie, see
// _cookies.js) rather than global, so one person maxing out their 5
// requests doesn't block anyone else. Also used to avoid spamming the
// maintainer email more than once per visitor per day once the cap is hit.
function todayKey(visitorId) {
  return `usage:${new Date().toISOString().slice(0, 10)}:${visitorId}`;
}

async function readUsage(store, visitorId) {
  const data = await store.get(todayKey(visitorId), { type: "json" });
  return data || { count: 0, maintainerNotified: false };
}

async function writeUsage(store, visitorId, usage) {
  await store.setJSON(todayKey(visitorId), usage);
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
  jsonResponse,
  nextId,
  timesOverlap,
};