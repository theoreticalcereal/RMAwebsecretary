// Public natural-language assistant, powered by NVIDIA NIM. This is the
// ONLY way public users can create, cancel, or delete lessons - there is
// no manual add form on the public page anymore. The maintainer can still
// manage lessons directly through the admin dashboard.
//
// Adds a daily cap of 5 prompts PER authenticated user, tracked server-side
// in Blobs. This prevents unbounded usage and gives a clear identity basis
// for usage reporting. Also sends a one-time-per-user maintainer email via
// Resend when that user's cap is first exceeded.
//
// GET  /api/assistant  -> today's usage status for this user, without consuming a prompt
// POST /api/assistant  { "message": "..." } -> parse + apply via NIM

const {
  getLessonStore,
  readLessons,
  writeLessons,
  readExceptions,
  writeExceptions,
  readUsage,
  writeUsage,
  jsonResponse,
  nextId,
  timesOverlap,
} = require("./_store");
const { notifyMaintainer } = require("./_notify");
const { getSession } = require("./_auth");

const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
// Any NIM chat model works here; this one is small/fast and free-tier friendly.
const NIM_MODEL = "meta/llama-3.1-70b-instruct";

// Daily cap on assistant prompts per user, to prevent runaway NIM API usage.
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

  const startPeriod = timeMatch[3];
  const endPeriod = timeMatch[6] || startPeriod;
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
    // Network-level failure reaching NIM (DNS, timeout, connection refused).
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

  const userId = user.id || user.email;
  const response = await innerHandler(event, userId);
  return response;
};

async function innerHandler(event, userId) {
  // GET: report today's usage without consuming a prompt. Lets the
  // frontend show "N of 5 left" and disable the input on load.
  if (event.httpMethod === "GET") {
    try {
      const store = getLessonStore(event);
      const usage = await readUsage(store, userId);
      return jsonResponse(200, {
        limit: DAILY_PROMPT_LIMIT,
        used: usage.count,
        remaining: Math.max(0, DAILY_PROMPT_LIMIT - usage.count),
        limitReached: usage.count >= DAILY_PROMPT_LIMIT,
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
    const [usage, lessons] = await Promise.all([readUsage(store, userId), readLessons(store)]);

    if (usage.count >= DAILY_PROMPT_LIMIT) {
      // Only email the maintainer once per user per day, the first time
      // that user's cap is exceeded, not on every subsequent blocked request.
      if (!usage.maintainerNotified) {
        await notifyMaintainer({
          promptCount: usage.count,
          date: new Date().toISOString().slice(0, 10),
        });
        await writeUsage(store, userId, { ...usage, maintainerNotified: true });
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

    const nextUsage = { ...usage, count: usage.count + 1 };
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

      const conflict = lessons.find(
        (l) =>
          l.active !== false &&
          l.day_of_week === action.day_of_week &&
          timesOverlap(l.start_time, l.end_time, action.start_time, action.end_time)
      );
      if (conflict) {
        return jsonResponse(200, {
          action: {
            ...action,
            action: "unknown",
            reply: `That conflicts with ${conflict.student}'s lesson on ${DAY_NAMES[conflict.day_of_week]} ${conflict.start_time}-${conflict.end_time}.`,
          },
          applied: false,
        });
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
      return jsonResponse(201, { action, applied: true, lesson });
    }

    const apiKey = process.env.NVIDIA_NIM_API_KEY;
    if (!apiKey) return jsonResponse(500, { error: "NVIDIA_NIM_API_KEY is not set in environment" });

    await writeUsage(store, userId, nextUsage);
    const action = await callNim(apiKey, body.message, lessons);

    // Query / unknown: nothing to apply, just return the model's reply.
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

      const conflict = lessons.find(
        (l) =>
          l.active !== false &&
          l.day_of_week === action.day_of_week &&
          timesOverlap(l.start_time, l.end_time, action.start_time, action.end_time)
      );
      if (conflict) {
        return jsonResponse(200, {
          action: {
            ...action,
            action: "unknown",
            reply: `That conflicts with ${conflict.student}'s lesson on ${DAY_NAMES[conflict.day_of_week]} ${conflict.start_time}-${conflict.end_time}.`,
          },
          applied: false,
        });
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
      return jsonResponse(201, { action, applied: true, lesson });
    }

    if (action.action === "delete") {
      if (!action.lesson_id) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "Which lesson should I delete? Please specify." },
          applied: false,
        });
      }
      const filtered = lessons.filter((l) => l.id !== action.lesson_id);
      if (filtered.length === lessons.length) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "I couldn't find that lesson." },
          applied: false,
        });
      }
      await writeLessons(store, filtered);
      return jsonResponse(200, { action, applied: true, deleted: action.lesson_id });
    }

    if (action.action === "cancel") {
      if (!action.lesson_id || !action.specific_date) {
        return jsonResponse(200, {
          action: { ...action, action: "unknown", reply: "Which lesson, and which date, should I cancel?" },
          applied: false,
        });
      }
      const exceptions = await readExceptions(store);
      const exception = {
        id: nextId(exceptions),
        lesson_id: action.lesson_id,
        exception_date: action.specific_date,
        status: "cancelled",
      };
      exceptions.push(exception);
      await writeExceptions(store, exceptions);
      return jsonResponse(201, { action, applied: true, exception });
    }

    return jsonResponse(200, { action, applied: false });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
}
