// Admin-only. Reports today's assistant usage across all visitors, so the
// maintainer can see at a glance how the daily limit is being used without
// digging through Blobs manually.
//
// GET /api/admin-stats -> today's usage breakdown

const { getLessonStore, listTodayUsage, jsonResponse } = require("./_store");
const { checkAdminAuth } = require("./_admin_auth");

exports.handler = async (event) => {
  const auth = checkAdminAuth(event);
  if (!auth.ok) {
    return jsonResponse(401, { error: "unauthorized", detail: auth.reason });
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  try {
    const store = getLessonStore(event);
    const usage = await listTodayUsage(store);
    const totalPromptsToday = usage.reduce((sum, u) => sum + u.count, 0);
    const visitorsAtLimit = usage.filter((u) => u.count >= 5).length;

    return jsonResponse(200, {
      date: new Date().toISOString().slice(0, 10),
      totalVisitorsToday: usage.length,
      totalPromptsToday,
      visitorsAtLimit,
      usage,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
};