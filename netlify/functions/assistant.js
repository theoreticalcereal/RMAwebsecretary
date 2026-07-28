
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
  jsonResponse,
  nextId,
  timesOverlap,
} = require("./_store");
const { notifyMaintainer } = require("./_notify");
const { getSession } = require("./_auth");

const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NIM_MODEL = "meta/llama-3.1-70b-instruct";

const DAILY_PROMPT_LIMIT = 5;

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
  "action": "add" | "cancel" | "delete" | "query" | "unknown",
  "student": string or null,
  "subject": string or null,
  "day_of_week": integer 0-6 (Monday=0, Sunday=6) or null,
  "start_time": "HH:MM" (24-hour) or null,
  "end_time": "HH:MM" (24-hour) or null,
  "recurring": true or false,
  "specific_date": "YYYY-MM-DD" or null,
  "lesson_id": integer or null,
  "reply": string (a short, plain confirmation or clarifying question to show the user)
}

Rules:
- "add" means create a new lesson (recurring weekly unless the user specifies a one-off date).
- "cancel" means cancel a single upcoming occurrence of an existing recurring lesson (needs lesson_id and specific_date if you can determine them from context; otherwise set action to "unknown" and ask in "reply").
- "delete" means remove a recurring lesson entirely.
- "query" means the user is just asking a question (e.g. "what's on Tuesday") — set reply to a helpful answer using the CURRENT LESSONS provided below, action "query".
- If the request is ambiguous or missing required info (e.g. no time given), use action "unknown" and ask a clarifying question in "reply".
- Never invent a lesson_id — only use one that appears in CURRENT LESSONS below.`;

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

function nextOccurenceOnOrAfter(date, dayIndex, timeHHMM) {
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

function extractReasonFromMessage(message) {
  const raw = String(message || "").trim();
  const match = raw.match(/\b(?:because|reason|reasoning)\b\s*:\s*(.+)$/i)
    || raw.match(/\b(?:because|since|due to|as a result of)\b\s+(.+)$/i);
  if (!match) return "";
  return match[1].trim();
}

function findPotentialConflict(lessons, action) {
  return lessons.find(
    (l) =>
      l.active !== false &&
      l.day_of_week === action.day_of_week &&
      timesOverlap(l.start_time, l.end_time, action.start_time, action.end_time)
  );
}

function meetsReasonRules(rawReason, settings) {
  if (!settings.auto.requireReason) return { ok: true, reason: rawReason };
  const reason = (rawReason || "").trim();
  if (!reason) return { ok: false, issue: "A valid reason is required before auto-approving." };
  if (reason.length < settings.auto.minReasonLength) {
    return {
      ok: false,
      issue: `The reason must be at least ${settings.auto.minReasonLength} characters long before auto-approving.`,
    };
  }
  return { ok: true, reason };
}

function minutesUntil(targetDate, now = nowInMs()) {
  if (!targetDate) return Number.POSITIVE_INFINITY;
  return (new Date(targetDate).getTime() - now) / (60 * 60 * 1000);
}

function canAutoApprove(changeAction, pendingRequestMessage, settings, lessons) {
  if (settings.mode !== "automatic") return { ok: false, autoRejected: false, reason: "manual_mode" };

  const auto = settings.auto || {};
  const minHoursBefore = Number(auto.minHoursBefore ?? 24);
  const reasonCheck = meetsReasonRules(extractReasonFromMessage(pendingRequestMessage), settings);
  if (!reasonCheck.ok) {
    return { ok: false, autoRejected: true, reason: reasonCheck.issue, requiredAction: "manual_review" };
  }

  if (changeAction.action === "add") {
    const nextOccurrence = nextOccurenceOnOrAfter(new Date(), changeAction.day_of_week, changeAction.start_time);
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
    const nextOccurrence = nextOccurenceOnOrAfter(new Date(), lesson.day_of_week, lesson.start_time);
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
      return { ok: false, autoRejected: true, reason: "Specific date is missing or invalid.", requiredAction: "manual_review" };
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

async function applyActionOrQueue(store, action, userMessage, userId, lessons, settings, reasonText, userEmail) {
  if (settings.mode === "manual") {
    const pending = await queuePendingChange(store, action, reasonText, userId, userMessage, userEmail);
    return createAutoRejectResponse(action, "This request has been queued for manual review.", pending);
  }

  const autoDecision = canAutoApprove(action, userMessage, settings, lessons);
  if (!autoDecision.ok) {
    const pending = await queuePendingChange(store, action, reasonText, userId, userMessage, userEmail);
    return createAutoRejectResponse(
      action,
      autoDecision.reason || "This request has been queued for manual review.",
      pending
    );
  }

  if (action.action === "add") {
    const conflict = findPotentialConflict(lessons, action);
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

  return { action, applied: false };
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

  if (startTime >= endTime) return null;

  const dayMatch = lower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (!dayMatch) return null;
  const dayOfWeek = DAY_NAME_TO_INDEX[dayMatch[1].toLowerCase()];

  const schedulePattern = /\b(?:schedule|add|book|create)\s+(.+?)\s+(?:with|for)\s+([A-Za-z][A-Za-z'’.\- ]{1,60}?)(?:\s+(?:from|between|on|at)\b|$)/i;
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
    recurring: true,
    specific_date: null,
    lesson_id: null,
    reply: `Got it — scheduling ${subject || "a lesson"} with ${student} on ${DAY_NAMES[dayOfWeek]} ${startTime}-${endTime}.`,
  };
}

async function callNim(apiKey, userMessage, lessons) {
  const lessonsSummary = lessons
    .filter((l) => l.active !== false)
    .map((l) => `id=${l.id} ${l.student} (${l.subject || "no subject"}) ${DAY_NAMES[l.day_of_week]} ${l.start_time}-${l.end_time}${l.recurring ? " [weekly]" : ` [one-off ${l.specific_date}]`}`)
    .join("\n") || "(no lessons scheduled yet)";

  let res;
  try {
    res = await fetch(NIM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: NIM_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `CURRENT LESSONS:\n${lessonsSummary}\n\nUSER REQUEST:\n${userMessage}` },
        ],
        temperature: 0.2,
        max_tokens: 220,
      }),
    });
  } catch (networkErr) {
    throw new Error(`Could not reach NIM API: ${networkErr.message || networkErr}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NIM API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content?.trim() || "{}";
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`Model did not return valid JSON: ${raw}`);
  }
}

exports.handler = async (event) => {
  const user = await getSession(event);
  if (!user) {
    return jsonResponse(401, { error: "unauthorized", detail: "Please log in with email to use the assistant." });
  }

  return innerHandler(event, user);
};

async function innerHandler(event, user) {
  const userId = user.id || user.email;
  const userEmail = user.email;
  if (event.httpMethod === "GET") {
    try {
      const store = getLessonStore(event);
      await recordUserIdentity(store, userId, userEmail);
      const [usage, pendingChanges] = await Promise.all([
        readUsage(store, userId),
        readPendingChanges(store),
      ]);
      const requests = filterPendingChangesForUser(pendingChanges, userId, userEmail);
      return jsonResponse(200, {
        limit: DAILY_PROMPT_LIMIT,
        used: usage.count,
        remaining: Math.max(0, DAILY_PROMPT_LIMIT - usage.count),
        limitReached: usage.count >= DAILY_PROMPT_LIMIT,
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

    const [usage, lessons, approvalSettings] = await Promise.all([
      readUsage(store, userId),
      readLessons(store),
      readApprovalSettings(store),
    ]);

    if (usage.count >= DAILY_PROMPT_LIMIT) {
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
          reply: "I can't help with any more requests today. I've reached my daily limit. The maintainer has been notified, please reach out to them directly, or try again tomorrow.",
        },
        applied: false,
        limitReached: true,
      });
    }

    const nextUsage = { ...usage, userEmail, count: usage.count + 1 };
    const fastAction = parseSimpleAddRequest(body.message);
    if (fastAction) {
      await writeUsage(store, userId, nextUsage);
      const action = fastAction;
      if (action.day_of_week === null || action.day_of_week === undefined || !action.start_time || !action.end_time) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "I need a day and start/end time to add this lesson." },
          applied: false,
        });
      }

      const reason = extractReasonFromMessage(body.message);
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
      return jsonResponse(result.applied ? 201 : 200, result);
    }

    const apiKey = process.env.NVIDIA_NIM_API_KEY;
    if (!apiKey) return jsonResponse(500, { error: "NVIDIA_NIM_API_KEY is not set in environment" });

    await writeUsage(store, userId, nextUsage);
    const action = await callNim(apiKey, body.message, lessons);

    if (action.action === "query" || action.action === "unknown" || !action.action) {
      return jsonResponse(200, { action, applied: false });
    }

    if (action.action === "add") {
      if (action.day_of_week === null || action.day_of_week === undefined || !action.start_time || !action.end_time) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "I need a day and start/end time to add this lesson." },
          applied: false,
        });
      }

      const reason = extractReasonFromMessage(body.message);
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
      return jsonResponse(result.applied ? 201 : 200, result);
    }

    if (action.action === "delete") {
      if (!action.lesson_id) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "Which lesson should I delete? Please specify." },
          applied: false,
        });
      }

      const reason = extractReasonFromMessage(body.message);
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
      return jsonResponse(result.applied ? 200 : 200, result);
    }

    if (action.action === "cancel") {
      if (!action.lesson_id || !action.specific_date) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "Which lesson, and which date, should I cancel?" },
          applied: false,
        });
      }
      const reason = extractReasonFromMessage(body.message);
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
      return jsonResponse(result.applied ? 201 : 200, result);
    }

    return jsonResponse(200, { action, applied: false });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
}
