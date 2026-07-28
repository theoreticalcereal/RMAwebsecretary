// Shared helper for reading/writing lesson data in Netlify Blobs
// stores two JSON documents in a single "lesson secretary" store:
//   "lessons"    -> array of lesson objects (recurring weekly or one-off)
//   "exceptions" -> array of exception objects (cancel/reschedule of a single occurrence)
//
// This is intentionally simple (whole-array read/write)

const { getStore, connectLambda } = require("@netlify/blobs");

function getLessonStore(event) {
  // Required in "Lambda compatibility mode" DO NOT REMOVE
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

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function nextId(items) {
  return items.length ? Math.max(...items.map((i) => i.id)) + 1 : 1;
}

// Convert "16:00" -> 960 minutes-since-midnight for easy comparison
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// True if [aStart,aEnd) overlaps [bStart,bEnd), all "HH:MM" strings
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
  jsonResponse,
  nextId,
  timesOverlap,
};
