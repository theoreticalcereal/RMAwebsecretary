
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