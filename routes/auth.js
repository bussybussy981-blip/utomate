const express = require("express");
const router = express.Router();

const { logAudit } = require("../utils/appData");
const { hasUsers, getUserByUsername, createUser } = require("../utils/db");
const {
  hashPassword,
  verifyPassword,
  issueSession,
  clearSessionCookie,
  getAuthUserFromRequest
} = require("../utils/auth");

router.get("/status", (req, res) => {
  const user = getAuthUserFromRequest(req);

  res.json({
    authenticated: Boolean(user),
    needsSetup: !hasUsers(),
    user: user || null
  });
});

router.post("/setup", (req, res) => {
  if (hasUsers()) {
    return res.status(400).json({ error: "Initial account already created" });
  }

  const username = String(req.body.username || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");

  if (!username || !name || password.length < 6) {
    return res.status(400).json({ error: "Name, username, and a 6+ character password are required" });
  }

  const user = createUser({
    username,
    name,
    passwordHash: hashPassword(password)
  });

  issueSession(res, user.id);
  logAudit("auth.setup", { username: user.username });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      name: user.name
    }
  });
});

router.post("/register", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");

  if (!username || !name || password.length < 6) {
    return res.status(400).json({ error: "Name, username, and a 6+ character password are required" });
  }

  if (getUserByUsername(username)) {
    return res.status(400).json({ error: "Username already exists" });
  }

  const user = createUser({
    username,
    name,
    passwordHash: hashPassword(password)
  });

  issueSession(res, user.id);
  logAudit("auth.register", { username: user.username });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      name: user.name
    }
  });
});

router.post("/login", (req, res) => {
  const username = String(req.body.username || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = getUserByUsername(username);

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  issueSession(res, user.id);
  logAudit("auth.login", { username: user.username });

  res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      name: user.name
    }
  });
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get("/me", (req, res) => {
  const user = getAuthUserFromRequest(req);

  if (!user) {
    return res.status(401).json({ error: "Authentication required" });
  }

  res.json({ user });
});

module.exports = router;
