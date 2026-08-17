const crypto = require("crypto");
const {
  getLessonStore,
  readLessons,
  readExceptions,
  readCalendarEvents,
  writeCalendarEvents,
  jsonResponse,
  nextId,
} = require("./_store");
const { getAdminSession } = require("./_auth");
const {
  parseCalendar,
  mergeCalendarEvents,
  buildScheduleCalendar,
} = require("./_ics");
const { studioTimezone, zonedLocalToUtc, findLessonConflictForEvent, findCalendarEventConflict, currentStudioWeek, studioMonth, expandCalendarEvents } = require("./_schedule");

const MAX_CALENDAR_BYTES = 2 * 1024 * 1024;
const EVENT_TYPES = new Set(["concert", "rehearsal", "unavailable"]);

async function readCalendarResponse(response) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CALENDAR_BYTES) {
    const error = new Error("Calendar files must be 2 MB or smaller.");
    error.code = "CALENDAR_TOO_LARGE";
    throw error;
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_CALENDAR_BYTES) {
      const error = new Error("Calendar files must be 2 MB or smaller.");
      error.code = "CALENDAR_TOO_LARGE";
      throw error;
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CALENDAR_BYTES) {
      await reader.cancel();
      const error = new Error("Calendar files must be 2 MB or smaller.");
      error.code = "CALENDAR_TOO_LARGE";
      throw error;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function normalizedIcloudUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value.replace(/^webcal:\/\//i, "https://"));
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (hostname !== "icloud.com" && !hostname.endsWith(".icloud.com"))) {
    return null;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

function normalizeManualEvent(raw, id) {
  const title = String(raw?.title || "").trim();
  const eventType = EVENT_TYPES.has(raw?.eventType) ? raw.eventType : "unavailable";
  const rawStart = String(raw?.start || "").trim();
  const rawEnd = String(raw?.end || "").trim();
  const timezone = raw?.timezone ? String(raw.timezone).slice(0, 120) : studioTimezone();
  const normalizeDateTime = (value) => {
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(value)) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace(".000Z", "Z");
    }
    return zonedLocalToUtc(value.slice(0, 10), value.slice(11, 19), timezone);
  };
  const start = normalizeDateTime(rawStart);
  const end = normalizeDateTime(rawEnd);
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (!title) return { error: "Event title is required." };
  if (!start || !end || Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return { error: "Valid start and end dates are required." };
  }
  if (startDate.getTime() >= endDate.getTime()) return { error: "Event start must be before its end." };
  return {
    event: {
      id,
      uid: String(raw?.uid || `event-${crypto.randomUUID()}@studio-stage`),
      title: title.slice(0, 240),
      eventType,
      start,
      end,
      timezone,
      allDay: Boolean(raw?.allDay),
      location: String(raw?.location || "").trim().slice(0, 500),
      notes: String(raw?.notes || "").trim().slice(0, 4000),
      recurrence: raw?.recurrence ? String(raw.recurrence).slice(0, 500) : null,
      source: String(raw?.source || "manual").slice(0, 160),
      private: true,
    },
  };
}

function calendarDisplayOccurrences(events, week) {
  return expandCalendarEvents(events, week).flatMap((calendarEvent) => {
    const segments = calendarEvent.displaySegments?.length
      ? calendarEvent.displaySegments
      : [{ date: calendarEvent.date, startTime: calendarEvent.startTime, endTime: calendarEvent.endTime }];
    return segments.map((segment) => ({
      ...calendarEvent,
      date: segment.date,
      startTime: segment.startTime,
      endTime: segment.endTime,
      occurrenceId: `${calendarEvent.occurrenceId}:${segment.date}`,
    }));
  });
}

async function importCalendarText(store, calendarText, source) {
  const text = String(calendarText || "");
  if (!text.trim()) return { error: "Choose a non-empty .ics calendar file." };
  if (Buffer.byteLength(text, "utf8") > MAX_CALENDAR_BYTES) {
    return { error: "Calendar files must be 2 MB or smaller." };
  }
  let parsed;
  try {
    parsed = parseCalendar(text, { source });
  } catch (parseError) {
    return { error: String(parseError.message || "This file is not a valid iCalendar calendar.") };
  }
  if (!parsed.events.length) return { error: "No usable events were found in this calendar." };
  const existing = await readCalendarEvents(store);
  const merged = mergeCalendarEvents(existing, parsed.events);
  await writeCalendarEvents(store, merged.events);
  return { ...merged, skipped: parsed.skipped };
}

exports.handler = async (event) => {
  const auth = await getAdminSession(event);
  if (!auth.ok) return jsonResponse(auth.status, { error: auth.reason, detail: auth.reason });

  try {
    const store = getLessonStore(event);

    if (event.httpMethod === "GET") {
      const [events, lessons] = await Promise.all([readCalendarEvents(store), readLessons(store)]);
      if (event.queryStringParameters?.format === "ics") {
        const calendar = buildScheduleCalendar({ lessons, events, calendarName: "Studio & Stage" });
        return {
          statusCode: 200,
          headers: {
            "Content-Type": calendar.contentType,
            "Content-Disposition": `attachment; filename="${calendar.filename}"`,
            "Cache-Control": "no-store",
          },
          body: calendar.content,
        };
      }
      const requestedMonth = event.queryStringParameters?.month;
      const scheduleRange = requestedMonth ? studioMonth({ month: requestedMonth }) : currentStudioWeek();
      if (!scheduleRange) return jsonResponse(400, { error: "month must be YYYY-MM" });
      const occurrences = calendarDisplayOccurrences(events, scheduleRange);
      return jsonResponse(200, {
        events,
        occurrences,
        week: requestedMonth ? undefined : scheduleRange,
        month: requestedMonth ? scheduleRange.month : undefined,
        range: scheduleRange,
      });
    }

    if (event.httpMethod === "POST") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return jsonResponse(400, { error: "Invalid JSON body." });
      }

      if (body.operation === "import_ics") {
        const sourceName = String(body.sourceName || "Apple Calendar").trim().slice(0, 120);
        const result = await importCalendarText(store, body.calendarText, `file:${sourceName}`);
        if (result.error) return jsonResponse(400, { error: result.error });
        return jsonResponse(200, result);
      }

      if (body.operation === "import_url") {
        const url = normalizedIcloudUrl(body.url);
        if (!url) return jsonResponse(400, { error: "Enter a public iCloud Calendar URL." });
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        let response;
        let calendarText;
        try {
          response = await fetch(url, {
            headers: { Accept: "text/calendar" },
            redirect: "error",
            signal: controller.signal,
          });
          if (response.ok) calendarText = await readCalendarResponse(response);
        } catch (fetchError) {
          if (fetchError?.code === "CALENDAR_TOO_LARGE") {
            return jsonResponse(413, { error: fetchError.message });
          }
          return jsonResponse(502, {
            error: fetchError?.name === "AbortError" ? "iCloud calendar refresh timed out." : "Could not reach that iCloud calendar.",
          });
        } finally {
          clearTimeout(timeoutId);
        }
        if (!response.ok) return jsonResponse(502, { error: `iCloud returned HTTP ${response.status}.` });
        const result = await importCalendarText(store, calendarText, `icloud:${new URL(url).hostname}`);
        if (result.error) return jsonResponse(400, { error: result.error });
        return jsonResponse(200, result);
      }

      if (body.operation === "save_event") {
        const [events, lessons, exceptions] = await Promise.all([
          readCalendarEvents(store),
          readLessons(store),
          readExceptions(store),
        ]);
        const requestedId = Number(body.event?.id);
        const id = Number.isFinite(requestedId) && requestedId > 0 ? requestedId : nextId(events);
        const normalized = normalizeManualEvent(body.event, id);
        if (normalized.error) return jsonResponse(400, { error: normalized.error });
        const conflict = findCalendarEventConflict(events, normalized.event, { timezone: studioTimezone(), excludeId: id });
        if (conflict) {
          return jsonResponse(409, { error: `Conflicts with another commitment from ${conflict.start} to ${conflict.end}.` });
        }
        const lessonConflict = findLessonConflictForEvent(lessons, exceptions, normalized.event, { timezone: studioTimezone() });
        if (lessonConflict) {
          return jsonResponse(409, { error: `Conflicts with ${lessonConflict.student}'s lesson from ${lessonConflict.start_time} to ${lessonConflict.end_time}.` });
        }
        const nextEvents = events.filter((item) => item.id !== id);
        nextEvents.push(normalized.event);
        nextEvents.sort((a, b) => a.start.localeCompare(b.start));
        await writeCalendarEvents(store, nextEvents);
        return jsonResponse(requestedId ? 200 : 201, { event: normalized.event });
      }

      return jsonResponse(400, { error: "Unknown calendar operation." });
    }

    if (event.httpMethod === "DELETE") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return jsonResponse(400, { error: "Invalid JSON body." });
      }
      const id = Number(body.id);
      if (!Number.isFinite(id)) return jsonResponse(400, { error: "Event id is required." });
      const events = await readCalendarEvents(store);
      const nextEvents = events.filter((item) => item.id !== id);
      if (nextEvents.length === events.length) return jsonResponse(404, { error: "Event not found." });
      await writeCalendarEvents(store, nextEvents);
      return jsonResponse(200, { deleted: id });
    }

    return jsonResponse(405, { error: "method not allowed" });
  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: "internal error", detail: String(err.message || err) });
  }
};

module.exports.normalizedIcloudUrl = normalizedIcloudUrl;
module.exports.normalizeManualEvent = normalizeManualEvent;
