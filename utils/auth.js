const crypto = require("crypto");
const {
  nowIso,
  createAuthSession,
  getAuthSessionByHash,
  touchAuthSession,
  deleteAuthSession,
  getUserById
} = require("./db");

const SESSION_COOKIE = "wa_wenxi_session";
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 7;

function parseCookies(header = "") {
  return String(header || "")
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .reduce((acc, chunk) => {
      const separator = chunk.indexOf("=");
      if (separator === -1) {
        return acc;
      }

      const key = chunk.slice(0, separator).trim();
      const value = decodeURIComponent(chunk.slice(separator + 1).trim());
      acc[key] = value;
      return acc;
    }, {});
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const [salt, original] = String(storedHash || "").split(":");

  if (!salt || !original) {
    return false;
  }

  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(original, "hex"), Buffer.from(derived, "hex"));
}

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  const secureFlag = secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_AGE_SECONDS}${secureFlag}`
  ]);
}

function clearSessionCookie(res) {
  const secure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
  const secureFlag = secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag}`
  ]);
}

function issueSession(res, userId) {
  const token = createSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + (SESSION_AGE_SECONDS * 1000)).toISOString();

  createAuthSession({ userId, tokenHash, expiresAt });
  setSessionCookie(res, token);
}

function getAuthUserFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE];

  if (!token) {
    return null;
  }

  const session = getAuthSessionByHash(hashToken(token));

  if (!session) {
    return null;
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    deleteAuthSession(session.token_hash);
    return null;
  }

  touchAuthSession(session.token_hash);
  const user = getUserById(session.user_id);

  if (!user) {
    deleteAuthSession(session.token_hash);
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    name: user.name,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

function requireAuth(req, res, next) {
  const user = getAuthUserFromRequest(req);

  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  req.authUser = user;
  next();
}

module.exports = {
  SESSION_COOKIE,
  nowIso,
  hashPassword,
  verifyPassword,
  issueSession,
  clearSessionCookie,
  getAuthUserFromRequest,
  requireAuth
};
