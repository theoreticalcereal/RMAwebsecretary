const {
  getLessonStore,
  readLessons,
  writeLessons,
  readExceptions,
  writeExceptions,
  readApprovalSettings,
  readPendingChanges,
  writePendingChanges,
  filterPendingChangesForUser,
  RESOLVED_REQUEST_TTL_HOURS,
  recordUserIdentity,
  readUsage,
  writeUsage,
  getUserPromptLimit,
  canConsumeNimRequestSlot,
  NIM_RATE_LIMIT_PER_WINDOW,
  NIM_RATE_WINDOW_MS,
  jsonResponse,
  nextId,
  timesOverlap,
} = require("./_store");
const { notifyMaintainer } = require("./_notify");
const { getSession } = require("./_auth");

const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NIM_MODEL = "meta/llama-3.3-70b-instruct";
const AI_DEFAULTS = Object.freeze({
  requestTimeoutMs: 9000,
  reasonTimeoutMs: 9000,
  maxTokens: 1536,
  reasonMaxTokens: 256,
});
const NIM_TIMEOUT_MS = AI_DEFAULTS.requestTimeoutMs;
const NIM_REASON_TIMEOUT_MS = AI_DEFAULTS.reasonTimeoutMs;
const NIM_MAX_TOKENS = AI_DEFAULTS.maxTokens;
const NIM_REASON_MAX_TOKENS = AI_DEFAULTS.reasonMaxTokens;

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const DAY_NAME_TO_INDEX = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

const SYSTEM_PROMPT = `You are a scheduling assistant for a lesson calendar. You convert a user's natural-language request into a single JSON action. Reply with ONLY the JSON object, no other text, no markdown fences.

Today's date is ${new Date().toISOString().slice(0, 10)}.

The JSON must have this shape:
{
  "action": "add" | "cancel" | "delete" | "reschedule" | "query" | "unknown",
  "student": string or null,
  "subject": string or null,
  "day_of_week": integer 0-6 (Monday=0, Sunday=6) or null,
  "start_time": "HH:MM" (24-hour) or null,
  "end_time": "HH:MM" (24-hour) or null,
  "old_start_time": "HH:MM" (24-hour) or null,
  "old_end_time": "HH:MM" (24-hour) or null,
  "recurring": true or false,
  "specific_date": "YYYY-MM-DD" or null,
  "lesson_id": integer or null,
  "reason": string or null,
  "reply": string (a short, plain confirmation or clarifying question to show the user)
}

Rules:
- "add" means create a new lesson (recurring weekly unless the user specifies a one-off date).
- "cancel" means cancel a single upcoming occurrence of an existing recurring lesson (needs lesson_id and specific_date if you can determine them from context; otherwise set action to "unknown" and ask in "reply").
- "delete" means remove a recurring lesson entirely.
- "reschedule" means adjust an existing lesson's times. Use lesson_id if possible, otherwise include subject/student.
- "query" means the user is just asking a question (e.g. "what's on Tuesday") — set reply to a helpful answer using the CURRENT LESSONS provided below, action "query".
- If the request is ambiguous or missing required info (e.g. no time given), use action "unknown" and ask a clarifying question in "reply".
- Never invent a lesson_id — only use one that appears in CURRENT LESSONS below.
- Include a "reason" value whenever the request contains a natural-language reason (for example, phrases like "because", "since", "so that", or "for"), even if short. Use null only when no reason is present.`;

function nowInMs() {
  return Date.now();
}

function cloneAction(action) {
  return JSON.parse(JSON.stringify(action));
}

function parseDateAndTime(specificDate, startTime) {
  if (!specificDate || !startTime) return null;
  const dt = new Date(`${specificDate}T${startTime}:00`);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseDayFromMessage(message) {
  const match = String(message || "").match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
  );
  if (!match) return null;
  return DAY_NAME_TO_INDEX[match[1].toLowerCase()];
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function nextOccurrenceOnOrAfter(date, dayIndex, timeHHMM) {
  const [hour, minute] = timeHHMM.split(":").map(Number);
  if ([dayIndex, hour, minute].some((v) => Number.isNaN(v))) return null;
  const now = date ? new Date(date) : new Date();

  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  const currentDay = candidate.getDay();
  const targetDay = (dayIndex + 1) % 7;
  const delta = (targetDay - currentDay + 7) % 7;
  candidate.setDate(candidate.getDate() + delta);

  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 7);
  }
  return candidate;
}

function normalizeReason(reason) {
  const normalized = String(reason || "").trim();
  if (!normalized) return "";
  return normalized.length > 2048 ? normalized.slice(0, 2048) : normalized;
}

function findPotentialConflict(lessons, action, excludeLessonId) {
  return lessons.find(
    (l) =>
      l.active !== false &&
      l.id !== excludeLessonId &&
      l.day_of_week === action.day_of_week &&
      timesOverlap(l.start_time, l.end_time, action.start_time, action.end_time)
  );
}

function meetsReasonRules(rawReason, settings) {
  if (!settings.auto.requireReason) return { ok: true, reason: rawReason };
  const reason = (rawReason || "").trim();
  if (!reason) return { ok: false, issue: "A valid reason is required before automatic approval." };
  if (reason.length < settings.auto.minReasonLength) {
    return {
      ok: false,
      issue: `The reason must be at least ${settings.auto.minReasonLength} characters long before automatic approval.`,
    };
  }
  return { ok: true, reason };
}

function minutesUntil(targetDate, now = nowInMs()) {
  if (!targetDate) return Number.POSITIVE_INFINITY;
  return (new Date(targetDate).getTime() - now) / (60 * 60 * 1000);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  if ([h, m].some((v) => Number.isNaN(v))) return null;
  return h * 60 + m;
}

function addMinutesToTime(hhmm, addMinutes) {
  const base = toMinutes(hhmm);
  if (base === null || !Number.isFinite(addMinutes)) return null;
  let total = base + addMinutes;
  total = ((total % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function isNoopMessage(message) {
  const lower = String(message || "").toLowerCase();
  return /\b(hi|hello|hey|thanks|thank you|okay|ok)\b/.test(lower);
}

function isLikelyQuery(message) {
  const lower = String(message || "").toLowerCase();
  return /\b(what|when|who|schedule|calendar|lessons|lesson|show|list)\b/.test(lower);
}

function canAutoApprove(changeAction, reasonText, settings, lessons) {
  if (settings.mode !== "automatic") return { ok: false, autoRejected: false, reason: "manual_mode" };

  const auto = settings.auto || {};
  const minHoursBefore = Number(auto.minHoursBefore ?? 24);
  const reasonCheck = meetsReasonRules(normalizeReason(reasonText), settings);
  if (!reasonCheck.ok) {
    return { ok: false, autoRejected: true, reason: reasonCheck.issue, requiredAction: "manual_review" };
  }

  if (changeAction.action === "add") {
    const nextOccurrence = nextOccurrenceOnOrAfter(new Date(), changeAction.day_of_week, changeAction.start_time);
    if (minutesUntil(nextOccurrence) < minHoursBefore) {
      return {
        ok: false,
        autoRejected: true,
        reason: `This lesson starts in less than ${minHoursBefore} hour(s).`,
        requiredAction: "manual_review",
      };
    }
    return { ok: true, autoRejected: false };
  }

  if (changeAction.action === "delete") {
    const lesson = lessons.find((l) => l.id === changeAction.lesson_id);
    if (!lesson) return { ok: false, autoRejected: true, reason: "Unknown lesson id.", requiredAction: "manual_review" };
    const nextOccurrence = nextOccurrenceOnOrAfter(new Date(), lesson.day_of_week, lesson.start_time);
    if (minutesUntil(nextOccurrence) < minHoursBefore) {
      return {
        ok: false,
        autoRejected: true,
        reason: `That recurring lesson starts in less than ${minHoursBefore} hour(s).`,
        requiredAction: "manual_review",
      };
    }
    return { ok: true, autoRejected: false };
  }

  if (changeAction.action === "cancel") {
    const lesson = lessons.find((l) => l.id === changeAction.lesson_id);
    if (!lesson) return { ok: false, autoRejected: true, reason: "Unknown lesson id.", requiredAction: "manual_review" };

    const cancelDate = parseDateAndTime(changeAction.specific_date, lesson.start_time);
    if (!cancelDate) {
      return {
        ok: false,
        autoRejected: true,
        reason: "Specific date is missing or invalid.",
        requiredAction: "manual_review",
      };
    }
    if (minutesUntil(cancelDate) < minHoursBefore) {
      return {
        ok: false,
        autoRejected: true,
        reason: `That occurrence starts in less than ${minHoursBefore} hour(s).`,
        requiredAction: "manual_review",
      };
    }
    return { ok: true, autoRejected: false };
  }

  if (changeAction.action === "reschedule") {
    if (!changeAction.lesson_id) return { ok: false, autoRejected: true, reason: "Could not identify the lesson to reschedule.", requiredAction: "manual_review" };

    const lesson = lessons.find((l) => l.id === changeAction.lesson_id);
    if (!lesson) return { ok: false, autoRejected: true, reason: "Unknown lesson id.", requiredAction: "manual_review" };

    const checkDate =
      parseDateAndTime(changeAction.specific_date, changeAction.start_time) ||
      nextOccurrenceOnOrAfter(new Date(), changeAction.day_of_week ?? lesson.day_of_week, changeAction.start_time);
    if (!checkDate) {
      return {
        ok: false,
        autoRejected: true,
        reason: "Could not determine when this lesson starts.",
        requiredAction: "manual_review",
      };
    }
    if (minutesUntil(checkDate) < minHoursBefore) {
      return {
        ok: false,
        autoRejected: true,
        reason: `That lesson starts in less than ${minHoursBefore} hour(s).`,
        requiredAction: "manual_review",
      };
    }
    return { ok: true, autoRejected: false };
  }

  return { ok: true, autoRejected: false };
}

async function queuePendingChange(store, action, reason, userId, userMessage, userEmail) {
  const pendingChanges = await readPendingChanges(store);
  const pending = {
    id: nextId(pendingChanges),
    status: "pending",
    createdAt: new Date().toISOString(),
    requestedBy: userId,
    requestedByEmail: userEmail || null,
    requestMessage: userMessage,
    autoCheck: {
      requiredReason: reason,
    },
    action: cloneAction(action),
  };
  pendingChanges.push(pending);
  await writePendingChanges(store, pendingChanges);
  return pending;
}

function createAutoRejectResponse(action, reason, pending) {
  return {
    action: {
      ...cloneAction(action),
      reply: reason,
      action: action.action,
    },
    applied: false,
    pending: true,
    pendingChange: pending,
  };
}

function findLessonByContext(lessons, action) {
  if (!action) return null;
  if (action.lesson_id) return lessons.find((l) => l.id === action.lesson_id);

  if (action.action === "reschedule" && action.old_start_time) {
    const oldMatches = lessons.filter((l) => l.active !== false && l.day_of_week === action.day_of_week && l.start_time === action.old_start_time);
    if (oldMatches.length === 1) return oldMatches[0];
    if (oldMatches.length > 1) {
      const exactMatch = oldMatches.find((l) => action.student && normalizeName(l.student) === normalizeName(action.student));
      if (exactMatch) return exactMatch;
      if (action.subject) {
        const bySubject = oldMatches.find((l) => normalizeName(l.subject) === normalizeName(action.subject));
        if (bySubject) return bySubject;
      }
    }
  }

  const subject = normalizeName(action.subject);
  const student = normalizeName(action.student);

  const candidatePool = lessons.filter((l) => l.active !== false);
  let matches = candidatePool;

  if (subject) {
    matches = matches.filter((l) => {
      const s = normalizeName(l.subject);
      return s === subject || s.includes(subject) || subject.includes(s);
    });
  }

  if (student) {
    matches = matches.filter((l) => {
      const n = normalizeName(l.student);
      return n === student || n.includes(student) || student.includes(n);
    });
  }

  if (matches.length === 1) return matches[0];
  return null;
}

async function applyActionOrQueue(store, action, userMessage, userId, lessons, settings, reasonText, userEmail) {
  if (!action.lesson_id && (action.action === "cancel" || action.action === "reschedule")) {
    const lessonFromContext = findLessonByContext(lessons, action);
    if (lessonFromContext) action.lesson_id = lessonFromContext.id;
  }

  if (settings.mode === "manual") {
    const pending = await queuePendingChange(store, action, reasonText, userId, userMessage, userEmail);
    return createAutoRejectResponse(action, "This request has been queued for manual review.", pending);
  }

  const autoDecision = canAutoApprove(action, reasonText, settings, lessons);
  if (!autoDecision.ok) {
    const pending = await queuePendingChange(store, action, reasonText, userId, userMessage, userEmail);
    return createAutoRejectResponse(
      action,
      autoDecision.reason || "This request has been queued for manual review.",
      pending
    );
  }

  if (action.action === "add") {
    const conflict = findPotentialConflict(lessons, action, null);
    if (conflict) {
      return {
        action: {
          ...cloneAction(action),
          action: "unknown",
          reply: `Conflicts with ${conflict.student}'s lesson on ${DAY_NAMES[conflict.day_of_week]} ${conflict.start_time}-${conflict.end_time}.`,
        },
        applied: false,
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
    await writeLessons(store, lessons);
    return { action, applied: true, lesson };
  }

  if (action.action === "delete") {
    const filtered = lessons.filter((l) => l.id !== action.lesson_id);
    if (filtered.length === lessons.length) {
      return {
        action: { ...cloneAction(action), action: "unknown", reply: "I couldn't find that lesson." },
        applied: false,
      };
    }
    await writeLessons(store, filtered);
    return { action, applied: true, deleted: action.lesson_id };
  }

  if (action.action === "cancel") {
    const exceptions = await readExceptions(store);
    const exception = {
      id: nextId(exceptions),
      lesson_id: action.lesson_id,
      exception_date: action.specific_date,
      status: "cancelled",
    };
    exceptions.push(exception);
    await writeExceptions(store, exceptions);
    return { action, applied: true, exception };
  }

  if (action.action === "reschedule") {
    const lessonIdx = lessons.findIndex((l) => l.id === action.lesson_id && l.active !== false);
    if (lessonIdx === -1) {
      return {
        action: { ...cloneAction(action), action: "unknown", reply: "I couldn't find that lesson." },
        applied: false,
      };
    }

    const existing = lessons[lessonIdx];
    const originalStart = action.start_time || existing.start_time;
    const originalDuration = inferLessonMinutes(existing.start_time, existing.end_time);
    const derivedEnd = action.end_time || addMinutesToTime(originalStart, Number.isFinite(originalDuration) ? originalDuration : 60);
    if (!originalStart || !derivedEnd) {
      return {
        action: {
          ...cloneAction(action),
          action: "unknown",
          reply: "I need both a new start and end time to reschedule.",
        },
        applied: false,
      };
    }

    const conflict = findPotentialConflict(
      lessons,
      { ...action, start_time: originalStart, end_time: derivedEnd },
      action.lesson_id
    );
    if (conflict) {
      return {
        action: {
          ...cloneAction(action),
          action: "unknown",
          reply: `That conflicts with ${conflict.student}'s lesson on ${DAY_NAMES[conflict.day_of_week]} ${conflict.start_time}-${conflict.end_time}.`,
        },
        applied: false,
      };
    }

    lessons[lessonIdx] = {
      ...existing,
      student: action.student || existing.student,
      subject: action.subject || existing.subject,
      day_of_week: action.day_of_week ?? existing.day_of_week,
      start_time: originalStart,
      end_time: derivedEnd,
      recurring: action.recurring ?? existing.recurring,
      specific_date: existing.specific_date,
    };
    await writeLessons(store, lessons);
    return { action: { ...cloneAction(action), end_time: derivedEnd }, applied: true, lesson: lessons[lessonIdx] };
  }

  return {
    action,
    applied: false,
  };
}

function parseTo24Hour(hour, minute, meridian) {
  const h = Number(hour);
  const m = Number(minute || 0);
  const period = (meridian || "").toLowerCase();

  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  if (m < 0 || m > 59) return null;
  if (h < 0 || h > 23) return null;

  if (period) {
    if (h < 1 || h > 12) return null;
    let hh = h;
    if (period === "am") {
      hh = h === 12 ? 0 : h;
    } else if (period === "pm") {
      hh = h === 12 ? 12 : h + 12;
    }
    return `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseSimpleAddRequest(message) {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();

  if (!/\b(schedule|add|book|create)\b/.test(lower)) return null;

  const timeMatch = normalized.match(
    /\b(?:from|between)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|until)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
  );
  if (!timeMatch) return null;

  const explicitStartPeriod = timeMatch[3];
  const explicitEndPeriod = timeMatch[6];
  const startPeriod = explicitStartPeriod || explicitEndPeriod;
  const endPeriod = explicitEndPeriod || explicitStartPeriod || startPeriod;
  const startTime = parseTo24Hour(timeMatch[1], timeMatch[2], startPeriod);
  const endTime = parseTo24Hour(timeMatch[4], timeMatch[5], endPeriod);
  if (!startTime || !endTime) return null;

  const dayOfWeek = parseDayFromMessage(lower);
  if (dayOfWeek === null) return null;

  const schedulePattern = /\b(?:schedule|add|book|create)\s+(.+?)\s+(?:with|for)\s+([A-Za-z][A-Za-z'’.\- ]{1,60}?)(?:\s+(?:from|between)\b|$)/i;
  const subjectStudentMatch = normalized.match(schedulePattern);

  let subject = "Unnamed";
  let student = "Unknown";
  if (subjectStudentMatch) {
    subject = (subjectStudentMatch[1] || "").trim() || subject;
    student = (subjectStudentMatch[2] || "").replace(/\s+(from|between)\b.*$/i, "").trim() || student;
  }
  if (student.toLowerCase() === "me" || student.toLowerCase() === "the student") student = "Unknown";

  return {
    action: "add",
    student,
    subject,
    day_of_week: dayOfWeek,
    start_time: startTime,
    end_time: endTime,
    old_start_time: null,
    old_end_time: null,
    recurring: true,
    specific_date: null,
    lesson_id: null,
    reply: `Got it. ${subject || "a lesson"} with ${student} on ${DAY_NAMES[dayOfWeek]} ${startTime}-${endTime}.`,
  };
}

function parseSimpleRescheduleRequest(message) {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (!/\b(reschedule|move|shift|postpone|change)\b/.test(lower)) return null;

  const dayOfWeek = parseDayFromMessage(lower);
  const specificDate = normalized.match(/\b(\d{4}-\d{2}-\d{2})\b/i)?.[1] || null;

  const timeMatches = [...normalized.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi)];
  if (timeMatches.length < 2) return null;

  const beforeMatch = timeMatches[0];
  const afterMatch = timeMatches[1];
  const oldStartTime = parseTo24Hour(beforeMatch[1], beforeMatch[2], beforeMatch[3]);
  const newStartTime = parseTo24Hour(afterMatch[1], afterMatch[2], afterMatch[3]);
  if (!oldStartTime || !newStartTime) return null;

  const subjectMatch = normalized.match(/\b(?:reschedule|move|shift|postpone|change)\s+([a-zA-Z][a-zA-Z'’.\- ]{1,40})\s+(?:with|for)/i);
  const studentMatch = normalized.match(/\b(?:with|for)\s+([A-Za-z][A-Za-z'’.\- ]{1,60}?)(?:\s+(?:on|at|from|to|for|between|until)\b|$)/i);
  const lessonIdMatch = normalized.match(/\b(?:lesson\s*(?:id\s*)?|id\s*)(\d+)\b/i);

  return {
    action: "reschedule",
    student: studentMatch ? studentMatch[1].trim() : "",
    subject: subjectMatch ? subjectMatch[1].trim() : "",
    day_of_week: dayOfWeek,
    start_time: newStartTime,
    end_time: null,
    old_start_time: oldStartTime,
    old_end_time: null,
    recurring: true,
    specific_date: specificDate,
    lesson_id: lessonIdMatch ? Number(lessonIdMatch[1]) : null,
    reply: `Got it. Rescheduling ${subjectMatch ? subjectMatch[1] : "that lesson"} to ${newStartTime}.`,
  };
}

function parseQuickCancelRequest(message) {
  const normalized = message.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (!/\b(cancel|remove|delete)\b/.test(lower)) return null;

  const lessonIdMatch = lower.match(/\blesson\s*(?:id)?\s*(\d+)\b/i);
  const subjectMatch = normalized.match(/\b(?:cancel|remove|delete)\s+(?:lesson)?\s*([a-zA-Z][a-zA-Z'’.\- ]{1,40})?/i);
  const nameMatch = normalized.match(/\b(?:with|for)\s+([A-Za-z][A-Za-z'’.\- ]{1,60}?)(?:\s+(?:on|at|from|to|between|until|for|that|the)\b|$)/i);
  const specificDate = normalized.match(/\b(\d{4}-\d{2}-\d{2})\b/i)?.[1] || null;
  const dayOfWeek = parseDayFromMessage(lower);

  return {
    action: "cancel",
    student: nameMatch ? nameMatch[1].trim() : "",
    subject: subjectMatch ? subjectMatch[1].trim() : "",
    day_of_week: dayOfWeek,
    start_time: null,
    end_time: null,
    old_start_time: null,
    old_end_time: null,
    recurring: true,
    specific_date: specificDate,
    lesson_id: lessonIdMatch ? Number(lessonIdMatch[1]) : null,
    reply: "Got it. I can queue that cancellation for review.",
  };
}

function parseQuickQuery(message) {
  const lower = String(message || "").toLowerCase();
  if (isNoopMessage(lower) || /\b(what|when|who|list|show)\b/.test(lower)) {
    return {
      action: "query",
      student: null,
      subject: null,
      day_of_week: null,
      start_time: null,
      end_time: null,
      old_start_time: null,
      old_end_time: null,
      recurring: true,
      specific_date: null,
      lesson_id: null,
      reply: "I can help with the schedule. Ask me to add, cancel, or reschedule a lesson.",
    };
  }
  return null;
}

function parseQuickAction(message) {
  const quickQuery = parseQuickQuery(message);
  const fastAdd = parseSimpleAddRequest(message);
  const fastReschedule = parseSimpleRescheduleRequest(message);
  const fastCancel = parseQuickCancelRequest(message);
  return fastAdd || fastCancel || fastReschedule || quickQuery;
}

function isFastActionComplete(action) {
  if (!action) return false;
  if (action.action === "add") {
    return action.day_of_week !== null && action.day_of_week !== undefined && !!action.start_time && !!action.end_time;
  }
  if (action.action === "reschedule") {
    return !!action.start_time;
  }
  if (action.action === "cancel") {
    return action.lesson_id || action.student || action.subject;
  }
  return action.action === "query" || action.action === "delete";
}

function inferLessonMinutes(startTime, endTime) {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  let duration = end - start;
  if (duration <= 0) duration += 24 * 60;
  return Number.isFinite(duration) ? duration : null;
}

function enrichParsedAction(action, lessons) {
  if (!action || action.action !== "reschedule") return action;

  const lessonFromContext = action.lesson_id ? lessons.find((l) => l.id === action.lesson_id && l.active !== false) : findLessonByContext(lessons, action);
  if (!lessonFromContext) return action;

  const enriched = cloneAction(action);
  if (!enriched.lesson_id) enriched.lesson_id = lessonFromContext.id;
  if (!enriched.end_time && enriched.start_time) {
    const duration = inferLessonMinutes(lessonFromContext.start_time, lessonFromContext.end_time);
    if (duration && duration > 0 && Number.isFinite(duration)) {
      enriched.end_time = addMinutesToTime(enriched.start_time, duration);
    }
  }
  return enriched;
}

async function parseActionTwoStage(message, lessons, store, requiresAiReason) {
  const stage1 = parseQuickAction(message);

  if (stage1 && stage1.action === "query") {
    return { action: stage1, reason: "", usedAi: false };
  }

  if (stage1 && isFastActionComplete(stage1)) {
    const quickAction = enrichParsedAction(stage1, lessons);

    if (!requiresAiReason) {
      return { action: quickAction, reason: "", usedAi: false };
    }

    const fastReason = inferReasonFromUserMessage(message);
    if (fastReason) {
      const withReason = cloneAction(quickAction);
      withReason.reason = fastReason;
      return { action: withReason, reason: fastReason, usedAi: false };
    }
  }

  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_NIM_API_KEY is not set in environment");
  }

  if (stage1 && isFastActionComplete(stage1) && requiresAiReason) {
    try {
      const stage2 = await parseActionFromAi(message, lessons, store, true);
      const resolvedAction = enrichParsedAction(stage2 || stage1 || { action: "unknown", reason: null }, lessons);
      const inferredReason = normalizeReason(resolvedAction && resolvedAction.reason);
      const reason = inferredReason || inferReasonFromUserMessage(message);

      if (resolvedAction) {
        resolvedAction.reason = reason || null;
      }

      return {
        action: resolvedAction,
        reason: reason,
        usedAi: true,
      };
    } catch (err) {
      if (err.rateLimited) throw err;
      const quickAction = enrichParsedAction(stage1, lessons);
      if (quickAction) {
        const fastReason = inferReasonFromUserMessage(message) || null;
        quickAction.reason = fastReason;
        return { action: quickAction, reason: fastReason || "", usedAi: true };
      }
      throw err;
    }
  }

  const stage2 = await parseActionFromAi(message, lessons, store, true);
  const resolvedAction = enrichParsedAction(stage2 || stage1 || { action: "unknown", reason: null }, lessons);
  const inferredReason = normalizeReason(resolvedAction && resolvedAction.reason);
  const reason = inferredReason || inferReasonFromUserMessage(message);

  if (resolvedAction) {
    resolvedAction.reason = reason || null;
  }

  return {
    action: resolvedAction,
    reason: reason,
    usedAi: true,
  };
}

function normalizeModelJson(raw) {
  return String(raw || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseModelJson(raw) {
  const cleaned = normalizeModelJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function inferReasonFromRaw(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (text.length <= 12) return "";

  const parsed = parseModelJson(text);
  if (parsed && parsed.reason != null) return normalizeReason(parsed.reason);

  const reasonMatch = text.match(/["']reason["']?\s*:\s*["']([\s\S]*?)["']/i);
  if (reasonMatch && reasonMatch[1]) {
    return normalizeReason(reasonMatch[1]);
  }

  const colonMatch = text.match(/\breason\s*[:：]\s*(.+)/i);
  if (colonMatch && colonMatch[1]) {
    return normalizeReason(colonMatch[1].replace(/[`"']/g, "").trim());
  }

  if (!/no reason|not provided|not specified|not stated|i cannot|i can't|unable to determine/i.test(text.toLowerCase())) {
    return normalizeReason(text.replace(/[`\n\r]+/g, " ").trim());
  }

  return "";
}

function inferReasonFromUserMessage(userMessage) {
  const text = String(userMessage || "").trim();
  const match = text.match(/\b(?:because|so that|as|for)\s+(.+)$/i);
  if (!match) return "";
  const candidate = match[1].trim().replace(/[.\n\r]+$/g, "");
  return normalizeReason(candidate);
}

async function callNim(apiKey, userMessage, lessons, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : NIM_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const lessonsSummary = lessons
    .filter((l) => l.active !== false)
    .map(
      (l) =>
        `id=${l.id} ${l.student} (${l.subject || "no subject"}) ${DAY_NAMES[l.day_of_week]} ${l.start_time}-${l.end_time}${
          l.recurring ? " [weekly]" : ` [one-off ${l.specific_date}]`
        }`
    )
    .join("\n") || "(no lessons scheduled yet)";

  let res;
  try {
    res = await fetch(NIM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: NIM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `CURRENT LESSONS:\n${lessonsSummary}\n\nUSER REQUEST:\n${userMessage}` },
        ],
        temperature: 0.2,
        max_tokens: NIM_MAX_TOKENS,
      }),
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    if (networkErr?.name === "AbortError") {
      const err = new Error(`NIM request timed out after ${timeoutMs}ms`);
      err.code = "NIM_TIMEOUT";
      throw err;
    }
    throw new Error(`Could not reach NIM API: ${networkErr.message || networkErr}`);
  }

  if (!res.ok) {
    clearTimeout(timeoutId);
    const text = await res.text();
    throw new Error(`NIM API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  clearTimeout(timeoutId);
  const raw = data.choices?.[0]?.message?.content?.trim() || "{}";
  const parsed = parseModelJson(raw);
  if (!parsed) {
    throw new Error(`Model did not return valid JSON: ${raw}`);
  }
  return parsed;
}

async function inferReasonOnly(apiKey, userMessage) {
  let res;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NIM_REASON_TIMEOUT_MS);
  try {
    res = await fetch(NIM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: NIM_MODEL,
        messages: [
          {
            role: "system",
            content:
              `You extract only the user's reason from a scheduling request.`
              + ` Return JSON only, and no markdown.`
              + ` The schema is: {"reason":"..."}` 
              + ` Use {"reason":null} when the request has no reason.`,
          },
          {
            role: "user",
            content: userMessage,
          },
        ],
        temperature: 0.1,
        max_tokens: NIM_REASON_MAX_TOKENS,
      }),
    });
  } catch (networkErr) {
    clearTimeout(timeoutId);
    if (networkErr?.name === "AbortError") {
      const err = new Error(`NIM reason extraction timed out after ${NIM_REASON_TIMEOUT_MS}ms`);
      err.code = "NIM_TIMEOUT";
      throw err;
    }
    throw new Error(`Could not reach NIM API for reason extraction: ${networkErr.message || networkErr}`);
  }
  if (!res.ok) {
    clearTimeout(timeoutId);
    const text = await res.text();
    throw new Error(`NIM reason extraction error ${res.status}: ${text}`);
  }
  const data = await res.json();
  clearTimeout(timeoutId);
  const raw = data?.choices?.[0]?.message?.content?.trim() || "";
  const parsed = parseModelJson(raw);
  const reasonFromModel = normalizeReason(parsed?.reason);
  if (reasonFromModel) return reasonFromModel;
  const fromRaw = inferReasonFromRaw(raw);
  if (fromRaw) return fromRaw;
  return inferReasonFromUserMessage(userMessage);
}

async function parseActionFromAi(message, lessons, store, reserveSlot = true) {
  if (reserveSlot) {
    await reserveNimRequestSlot(store);
  }

  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_NIM_API_KEY is not set in environment");
  }

  const action = await callNim(apiKey, message, lessons);
  return action;
}

function formatRateLimitMessage(retryAfterMs) {
  const waitMinutes = Math.max(1, Math.ceil((retryAfterMs || 0) / 1000 / 60));
  return `AI request throttled. Retry in about ${waitMinutes} minute(s).`;
}

async function reserveNimRequestSlot(store) {
  const rateSlot = await canConsumeNimRequestSlot(store, nowInMs());
  if (!rateSlot.allowed) {
    const err = new Error("NIM_RATE_LIMITED");
    err.rateLimited = true;
    err.retryAfterMs = rateSlot.retryAfterMs;
    throw err;
  }
}

exports.handler = async (event) => {
  const user = await getSession(event);
  if (!user) {
    return jsonResponse(401, { error: "unauthorized", detail: "Please log in with email to use the assistant." });
  }

  return innerHandler(event, user);
};

exports.__test = {
  aiDefaults: AI_DEFAULTS,
};

async function innerHandler(event, user) {
  const userId = user.id || user.email;
  const userEmail = user.email;

  if (event.httpMethod === "GET") {
    try {
      const store = getLessonStore(event);
      await recordUserIdentity(store, userId, userEmail);
      const [usage, pendingChanges, userLimit] = await Promise.all([
        readUsage(store, userId),
        readPendingChanges(store),
        getUserPromptLimit(store, userId),
      ]);
      const requests = filterPendingChangesForUser(pendingChanges, userId, userEmail);
      return jsonResponse(200, {
        limit: userLimit,
        used: usage.count,
        remaining: Math.max(0, userLimit - usage.count),
        limitReached: usage.count >= userLimit,
        requests,
        requestRetentionHours: RESOLVED_REQUEST_TTL_HOURS,
      });
    } catch (err) {
      console.error(err);
      return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
    }
  }

  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "method not allowed" });

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  if (!body.message || typeof body.message !== "string") {
    return jsonResponse(400, { error: "message is required" });
  }

  try {
    const store = getLessonStore(event);
    await recordUserIdentity(store, userId, userEmail);

    const [usage, lessons, approvalSettings, userLimit] = await Promise.all([
      readUsage(store, userId),
      readLessons(store),
      readApprovalSettings(store),
      getUserPromptLimit(store, userId),
    ]);

    if (usage.count >= userLimit) {
      if (!usage.maintainerNotified) {
        await notifyMaintainer({
          promptCount: usage.count,
          date: new Date().toISOString().slice(0, 10),
        });
        await writeUsage(store, userId, {
          ...usage,
          userEmail,
          maintainerNotified: true,
        });
      }

      return jsonResponse(200, {
        action: {
          action: "limit_reached",
          reply:
            "Daily limit reached. I can't take more requests today. The maintainer has been notified, try again tomorrow.",
        },
        applied: false,
        limitReached: true,
        limit: userLimit,
        used: usage.count,
        remaining: 0,
      });
    }

    const nextUsage = { ...usage, userEmail, count: usage.count + 1 };
    const requiresAiReason =
      approvalSettings.mode === "automatic" &&
      approvalSettings.auto &&
      approvalSettings.auto.requireReason === true;

    await writeUsage(store, userId, nextUsage);
    let action;
    let inferredReason = "";
    try {
      const parseResult = await parseActionTwoStage(body.message, lessons, store, requiresAiReason);
      action = parseResult.action;
      inferredReason = parseResult.reason || "";
      if (!action || action.action === "query") {
        return jsonResponse(200, { action, applied: false, limit: userLimit, used: nextUsage.count });
      }
    } catch (err) {
      if (err.rateLimited) {
        return jsonResponse(429, {
          action: {
            action: "query",
            reply: formatRateLimitMessage(err.retryAfterMs),
          },
          applied: false,
          rateLimited: true,
          rateLimit: {
            limitPerMinute: NIM_RATE_LIMIT_PER_WINDOW,
            windowMs: NIM_RATE_WINDOW_MS,
            retryAfterMs: err.retryAfterMs,
          },
        });
      }
      if (err.code === "NIM_TIMEOUT") {
        return jsonResponse(503, {
          action: {
            action: "query",
            reply: "The assistant timed out while reasoning. If this is a scheduling request, try again.",
          },
          applied: false,
          timedOut: true,
          error: "timeout",
        });
      }
      return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
    }

    if (action.action === "query" || action.action === "unknown" || !action.action) {
      return jsonResponse(200, { action, applied: false, limit: userLimit, used: nextUsage.count });
    }

    if (action.action === "add") {
      if (action.day_of_week === null || action.day_of_week === undefined || !action.start_time || !action.end_time) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "I need a day and start/end time to add this lesson." },
          applied: false,
          limit: userLimit,
          used: nextUsage.count,
        });
      }
      const reason = inferredReason;
      const result = await applyActionOrQueue(
        store,
        action,
        body.message,
        userId,
        lessons,
        approvalSettings,
        reason,
        userEmail
      );
      return jsonResponse(result.applied ? 201 : 200, { ...result, limit: userLimit, used: nextUsage.count });
    }

    if (action.action === "delete") {
      if (!action.lesson_id) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "Which lesson should I delete? Please specify." },
          applied: false,
          limit: userLimit,
          used: nextUsage.count,
        });
      }
      const reason = inferredReason;
      const result = await applyActionOrQueue(
        store,
        action,
        body.message,
        userId,
        lessons,
        approvalSettings,
        reason,
        userEmail
      );
      return jsonResponse(result.applied ? 200 : 200, { ...result, limit: userLimit, used: nextUsage.count });
    }

    if (action.action === "cancel") {
      if (!action.lesson_id || !action.specific_date) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "Which lesson, and which date, should I cancel?" },
          applied: false,
          limit: userLimit,
          used: nextUsage.count,
        });
      }
      const reason = inferredReason;
      const result = await applyActionOrQueue(
        store,
        action,
        body.message,
        userId,
        lessons,
        approvalSettings,
        reason,
        userEmail
      );
      return jsonResponse(result.applied ? 201 : 200, { ...result, limit: userLimit, used: nextUsage.count });
    }

    if (action.action === "reschedule") {
      if (!action.lesson_id && !action.student && !action.subject) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "I need the lesson subject/student to reschedule." },
          applied: false,
          limit: userLimit,
          used: nextUsage.count,
        });
      }

      if (!action.start_time) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "I need a new start time to reschedule." },
          applied: false,
          limit: userLimit,
          used: nextUsage.count,
        });
      }

      const reason = inferredReason;
      const result = await applyActionOrQueue(
        store,
        action,
        body.message,
        userId,
        lessons,
        approvalSettings,
        reason,
        userEmail
      );
      return jsonResponse(result.applied ? 201 : 200, { ...result, limit: userLimit, used: nextUsage.count });
    }

    return jsonResponse(200, { action, applied: false, limit: userLimit, used: nextUsage.count });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
}
