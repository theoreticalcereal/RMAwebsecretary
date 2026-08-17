const { getStore, connectLambda } = require("@netlify/blobs");

function getLessonStore(event) {
  try {
    connectLambda(event);
    return getStore({ name: "lesson-secretary" });
  } catch (err) {
    throw new Error(`Failed to initialize Blobs store: ${err.message || err}`);
  }
}

async function readLessons(store) {
  const data = await store.get("lessons", { type: "json" });
  return data || [];
}

async function writeLessons(store, lessons) {
  await store.setJSON("lessons", lessons);
}

async function readExceptions(store) {
  const data = await store.get("exceptions", { type: "json" });
  return data || [];
}

async function writeExceptions(store, exceptions) {
  await store.setJSON("exceptions", exceptions);
}

async function readCalendarEvents(store) {
  const data = await store.get("calendar_events", { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function writeCalendarEvents(store, events) {
  await store.setJSON("calendar_events", Array.isArray(events) ? events : []);
}

function todayKey(userId) {
  return `usage:${new Date().toISOString().slice(0, 10)}:${userId}`;
}

const USAGE_SETTINGS_KEY = "usage_settings";
const USER_DAILY_LIMITS_KEY = "user_daily_limits";
const APPROVAL_SETTINGS_KEY = "approval_settings";
const PENDING_CHANGES_KEY = "pending_changes";
const USER_IDENTITY_MAP_KEY = "user_identity_map";
const NIM_REQUEST_TRACKING_KEY = "nim_request_timestamps";
const REMINDER_SETTINGS_PREFIX = "reminder_settings:";
const OFF_TIME_WINDOWS_KEY = "off_time_windows";
const WORKING_HOURS_KEY = "working_hours";

const DEFAULT_DAILY_PROMPT_LIMIT = 5;
const NIM_RATE_WINDOW_MS = 60 * 1000;
const NIM_RATE_LIMIT_PER_WINDOW = 40;
const RESOLVED_REQUEST_TTL_HOURS = 24;
const RESOLVED_REQUEST_TTL_MS = RESOLVED_REQUEST_TTL_HOURS * 60 * 60 * 1000;

function normalizeUsageLimit(rawLimit, fallback = DEFAULT_DAILY_PROMPT_LIMIT) {
  const n = Number(rawLimit);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

async function readUsage(store, userId) {
  const data = await store.get(todayKey(userId), { type: "json" });
  return {
    count: data?.count ?? 0,
    maintainerNotified: data?.maintainerNotified ?? false,
    userEmail: data?.userEmail || null,
  };
}

async function writeUsage(store, userId, usage) {
  await store.setJSON(todayKey(userId), usage);
}

async function getUsageSettings(store) {
  const data = await store.get(USAGE_SETTINGS_KEY, { type: "json" });
  return {
    defaultDailyPromptLimit: normalizeUsageLimit(data?.defaultDailyPromptLimit, DEFAULT_DAILY_PROMPT_LIMIT),
  };
}

async function writeUsageSettings(store, settings) {
  await store.setJSON(USAGE_SETTINGS_KEY, {
    defaultDailyPromptLimit: normalizeUsageLimit(settings?.defaultDailyPromptLimit, DEFAULT_DAILY_PROMPT_LIMIT),
  });
}

async function readUserDailyLimits(store) {
  const data = await store.get(USER_DAILY_LIMITS_KEY, { type: "json" });
  if (!data || typeof data !== "object") return {};
  return data;
}

async function writeUserDailyLimits(store, limits) {
  await store.setJSON(USER_DAILY_LIMITS_KEY, limits || {});
}

async function getUserPromptLimit(store, userId) {
  const [settings, limits] = await Promise.all([getUsageSettings(store), readUserDailyLimits(store)]);
  const normalizedUserId = String(userId || "").trim();
  return normalizeUsageLimit(limits[normalizedUserId], settings.defaultDailyPromptLimit);
}

async function setUserPromptLimit(store, userId, promptLimit) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;

  const value = normalizeUsageLimit(promptLimit, NaN);
  const limits = await readUserDailyLimits(store);

  if (!Number.isFinite(value)) {
    delete limits[normalizedUserId];
    await writeUserDailyLimits(store, limits);
    return getUserPromptLimit(store, normalizedUserId);
  }

  limits[normalizedUserId] = value;
  await writeUserDailyLimits(store, limits);
  return value;
}

async function resetUserPromptLimit(store, userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;

  const limits = await readUserDailyLimits(store);
  if (!Object.prototype.hasOwnProperty.call(limits, normalizedUserId)) {
    return getUserPromptLimit(store, normalizedUserId);
  }

  delete limits[normalizedUserId];
  await writeUserDailyLimits(store, limits);
  return getUserPromptLimit(store, normalizedUserId);
}

async function resetUserUsage(store, userId, fallbackEmail) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;

  const current = await readUsage(store, normalizedUserId);
  await writeUsage(store, normalizedUserId, {
    ...current,
    count: 0,
    maintainerNotified: false,
    userEmail: fallbackEmail || current.userEmail || null,
  });

  return { userId: normalizedUserId, count: 0, maintainerNotified: false };
}

async function resetAllUsage(store) {
  const prefix = `usage:${new Date().toISOString().slice(0, 10)}:`;
  const listing = await store.list({ prefix });
  const blobs = listing?.blobs || [];

  for (const blob of blobs) {
    const userId = String(blob.key || "").slice(prefix.length);
    const current = await readUsage(store, userId);
    await writeUsage(store, userId, {
      ...current,
      count: 0,
      maintainerNotified: false,
    });
  }
}

async function readApprovalSettings(store) {
  const data = await store.get(APPROVAL_SETTINGS_KEY, { type: "json" });
  if (!data) {
    return {
      mode: "manual",
      auto: {
        minHoursBefore: 24,
        requireReason: true,
        minReasonLength: 10,
      },
    };
  }

  return {
    mode: data.mode === "automatic" ? "automatic" : "manual",
    auto: {
      minHoursBefore: Math.max(0, Math.floor(Number(data?.auto?.minHoursBefore ?? 24))),
      requireReason: typeof data?.auto?.requireReason === "boolean" ? data.auto.requireReason : true,
      minReasonLength: Math.max(0, Math.floor(Number(data?.auto?.minReasonLength ?? 10))),
    },
  };
}

async function writeApprovalSettings(store, settings) {
  await store.setJSON(APPROVAL_SETTINGS_KEY, settings);
}

async function readNimRequestTimestamps(store) {
  const data = await store.get(NIM_REQUEST_TRACKING_KEY, { type: "json" });
  return Array.isArray(data) ? data.filter((entry) => Number.isFinite(Number(entry))) : [];
}

async function canConsumeNimRequestSlot(store, nowMs = Date.now()) {
  const requests = await readNimRequestTimestamps(store);
  const cutoff = nowMs - NIM_RATE_WINDOW_MS;
  const inWindow = requests.filter((ts) => Number(ts) >= cutoff);

  if (inWindow.length >= NIM_RATE_LIMIT_PER_WINDOW) {
    const oldest = Math.min(...inWindow);
    return {
      allowed: false,
      inWindowCount: inWindow.length,
      retryAfterMs: Math.max(0, NIM_RATE_WINDOW_MS - (nowMs - oldest)),
    };
  }

  inWindow.push(nowMs);
  await store.setJSON(NIM_REQUEST_TRACKING_KEY, inWindow.sort((a, b) => a - b));
  return { allowed: true, inWindowCount: inWindow.length, retryAfterMs: 0 };
}

const REMINDER_DELIVERIES = new Set(["none", "email", "calendar", "email_calendar"]);
const REMINDER_OFFSETS = new Set([0, 15, 60, 1440]);
const DEFAULT_REMINDER_SETTINGS = Object.freeze({
  delivery: "email_calendar",
  offsetsMinutes: [60],
});

function normalizeReminderSettings(settings) {
  const delivery = REMINDER_DELIVERIES.has(settings?.delivery)
    ? settings.delivery
    : DEFAULT_REMINDER_SETTINGS.delivery;
  const offsets = Array.isArray(settings?.offsetsMinutes)
    ? settings.offsetsMinutes
        .map((value) => Math.floor(Number(value)))
        .filter((value) => REMINDER_OFFSETS.has(value))
    : DEFAULT_REMINDER_SETTINGS.offsetsMinutes;
  const offsetsMinutes = Array.from(new Set(offsets)).sort((a, b) => a - b);

  return {
    delivery,
    offsetsMinutes: offsetsMinutes.length ? offsetsMinutes : [...DEFAULT_REMINDER_SETTINGS.offsetsMinutes],
  };
}

async function readReminderSettings(store, userId) {
  const normalizedUserId = String(userId || "").trim();
  const data = normalizedUserId
    ? await store.get(`${REMINDER_SETTINGS_PREFIX}${normalizedUserId}`, { type: "json" })
    : null;
  return normalizeReminderSettings(data || DEFAULT_REMINDER_SETTINGS);
}

async function writeReminderSettings(store, userId, settings) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;

  const normalized = normalizeReminderSettings(settings);
  await store.setJSON(`${REMINDER_SETTINGS_PREFIX}${normalizedUserId}`, normalized);
  return normalized;
}

async function readOffTimeWindows(store) {
  const data = await store.get(OFF_TIME_WINDOWS_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function writeOffTimeWindows(store, windows) {
  await store.setJSON(OFF_TIME_WINDOWS_KEY, Array.isArray(windows) ? windows : []);
}

function defaultWorkingHours() {
  return Array.from({ length: 7 }, (_, day) => ({
    day_of_week: day,
    enabled: true,
    start_time: "09:00",
    end_time: "20:00",
  }));
}

function normalizeWorkingHours(rawHours) {
  const defaults = defaultWorkingHours();
  const byDay = new Map(
    (Array.isArray(rawHours) ? rawHours : []).map((entry) => [Number(entry?.day_of_week), entry])
  );

  return defaults.map((fallback) => {
    const raw = byDay.get(fallback.day_of_week);
    const start = String(raw?.start_time || fallback.start_time).trim();
    const end = String(raw?.end_time || fallback.end_time).trim();
    const validTimes = /^\d{2}:\d{2}$/.test(start) && /^\d{2}:\d{2}$/.test(end) && start < end;
    return {
      day_of_week: fallback.day_of_week,
      enabled: raw?.enabled === false ? false : true,
      start_time: validTimes ? start : fallback.start_time,
      end_time: validTimes ? end : fallback.end_time,
    };
  });
}

async function readWorkingHours(store) {
  const data = await store.get(WORKING_HOURS_KEY, { type: "json" });
  return normalizeWorkingHours(data);
}

async function writeWorkingHours(store, hours) {
  const normalized = normalizeWorkingHours(hours);
  await store.setJSON(WORKING_HOURS_KEY, normalized);
  return normalized;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function normalizeIdentityName(value) {
  return String(value || "").trim();
}

function normalizeIdentityEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || !isValidEmail(normalized)) return "";
  return normalized;
}

async function readPendingChanges(store) {
  const data = await store.get(PENDING_CHANGES_KEY, { type: "json" });
  const list = Array.isArray(data) ? data : [];
  const visible = filterVisiblePendingChanges(list);

  if (visible.length !== list.length) {
    await writePendingChanges(store, visible);
  }
  return visible;
}

async function writePendingChanges(store, pendingChanges) {
  await store.setJSON(PENDING_CHANGES_KEY, pendingChanges);
}

function isResolvedRequestVisible(change, nowMs = Date.now()) {
  if (!change || typeof change !== "object") return false;
  if (change.status === "pending") return true;

  const reviewedAt = change.reviewedAt || change.createdAt;
  const reviewedTime = reviewedAt ? Date.parse(reviewedAt) : NaN;
  if (!Number.isFinite(reviewedTime)) return false;

  return nowMs - reviewedTime <= RESOLVED_REQUEST_TTL_MS;
}

function filterVisiblePendingChanges(changes) {
  return (Array.isArray(changes) ? changes : []).filter((change) => isResolvedRequestVisible(change));
}

function filterPendingChangesForUser(changes, userId, userEmail) {
  const normalizedUserId = String(userId || "").trim();
  const normalizedEmail = String(userEmail || "").trim().toLowerCase();
  return filterVisiblePendingChanges(changes).filter((change) => {
    const requestedBy = String(change?.requestedBy || "").trim();
    const email = String(change?.requestedByEmail || "").trim().toLowerCase();
    return requestedBy === normalizedUserId || (normalizedEmail && email === normalizedEmail);
  });
}

async function readUserIdentityMap(store) {
  const data = await store.get(USER_IDENTITY_MAP_KEY, { type: "json" });
  if (!data || typeof data !== "object") return {};
  return data;
}

async function writeUserIdentityMap(store, identityMap) {
  await store.setJSON(USER_IDENTITY_MAP_KEY, identityMap || {});
}

async function recordUserIdentity(store, userId, email) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return;

  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail) return;

  const identities = await readUserIdentityMap(store);
  const now = new Date().toISOString();
  const existing = identities[normalizedUserId] || {};

  identities[normalizedUserId] = {
    ...(typeof existing === "object" && existing ? existing : {}),
    email: existing.email || normalizedEmail,
    name: existing?.name || null,
    firstSeenEmail: existing.firstSeenEmail || normalizedEmail,
    firstSeenAt: existing.firstSeenAt || now,
    lastSeenAt: now,
    lastSeenEmail: normalizedEmail,
  };

  await writeUserIdentityMap(store, identities);
}

async function updateUserIdentity(store, userId, payload) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) return null;

  const identities = await readUserIdentityMap(store);
  const existing = identities[normalizedUserId];
  if (!existing || typeof existing !== "object") return null;

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(payload || {}, "email")) {
    const email = normalizeIdentityEmail(payload.email);
    if (!email) return { error: "invalid_email" };
    updates.email = email;
  }

  if (Object.prototype.hasOwnProperty.call(payload || {}, "name")) {
    updates.name = normalizeIdentityName(payload.name) || null;
  }

  if (Object.keys(updates).length === 0) return existing;

  identities[normalizedUserId] = {
    ...existing,
    ...updates,
    lastUpdatedAt: new Date().toISOString(),
  };
  await writeUserIdentityMap(store, identities);
  return identities[normalizedUserId];
}

async function listTodayUsage(store) {
  const prefix = `usage:${new Date().toISOString().slice(0, 10)}:`;
  const [identityMap, settings, limits, listing] = await Promise.all([
    readUserIdentityMap(store),
    getUsageSettings(store),
    readUserDailyLimits(store),
    store.list({ prefix }),
  ]);

  const blobs = listing?.blobs || [];
  const defaultLimit = normalizeUsageLimit(settings?.defaultDailyPromptLimit, DEFAULT_DAILY_PROMPT_LIMIT);
  const results = [];

  for (const blob of blobs) {
    const data = await store.get(blob.key, { type: "json" });
    const userId = blob.key.slice(prefix.length);
    const identity = identityMap[userId];
    const limit = normalizeUsageLimit(limits[userId], defaultLimit);
    results.push({
      userId,
      userEmail: data?.userEmail || identity?.email || identity?.firstSeenEmail || null,
      count: data?.count ?? 0,
      maintainerNotified: data?.maintainerNotified ?? false,
      limit,
    });
  }

  return results;
}

function jsonResponse(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function nextId(items) {
  return items.length ? Math.max(...items.map((i) => i.id)) + 1 : 1;
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function timesOverlap(aStart, aEnd, bStart, bEnd) {
  const as = toMinutes(aStart), ae = toMinutes(aEnd);
  const bs = toMinutes(bStart), be = toMinutes(bEnd);
  return as < be && bs < ae;
}

module.exports = {
  getLessonStore,
  readLessons,
  writeLessons,
  readExceptions,
  writeExceptions,
  readCalendarEvents,
  writeCalendarEvents,
  readUsage,
  writeUsage,
  getUsageSettings,
  writeUsageSettings,
  getUserPromptLimit,
  setUserPromptLimit,
  resetUserPromptLimit,
  resetUserUsage,
  resetAllUsage,
  canConsumeNimRequestSlot,
  normalizeReminderSettings,
  readReminderSettings,
  writeReminderSettings,
  readOffTimeWindows,
  writeOffTimeWindows,
  normalizeWorkingHours,
  readWorkingHours,
  writeWorkingHours,
  readApprovalSettings,
  writeApprovalSettings,
  readPendingChanges,
  writePendingChanges,
  filterVisiblePendingChanges,
  filterPendingChangesForUser,
  RESOLVED_REQUEST_TTL_HOURS,
  readUserIdentityMap,
  writeUserIdentityMap,
  recordUserIdentity,
  updateUserIdentity,
  listTodayUsage,
  jsonResponse,
  nextId,
  timesOverlap,
  NIM_RATE_LIMIT_PER_WINDOW,
  NIM_RATE_WINDOW_MS,
};
