
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
  readOffTimeWindows,
  writeOffTimeWindows,
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
const { sendOffTimeProposalEmail } = require("./_notify");

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

function normalizeOffTimeWindow(raw, id) {
  if (raw?.kind && raw.kind !== "weekly") {
    return { error: "Off-time windows are weekly-only." };
  }
  const start_time = String(raw?.start_time || "").trim();
  const end_time = String(raw?.end_time || "").trim();
  if (!/^\d{2}:\d{2}$/.test(start_time) || !/^\d{2}:\d{2}$/.test(end_time) || start_time >= end_time) {
    return { error: "start_time and end_time must be HH:MM with start before end" };
  }

  const normalized = {
    id,
    kind: "weekly",
    start_time,
    end_time,
    note: String(raw?.note || "").trim() || null,
    createdAt: raw?.createdAt || new Date().toISOString(),
  };

  const day = Number(raw?.day_of_week);
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    return { error: "day_of_week must be 0-6 for weekly off-time windows" };
  }
  normalized.day_of_week = day;
  normalized.specific_date = null;

  return { window: normalized };
}

function lessonsAffectedByOffTime(lessons, window) {
  return lessons.filter((lesson) => {
    if (lesson.active === false) return false;
    if (lesson.day_of_week !== window.day_of_week) return false;
    return timesOverlap(lesson.start_time, lesson.end_time, window.start_time, window.end_time);
  });
}

function parseMinutes(value) {
  const [h, m] = String(value || "").split(":").map(Number);
  if ([h, m].some((part) => Number.isNaN(part))) return null;
  return h * 60 + m;
}

function formatMinutes(total) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function lessonDurationMinutes(lesson) {
  const start = parseMinutes(lesson.start_time);
  const end = parseMinutes(lesson.end_time);
  if (start === null || end === null || end <= start) return 60;
  return end - start;
}

function findNextAvailableSlot(lessons, lesson, window) {
  const duration = lessonDurationMinutes(lesson);
  const dayLessons = lessons.filter((candidate) =>
    candidate.active !== false &&
    candidate.id !== lesson.id &&
    candidate.day_of_week === lesson.day_of_week
  );
  const earliest = Math.max(parseMinutes(window.end_time) || 9 * 60, 9 * 60);
  const latestEnd = 20 * 60;

  for (let start = earliest; start + duration <= latestEnd; start += 30) {
    const end = start + duration;
    const startTime = formatMinutes(start);
    const endTime = formatMinutes(end);
    const conflictsLesson = dayLessons.some((candidate) =>
      timesOverlap(candidate.start_time, candidate.end_time, startTime, endTime)
    );
    const conflictsOffTime = timesOverlap(window.start_time, window.end_time, startTime, endTime);
    if (!conflictsLesson && !conflictsOffTime) {
      return { start_time: startTime, end_time: endTime };
    }
  }

  return null;
}

function proposalAlreadyExists(pendingChanges, lesson, window) {
  return pendingChanges.some((change) =>
    change?.status === "pending" &&
    change?.source === "off-time-renegotiation" &&
    change?.offTimeWindowId === window.id &&
    change?.action?.lesson_id === lesson.id
  );
}

async function createOffTimeRescheduleProposals({ store, lessons, window, pendingChanges, actorEmail }) {
  const affectedLessons = lessonsAffectedByOffTime(lessons, window);
  const nextPendingChanges = pendingChanges.slice();
  const proposals = [];

  for (const lesson of affectedLessons) {
    if (proposalAlreadyExists(nextPendingChanges, lesson, window)) continue;

    const slot = findNextAvailableSlot(lessons, lesson, window);
    if (!slot) {
      proposals.push({
        lessonId: lesson.id,
        skipped: true,
        reason: "no_available_slot",
        email: { sent: false, reason: "no proposal generated" },
      });
      continue;
    }

    const proposedAction = {
      action: "reschedule",
      student: lesson.student || null,
      subject: lesson.subject || null,
      day_of_week: lesson.day_of_week,
      start_time: slot.start_time,
      end_time: slot.end_time,
      old_start_time: lesson.start_time,
      old_end_time: lesson.end_time,
      recurring: lesson.recurring !== false,
      specific_date: lesson.specific_date || null,
      lesson_id: lesson.id,
      reason: `Maintainer unavailable: ${window.note || "off-time window"}`,
      reply: `Proposed moving ${lesson.subject || "lesson"} with ${lesson.student || "student"} to ${slot.start_time}-${slot.end_time}.`,
    };

    const pendingChange = {
      id: nextId(nextPendingChanges),
      status: "pending",
      source: "off-time-renegotiation",
      offTimeWindowId: window.id,
      createdAt: new Date().toISOString(),
      requestedBy: lesson.requestedBy || "maintainer-offtime",
      requestedByEmail: lesson.requestedByEmail || null,
      requestMessage: `Maintainer off-time ${formatOffTimeLabel(window)} affects lesson #${lesson.id}.`,
      autoCheck: {
        requiredReason: proposedAction.reason,
      },
      action: proposedAction,
    };
    nextPendingChanges.push(pendingChange);

    let email = { sent: false, reason: "missing recipient" };
    if (lesson.requestedByEmail && typeof sendOffTimeProposalEmail === "function") {
      email = await sendOffTimeProposalEmail({
        to: lesson.requestedByEmail,
        lesson,
        window,
        proposedAction,
        pendingChange,
        actorEmail,
      });
    }

    proposals.push({
      lessonId: lesson.id,
      pendingChange,
      email,
    });
  }

  await writePendingChanges(store, nextPendingChanges);
  return { pendingChanges: nextPendingChanges, proposals };
}

function formatOffTimeLabel(window) {
  const time = `${window.start_time}-${window.end_time}`;
  return `${DAY_NAMES[window.day_of_week] || "Unknown"} ${time}`;
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
      requestedBy: change.requestedBy || null,
      requestedByEmail: change.requestedByEmail || null,
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
      const [lessons, exceptions, approvalSettings, usageSettings, pendingChanges, userIdentityMap, offTimeWindows] = await Promise.all([
        readLessons(store),
        readExceptions(store),
        readApprovalSettings(store),
        getUsageSettings(store),
        readPendingChanges(store),
        readUserIdentityMap(store),
        readOffTimeWindows(store),
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
        offTimeWindows: offTimeWindows.map((window) => ({
          ...window,
          affectedLessons: lessonsAffectedByOffTime(lessons, window),
        })),
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

      if (operation === "save_offtime_window") {
        const [lessons, offTimeWindows, pendingChanges] = await Promise.all([
          readLessons(store),
          readOffTimeWindows(store),
          readPendingChanges(store),
        ]);
        const id = body.window?.id || nextId(offTimeWindows);
        const normalized = normalizeOffTimeWindow(body.window || {}, id);
        if (normalized.error) return jsonResponse(400, { error: normalized.error });

        const nextWindows = offTimeWindows.filter((window) => window.id !== id);
        nextWindows.push(normalized.window);
        nextWindows.sort((a, b) => {
          if (a.day_of_week !== b.day_of_week) return a.day_of_week - b.day_of_week;
          return a.start_time.localeCompare(b.start_time);
        });
        await writeOffTimeWindows(store, nextWindows);
        const proposalResult = await createOffTimeRescheduleProposals({
          store,
          lessons,
          window: normalized.window,
          pendingChanges,
          actorEmail: adminAuth.user.email,
        });
        return jsonResponse(200, {
          offTimeWindow: normalized.window,
          affectedLessons: lessonsAffectedByOffTime(lessons, normalized.window),
          proposedReschedules: proposalResult.proposals,
          saved: true,
        });
      }

      if (operation === "delete_offtime_window") {
        const id = Number(body.id);
        if (!Number.isFinite(id)) return jsonResponse(400, { error: "id is required for delete_offtime_window" });
        const offTimeWindows = await readOffTimeWindows(store);
        const nextWindows = offTimeWindows.filter((window) => window.id !== id);
        await writeOffTimeWindows(store, nextWindows);
        return jsonResponse(200, { deleted: id, offTimeWindows: nextWindows });
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
