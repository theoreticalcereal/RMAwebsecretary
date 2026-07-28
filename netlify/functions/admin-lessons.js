
const {
  getLessonStore,
  readLessons,
  writeLessons,
  readExceptions,
  writeExceptions,
  getUsageSettings,
  writeUsageSettings,
  setUserPromptLimit,
  resetUserPromptLimit,
  resetUserUsage,
  resetAllUsage,
  readApprovalSettings,
  writeApprovalSettings,
  readPendingChanges,
  writePendingChanges,
  filterVisiblePendingChanges,
  readUserIdentityMap,
  updateUserIdentity,
  jsonResponse,
  nextId,
  timesOverlap,
} = require("./_store");
const { getAdminSession } = require("./_auth");

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SUPPORTED_MODES = new Set(["manual", "automatic"]);

function isEmailLike(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || "").trim());
}

function normalizeSettingsPayload(raw) {
  const safeMinHours = Number(raw?.auto?.minHoursBefore);
  const safeMinReason = Number(raw?.auto?.minReasonLength);

  return {
    mode: SUPPORTED_MODES.has(raw?.mode) ? raw.mode : "manual",
    auto: {
      minHoursBefore: Number.isFinite(safeMinHours) ? Math.max(0, Math.floor(safeMinHours)) : 24,
      requireReason: typeof raw?.auto?.requireReason === "boolean" ? raw.auto.requireReason : true,
      minReasonLength: Number.isFinite(safeMinReason) ? Math.max(0, Math.floor(safeMinReason)) : 10,
    },
  };
}

function formatUserIdentities(identityMap) {
  return Object.entries(identityMap || {}).map(([userId, identity]) => ({
    userId,
    email: identity?.email || null,
    name: identity?.name || null,
    firstSeenEmail: identity?.firstSeenEmail || null,
    firstSeenAt: identity?.firstSeenAt || null,
    lastSeenAt: identity?.lastSeenAt || null,
    lastUpdatedAt: identity?.lastUpdatedAt || null,
  }));
}

function resolveRequesterEmail(identityMap, change) {
  if (isEmailLike(change.requestedByEmail)) return change.requestedByEmail;
  if (!change.requestedBy) return null;
  const identity = identityMap[change.requestedBy];
  return identity?.email || identity?.firstSeenEmail || null;
}

function validateLesson(body) {
  const errors = [];
  if (!body.student || typeof body.student !== "string") errors.push("student is required");
  if (body.day_of_week === undefined || body.day_of_week < 0 || body.day_of_week > 6) {
    errors.push("day_of_week must be 0-6 (Monday=0)");
  }
  if (!/^\d{2}:\d{2}$/.test(body.start_time || "")) errors.push("start_time must be HH:MM");
  if (!/^\d{2}:\d{2}$/.test(body.end_time || "")) errors.push("end_time must be HH:MM");
  if (body.start_time && body.end_time && body.start_time >= body.end_time) {
    errors.push("start_time must be before end_time");
  }
  return errors;
}

function withStatusMeta(change, status, actor, note) {
  return {
    ...change,
    status,
    reviewedAt: new Date().toISOString(),
    reviewedBy: actor || "admin",
    reviewNote: note || null,
  };
}

function findConflict(lessons, action, excludeLessonId = null) {
  return lessons.find(
    (l) =>
      l.active !== false &&
      l.id !== excludeLessonId &&
      l.day_of_week === action.day_of_week &&
      timesOverlap(l.start_time, l.end_time, action.start_time, action.end_time)
  );
}

async function applyPendingChange(change, lessons, exceptions, actor) {
  const action = change.action;

  if (action.action === "add") {
    if (action.day_of_week === null || action.day_of_week === undefined || !action.start_time || !action.end_time) {
      return {
        ok: false,
        reason: "This queued add is missing required time/day information.",
        reviewedChange: withStatusMeta(change, "rejected", actor, "missing required time/day information"),
      };
    }

    const conflict = findConflict(lessons, action);
    if (conflict) {
      return {
        ok: false,
        reason: `Conflicts with ${conflict.student}'s lesson on ${DAY_NAMES[conflict.day_of_week]} ${conflict.start_time}-${conflict.end_time}.`,
        reviewedChange: withStatusMeta(
          change,
          "rejected",
          actor,
          `Conflicts with ${conflict.student} (${conflict.subject || "no subject"}) ${conflict.start_time}-${conflict.end_time}`
        ),
      };
    }

    const lesson = {
      id: nextId(lessons),
      student: action.student || "Unnamed",
      subject: action.subject || "",
      day_of_week: action.day_of_week,
      start_time: action.start_time,
      end_time: action.end_time,
      recurring: action.recurring !== false,
      specific_date: action.specific_date || null,
      active: true,
    };
    lessons.push(lesson);
    return {
      ok: true,
      lessons,
      action: { lesson },
      reviewedChange: withStatusMeta(change, "approved", actor, "approved"),
    };
  }

  if (action.action === "delete") {
    if (!action.lesson_id) {
      return {
        ok: false,
        reason: "Queued delete request is missing lesson_id.",
        reviewedChange: withStatusMeta(change, "rejected", actor, "missing lesson_id"),
      };
    }
    const filtered = lessons.filter((l) => l.id !== action.lesson_id);
    if (filtered.length === lessons.length) {
      return {
        ok: false,
        reason: "Queued delete request refers to a lesson that no longer exists.",
        reviewedChange: withStatusMeta(change, "rejected", actor, `lesson_id ${action.lesson_id} not found`),
      };
    }
    return {
      ok: true,
      lessons: filtered,
      action: { deleted: action.lesson_id },
      reviewedChange: withStatusMeta(change, "approved", actor, "approved"),
    };
  }

  if (action.action === "cancel") {
    if (!action.lesson_id || !action.specific_date) {
      return {
        ok: false,
        reason: "Queued cancel request is missing lesson_id or date.",
        reviewedChange: withStatusMeta(change, "rejected", actor, "missing lesson_id or date"),
      };
    }
    const exception = {
      id: nextId(exceptions),
      lesson_id: action.lesson_id,
      exception_date: action.specific_date,
      status: "cancelled",
      source: "admin-review",
    };
    exceptions.push(exception);
    return {
      ok: true,
      exceptions,
      action: { exception },
      reviewedChange: withStatusMeta(change, "approved", actor, "approved"),
    };
  }

  if (action.action === "reschedule") {
    if (!action.lesson_id) {
      return {
        ok: false,
        reason: "Queued reschedule request is missing lesson_id.",
        reviewedChange: withStatusMeta(change, "rejected", actor, "missing lesson_id"),
      };
    }

    const lessonIdx = lessons.findIndex((l) => l.id === action.lesson_id && l.active !== false);
    if (lessonIdx === -1) {
      return {
        ok: false,
        reason: "Queued reschedule request refers to a lesson that no longer exists.",
        reviewedChange: withStatusMeta(change, "rejected", actor, `lesson_id ${action.lesson_id} not found`),
      };
    }

    const existing = lessons[lessonIdx];
    const newStart = action.start_time || existing.start_time;
    const duration = (() => {
      const s = existing.start_time?.split(":").map(Number);
      const e = existing.end_time?.split(":").map(Number);
      if (!s || !e) return 60;
      return (e[0] * 60 + e[1]) - (s[0] * 60 + s[1]);
    })();
    const parseMin = (value) => {
      const p = String(value || "").split(":").map(Number);
      if (p.length !== 2 || p.some((n) => Number.isNaN(n))) return null;
      return p[0] * 60 + p[1];
    };
    const startMin = parseMin(newStart);
    const endTime = action.end_time || (startMin === null ? null : (() => {
      const total = startMin + duration;
      const norm = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
      return `${String(Math.floor(norm / 60)).padStart(2, "0")}:${String(norm % 60).padStart(2, "0")}`;
    })());

    const reschedulePayload = {
      ...existing,
      student: action.student || existing.student,
      subject: action.subject || existing.subject,
      day_of_week: action.day_of_week ?? existing.day_of_week,
      recurring: action.recurring ?? existing.recurring,
      start_time: newStart,
      end_time: endTime || existing.end_time,
      specific_date: existing.specific_date,
    };

    const conflict = findConflict(
      lessons,
      {
        ...reschedulePayload,
        day_of_week: action.day_of_week ?? existing.day_of_week,
        start_time: reschedulePayload.start_time,
        end_time: reschedulePayload.end_time,
      },
      action.lesson_id
    );
    if (conflict) {
      return {
        ok: false,
        reason: `Conflicts with ${conflict.student}'s lesson on ${DAY_NAMES[conflict.day_of_week]} ${conflict.start_time}-${conflict.end_time}.`,
        reviewedChange: withStatusMeta(
          change,
          "rejected",
          actor,
          `Conflicts with ${conflict.student} (${conflict.subject || "no subject"}) ${conflict.start_time}-${conflict.end_time}`
        ),
      };
    }

    lessons[lessonIdx] = reschedulePayload;
    return {
      ok: true,
      lessons,
      action: { lesson: reschedulePayload },
      reviewedChange: withStatusMeta(change, "approved", actor, "approved"),
    };
  }

  return {
    ok: false,
    reason: `Unknown action type: ${action.action}`,
    reviewedChange: withStatusMeta(change, "rejected", actor, `unknown action ${action.action}`),
  };
}

async function savePendingChangeReview(pendingChanges, reviewedChange) {
  const idx = pendingChanges.findIndex((item) => item.id === reviewedChange.id);
  if (idx !== -1) pendingChanges[idx] = reviewedChange;
}

exports.handler = async (event) => {
  const adminAuth = await getAdminSession(event);
  if (!adminAuth.ok) {
    return jsonResponse(adminAuth.status, { error: adminAuth.reason, detail: adminAuth.reason });
  }

  try {
    const store = getLessonStore(event);

    if (event.httpMethod === "GET") {
      const [lessons, exceptions, approvalSettings, usageSettings, pendingChanges, userIdentityMap] = await Promise.all([
        readLessons(store),
        readExceptions(store),
        readApprovalSettings(store),
        getUsageSettings(store),
        readPendingChanges(store),
        readUserIdentityMap(store),
      ]);
      const visiblePendingChanges = filterVisiblePendingChanges(pendingChanges);
      const pendingChangesWithEmails = visiblePendingChanges.map((change) => ({
        ...change,
        requestedByEmail: resolveRequesterEmail(userIdentityMap, change),
      }));
      return jsonResponse(200, {
        lessons,
        exceptions,
        dayNames: DAY_NAMES,
        approvalSettings,
        usageSettings,
        userIdentities: formatUserIdentities(userIdentityMap),
        pendingChanges: pendingChangesWithEmails.filter((item) => item.status === "pending"),
        allPendingChanges: pendingChangesWithEmails,
      });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const operation = body.operation || "add";

      if (operation === "save_settings") {
        const settings = normalizeSettingsPayload(body.settings || {});
        await writeApprovalSettings(store, settings);
        return jsonResponse(200, { approvalSettings: settings, saved: true });
      }

      if (operation === "set_default_limit") {
        const defaultDailyPromptLimit = Number(body.defaultDailyPromptLimit);
        if (!Number.isFinite(defaultDailyPromptLimit) || defaultDailyPromptLimit < 0) {
          return jsonResponse(400, { error: "defaultDailyPromptLimit must be a non-negative number" });
        }
        await writeUsageSettings(store, { defaultDailyPromptLimit });
        const settings = await getUsageSettings(store);
        return jsonResponse(200, { usageSettings: settings, saved: true });
      }

      if (operation === "set_user_limit") {
        const { userId, promptLimit } = body;
        if (!userId) return jsonResponse(400, { error: "userId is required for set_user_limit" });
        const normalized = Number(promptLimit);
        if (!Number.isFinite(normalized) || normalized < 0) {
          return jsonResponse(400, { error: "promptLimit must be a non-negative number." });
        }
        const limit = await setUserPromptLimit(store, userId, normalized);
        if (limit === null) return jsonResponse(400, { error: "Could not set user limit." });
        return jsonResponse(200, { userId, promptLimit: limit, saved: true });
      }

      if (operation === "reset_user_limit") {
        const { userId } = body;
        if (!userId) return jsonResponse(400, { error: "userId is required for reset_user_limit" });
        const limit = await resetUserPromptLimit(store, userId);
        if (limit === null) return jsonResponse(400, { error: "Could not reset user limit." });
        return jsonResponse(200, { userId, promptLimit: limit, saved: true });
      }

      if (operation === "reset_user_usage") {
        const { userId, userEmail } = body;
        if (!userId) return jsonResponse(400, { error: "userId is required for reset_user_usage" });
        const result = await resetUserUsage(store, userId, userEmail);
        if (!result) return jsonResponse(400, { error: "Could not reset user usage." });
        return jsonResponse(200, { usage: result, saved: true });
      }

      if (operation === "reset_all_usage") {
        await resetAllUsage(store);
        return jsonResponse(200, { saved: true, resetAll: true });
      }

      if (operation === "update_user_identity") {
        const userId = String(body.userId || "").trim();
        if (!userId) return jsonResponse(400, { error: "userId is required for update_user_identity" });
        const hasEmail = Object.prototype.hasOwnProperty.call(body, "email");
        const hasName = Object.prototype.hasOwnProperty.call(body, "name");
        if (!hasEmail && !hasName) {
          return jsonResponse(400, { error: "No identity fields provided for update_user_identity." });
        }

        const result = await updateUserIdentity(store, userId, {
          ...(Object.prototype.hasOwnProperty.call(body, "email") ? { email: body.email } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "name") ? { name: body.name } : {}),
        });
        if (result === null) {
          return jsonResponse(404, { error: "User identity not found" });
        }
        if (result.error === "invalid_email") {
          return jsonResponse(400, { error: "Invalid email." });
        }

        return jsonResponse(200, { userIdentity: { userId, ...result }, saved: true });
      }

      if (operation === "approve_change") {
        if (!body.id) return jsonResponse(400, { error: "id is required for approve_change" });

        const [lessons, exceptions, pendingChanges] = await Promise.all([
          readLessons(store),
          readExceptions(store),
          readPendingChanges(store),
        ]);

        const pending = pendingChanges.find((item) => item.id === body.id && item.status === "pending");
        if (!pending) return jsonResponse(404, { error: "Pending change not found" });

        const applyResult = await applyPendingChange(pending, lessons, exceptions, adminAuth.user.email);
        if (!applyResult.ok) {
          await savePendingChangeReview(pendingChanges, applyResult.reviewedChange);
          await writePendingChanges(store, pendingChanges);
          return jsonResponse(409, {
            error: applyResult.reason,
            reviewedChange: applyResult.reviewedChange,
            status: applyResult.reviewedChange.status,
          });
        }

        const nextPendingChanges = pendingChanges.map((item) =>
          item.id === body.id ? applyResult.reviewedChange : item
        );
        await Promise.all([
          writeLessons(store, applyResult.lessons),
          writeExceptions(store, applyResult.exceptions || exceptions),
          writePendingChanges(store, nextPendingChanges),
        ]);

        return jsonResponse(200, {
          result: applyResult.action,
          reviewedChange: applyResult.reviewedChange,
          status: applyResult.reviewedChange.status,
        });
      }

      if (operation === "reject_change") {
        if (!body.id) return jsonResponse(400, { error: "id is required for reject_change" });

        const pendingChanges = await readPendingChanges(store);
        const idx = pendingChanges.findIndex((item) => item.id === body.id && item.status === "pending");
        if (idx === -1) return jsonResponse(404, { error: "Pending change not found" });

        pendingChanges[idx] = withStatusMeta(
          pendingChanges[idx],
          "rejected",
          adminAuth.user.email,
          body.note || "Rejected by admin"
        );
        await writePendingChanges(store, pendingChanges);
        return jsonResponse(200, { reviewedChange: pendingChanges[idx], status: pendingChanges[idx].status });
      }

      const errors = validateLesson(body);
      if (errors.length) return jsonResponse(400, { errors });

      const lessons = await readLessons(store);
      const conflict = lessons.find(
        (l) =>
          l.active !== false &&
          l.day_of_week === body.day_of_week &&
          timesOverlap(l.start_time, l.end_time, body.start_time, body.end_time)
      );
      if (conflict) {
        return jsonResponse(409, {
          error: `Conflicts with existing lesson: ${conflict.student} (${conflict.subject || "no subject"}) ${conflict.start_time}-${conflict.end_time}`,
        });
      }

      const lesson = {
        id: nextId(lessons),
        student: body.student,
        subject: body.subject || "",
        day_of_week: body.day_of_week,
        start_time: body.start_time,
        end_time: body.end_time,
        recurring: body.recurring !== false,
        specific_date: body.specific_date || null,
        active: true,
      };
      lessons.push(lesson);
      await writeLessons(store, lessons);
      return jsonResponse(201, { lesson });
    }

    if (event.httpMethod === "PUT") {
      const body = JSON.parse(event.body || "{}");
      if (!body.id) return jsonResponse(400, { error: "id is required" });

      const lessons = await readLessons(store);
      const idx = lessons.findIndex((l) => l.id === body.id);
      if (idx === -1) return jsonResponse(404, { error: "lesson not found" });

      const updated = { ...lessons[idx], ...body };
      const errors = validateLesson(updated);
      if (errors.length) return jsonResponse(400, { errors });

      lessons[idx] = updated;
      await writeLessons(store, lessons);
      return jsonResponse(200, { lesson: updated });
    }

    if (event.httpMethod === "DELETE") {
      const body = JSON.parse(event.body || "{}");
      if (!body.id) return jsonResponse(400, { error: "id is required" });

      const lessons = await readLessons(store);
      const filtered = lessons.filter((l) => l.id !== body.id);
      if (filtered.length === lessons.length) return jsonResponse(404, { error: "lesson not found" });

      await writeLessons(store, filtered);
      return jsonResponse(200, { deleted: body.id });
    }

    return jsonResponse(405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
};
