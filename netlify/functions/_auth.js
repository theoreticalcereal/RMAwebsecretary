const crypto = require("crypto");

const { getLessonStore } = require("./_store");
const { sendLoginCodeEmail } = require("./_notify");

const OTP_PREFIX = "auth:otp:";
const SESSION_PREFIX = "auth:session:";
const SESSION_COOKIE_NAME = "ls_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const CODE_TTL_MS = 1000 * 60 * 10;
const COOLDOWN_MS = 30 * 1000;
const MAX_OTP_ATTEMPTS = 6;
const ADMIN_EMAILS = normalizeEmail(process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || "");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function makeOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function hashCode(email, code) {
  const secret = process.env.AUTH_CODE_SECRET || process.env.RESEND_API_KEY || "fallback-otp-secret";
  return crypto.createHash("sha256").update(`${secret}:${email}:${code}`).digest("hex");
}

function getCookieValue(cookieHeader, name) {
  return (cookieHeader || "")
    .split(";")
    .map((chunk) => chunk.trim())
    .find((chunk) => chunk.startsWith(`${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}

function deriveUserId(email) {
  return crypto.createHash("sha256").update(email).digest("hex");
}

function makeSessionCookie(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${Math.floor(
    SESSION_TTL_MS / 1000
  )}; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function getAdminEmails() {
  return ADMIN_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((email) => isValidEmail(email));
}

function isAdminEmail(email) {
  const allowed = getAdminEmails();
  if (!allowed.length) return false;
  return allowed.includes(normalizeEmail(email));
}

function isAdminUser(user) {
  return isAdminEmail(user?.email);
}

async function getSession(event) {
  const sessionToken = getCookieValue(event.headers?.cookie || event.headers?.Cookie, SESSION_COOKIE_NAME);
  if (!sessionToken) return null;

  const store = getLessonStore(event);
  const session = await store.get(`${SESSION_PREFIX}${sessionToken}`, { type: "json" });
  if (!session) return null;
  if (Date.now() > (session.expiresAt || 0)) return null;
  return session;
}

async function requestLoginCode(event, email) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) {
    return { ok: false, reason: "Please provide a valid email address." };
  }

  const store = getLessonStore(event);
  const key = `${OTP_PREFIX}${normalized}`;
  const existing = await store.get(key, { type: "json" });
  const now = Date.now();

  if (existing && existing.createdAt && now - existing.createdAt < COOLDOWN_MS && !existing.used) {
    return {
      ok: false,
      reason: "Please wait a moment before requesting another code.",
    };
  }

  const code = makeOtp();
  await store.setJSON(key, {
    email: normalized,
    codeHash: hashCode(normalized, code),
    createdAt: now,
    expiresAt: now + CODE_TTL_MS,
    attempts: 0,
    used: false,
  });

  const emailResult = await sendLoginCodeEmail({ email: normalized, code });
  if (!emailResult.sent) {
    return {
      ok: false,
      reason: `Could not send verification email: ${emailResult.reason || "unknown error"}`,
    };
  }

  return { ok: true };
}

async function verifyLoginCode(event, email, code) {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized) || !code) {
    return { ok: false, reason: "Email and code are required." };
  }

  const store = getLessonStore(event);
  const key = `${OTP_PREFIX}${normalized}`;
  const record = await store.get(key, { type: "json" });
  if (!record || !record.codeHash || record.used) {
    return { ok: false, reason: "Invalid or expired code." };
  }

  if (Date.now() > record.expiresAt) {
    return { ok: false, reason: "Code has expired. Please request a new one." };
  }

  if ((record.attempts || 0) >= MAX_OTP_ATTEMPTS) {
    return { ok: false, reason: "Too many attempts. Please request a new code." };
  }

  const expected = hashCode(normalized, String(code).trim());
  if (record.codeHash !== expected) {
    await store.setJSON(key, {
      ...record,
      attempts: (record.attempts || 0) + 1,
    });
    return { ok: false, reason: "Incorrect code." };
  }

  const user = { email: normalized, id: deriveUserId(normalized) };
  const token = crypto.randomUUID();
  const now = Date.now();
  await store.setJSON(`${SESSION_PREFIX}${token}`, {
    ...user,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  await store.setJSON(key, { ...record, used: true });

  return {
    ok: true,
    sessionToken: token,
    user,
    setCookie: makeSessionCookie(token),
  };
}

async function getAdminSession(event) {
  const user = await getSession(event);
  if (!user) return { ok: false, reason: "unauthorized", status: 401 };
  if (!isAdminUser(user)) return { ok: false, reason: "forbidden", status: 403 };
  return { ok: true, user };
}

module.exports = {
  requestLoginCode,
  verifyLoginCode,
  getAdminSession,
  getSession,
  isAdminUser,
  makeSessionCookie,
  clearSessionCookie,
  getAdminEmails,
};
