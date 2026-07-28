// Public, read-only endpoint. The calendar UI uses this to display lessons.
// Creating/editing/deleting lessons is NOT available here anymore - that
// only happens through the AI assistant (public) or the admin dashboard
// (maintainer only, see admin-lessons.js).
//
// GET /api/lessons -> list all lessons + exceptions

const { getLessonStore, readLessons, readExceptions, jsonResponse } = require("./_store");

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "method not allowed - lessons can only be read here; use the assistant or admin dashboard to make changes" });
  }

  try {
    const store = getLessonStore(event);
    const [lessons, exceptions] = await Promise.all([readLessons(store), readExceptions(store)]);
    return jsonResponse(200, { lessons, exceptions, dayNames: DAY_NAMES });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
};