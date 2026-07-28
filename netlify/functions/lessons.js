// Manual scheduler
//
// GET    /api/lessons      -> list all lessons + exceptions
// POST   /api/lessons      -> add a lesson { student, subject, day_of_week, start_time, end_time, recurring, specific_date }
// PUT    /api/lessons      -> update a lesson (pass id in body as "id")
// DELETE /api/lessons      -> delete a lesson (pass id in body as "id")

const {
  getLessonStore,
  readLessons,
  writeLessons,
  readExceptions,
  jsonResponse,
  nextId,
  timesOverlap,
} = require("./_store");

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

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

exports.handler = async (event) => {
  const store = getLessonStore(event);

  try {
    if (event.httpMethod === "GET") {
      const [lessons, exceptions] = await Promise.all([readLessons(store), readExceptions(store)]);
      return jsonResponse(200, { lessons, exceptions, dayNames: DAY_NAMES });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const errors = validateLesson(body);
      if (errors.length) return jsonResponse(400, { errors });

      const lessons = await readLessons(store);

      // Conflict check against other active lessons on the same day
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
    return jsonResponse(500, { error: "internal error", detail: String(err) });
  }
};
