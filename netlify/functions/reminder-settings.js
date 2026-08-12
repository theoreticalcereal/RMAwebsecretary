const {
  getLessonStore,
  readReminderSettings,
  writeReminderSettings,
  jsonResponse,
} = require("./_store");
const { getSession } = require("./_auth");

exports.handler = async (event) => {
  const user = await getSession(event);
  if (!user) {
    return jsonResponse(401, { error: "unauthorized", detail: "Please log in to manage reminders." });
  }

  const store = getLessonStore(event);
  const userId = user.id || user.email;

  if (event.httpMethod === "GET") {
    const settings = await readReminderSettings(store, userId);
    return jsonResponse(200, { settings });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return jsonResponse(400, { error: "invalid JSON body" });
    }

    const settings = await writeReminderSettings(store, userId, body.settings || {});
    return jsonResponse(200, { settings });
  }

  return jsonResponse(405, { error: "method not allowed" });
};
