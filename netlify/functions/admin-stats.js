// Admin-only. Reports today's assistant usage across authenticated users for
// the same authenticated identity model used on public pages.
//
// GET /api/admin-stats -> today's usage breakdown

const { getLessonStore, listTodayUsage, jsonResponse } = require("./_store");
const { getAdminSession } = require("./_auth");

exports.handler = async (event) => {
  const adminAuth = await getAdminSession(event);
  if (!adminAuth.ok) {
    return jsonResponse(adminAuth.status, { error: adminAuth.reason, detail: adminAuth.reason });
  }

  if (event.httpMethod !== "GET") {
    return jsonResponse(405, { error: "method not allowed" });
  }

  try {
    const store = getLessonStore(event);
    const usage = await listTodayUsage(store);
    const totalPromptsToday = usage.reduce((sum, u) => sum + u.count, 0);
    const usersAtLimit = usage.filter((u) => u.count >= 5).length;

    return jsonResponse(200, {
      date: new Date().toISOString().slice(0, 10),
      totalVisitorsToday: usage.length,
      totalPromptsToday,
      visitorsAtLimit: usersAtLimit,
      usage,
    });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
};
