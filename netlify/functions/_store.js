
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

function todayKey(userId) {
  return `usage:${new Date().toISOString().slice(0, 10)}:${userId}`;
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

const APPROVAL_SETTINGS_KEY = "approval_settings";
const PENDING_CHANGES_KEY = "pending_changes";
const USER_IDENTITY_MAP_KEY = "user_identity_map";
const RESOLVED_REQUEST_TTL_HOURS = 24;
const RESOLVED_REQUEST_TTL_MS = RESOLVED_REQUEST_TTL_HOURS * 60 * 60 * 1000;

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

function getDefaultApprovalSettings() {
  return {
    mode: "manual",
    auto: {
      minHoursBefore: 24,
      requireReason: true,
      minReasonLength: 10,
    },
  };
}

async function readApprovalSettings(store) {
  const data = await store.get(APPROVAL_SETTINGS_KEY, { type: "json" });
  if (!data) return getDefaultApprovalSettings();

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

async function readPendingChanges(store) {
  const data = await store.get(PENDING_CHANGES_KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
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
  const [identityMap, listing] = await Promise.all([
    readUserIdentityMap(store),
    store.list({ prefix }),
  ]);
  const blobs = listing?.blobs || [];
  const results = [];
  for (const blob of blobs) {
    const data = await store.get(blob.key, { type: "json" });
    const userId = blob.key.slice(prefix.length);
    const identity = identityMap[userId];
    results.push({
      userId,
      userEmail: data?.userEmail || identity?.email || identity?.firstSeenEmail || null,
      count: data?.count ?? 0,
      maintainerNotified: data?.maintainerNotified ?? false,
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
  readUsage,
  writeUsage,
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
};
