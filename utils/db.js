const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { dataDir } = require("./paths");

const dbPath = path.join(dataDir, "app.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_super_admin INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT,
    user_id TEXT NOT NULL UNIQUE,
    device_label TEXT NOT NULL,
    phone TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'idle',
    is_removed INTEGER NOT NULL DEFAULT 0,
    should_connect INTEGER NOT NULL DEFAULT 1,
    messages_sent INTEGER NOT NULL DEFAULT 0,
    last_active TEXT,
    reconnect_attempts INTEGER NOT NULL DEFAULT 0,
    last_qr_refresh_at TEXT,
    conflict_warning INTEGER NOT NULL DEFAULT 0,
    session_health INTEGER NOT NULL DEFAULT 100,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    retried_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_devices_user_id ON devices(user_id);
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all().map((column) => column.name);

if (!userColumns.includes("is_super_admin")) {
  db.exec("ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0");
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function toBoolean(value) {
  return Boolean(Number(value));
}

function mapDeviceRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    userId: row.user_id,
    deviceLabel: row.device_label,
    phone: row.phone || "",
    status: row.status,
    isRemoved: toBoolean(row.is_removed),
    shouldConnect: toBoolean(row.should_connect),
    messagesSent: row.messages_sent || 0,
    lastActive: row.last_active || null,
    reconnectAttempts: row.reconnect_attempts || 0,
    lastQrRefreshAt: row.last_qr_refresh_at || null,
    conflictWarning: toBoolean(row.conflict_warning),
    sessionHealth: row.session_health || 100,
    sentCount: row.sent_count || 0,
    failedCount: row.failed_count || 0,
    retriedCount: row.retried_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at || null
  };
}

function hasUsers() {
  return db.prepare("SELECT COUNT(*) AS count FROM users").get().count > 0;
}

function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

function getUserById(userId) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
}

function createUser({ username, name, passwordHash }) {
  const timestamp = nowIso();
  const user = {
    id: makeId("user"),
    username,
    name,
    isSuperAdmin: 0,
    passwordHash,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  db.prepare(`
    INSERT INTO users (id, username, name, is_super_admin, password_hash, created_at, updated_at)
    VALUES (@id, @username, @name, @isSuperAdmin, @passwordHash, @createdAt, @updatedAt)
  `).run(user);

  return user;
}

function ensureSuperAdmin({ username, name, passwordHash }) {
  const existing = getUserByUsername(username);
  const timestamp = nowIso();

  if (!existing) {
    const user = {
      id: makeId("user"),
      username,
      name,
      isSuperAdmin: 1,
      passwordHash,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    db.prepare(`
      INSERT INTO users (id, username, name, is_super_admin, password_hash, created_at, updated_at)
      VALUES (@id, @username, @name, @isSuperAdmin, @passwordHash, @createdAt, @updatedAt)
    `).run(user);

    return getUserByUsername(username);
  }

  db.prepare(`
    UPDATE users
    SET name = @name,
        is_super_admin = 1,
        password_hash = @passwordHash,
        updated_at = @updatedAt
    WHERE username = @username
  `).run({
    username,
    name,
    passwordHash,
    updatedAt: timestamp
  });

  return getUserByUsername(username);
}

function createAuthSession({ userId, tokenHash, expiresAt }) {
  const session = {
    id: makeId("sess"),
    userId,
    tokenHash,
    createdAt: nowIso(),
    expiresAt,
    lastSeenAt: nowIso()
  };

  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
    VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt, @lastSeenAt)
  `).run(session);

  return session;
}

function getAuthSessionByHash(tokenHash) {
  return db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(tokenHash);
}

function touchAuthSession(tokenHash) {
  db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?").run(nowIso(), tokenHash);
}

function deleteAuthSession(tokenHash) {
  db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(tokenHash);
}

function listDevices() {
  return db.prepare(`
    SELECT *
    FROM devices
    WHERE is_removed = 0
    ORDER BY datetime(updated_at) DESC, user_id ASC
  `).all().map(mapDeviceRow);
}

function listDevicesByOwner(ownerUserId) {
  return db.prepare(`
    SELECT *
    FROM devices
    WHERE is_removed = 0
      AND owner_user_id = ?
    ORDER BY datetime(updated_at) DESC, user_id ASC
  `).all(ownerUserId).map(mapDeviceRow);
}

function listConnectableDevices() {
  return db.prepare(`
    SELECT *
    FROM devices
    WHERE is_removed = 0
      AND should_connect = 1
      AND COALESCE(phone, '') <> ''
    ORDER BY datetime(updated_at) DESC, user_id ASC
  `).all().map(mapDeviceRow);
}

function getDeviceByUserId(userId) {
  return mapDeviceRow(db.prepare("SELECT * FROM devices WHERE user_id = ?").get(userId));
}

function insertDevice(device) {
  db.prepare(`
    INSERT INTO devices (
      id, owner_user_id, user_id, device_label, phone, status, is_removed, should_connect,
      messages_sent, last_active, reconnect_attempts, last_qr_refresh_at, conflict_warning,
      session_health, sent_count, failed_count, retried_count, created_at, updated_at, removed_at
    ) VALUES (
      @id, @ownerUserId, @userId, @deviceLabel, @phone, @status, @isRemoved, @shouldConnect,
      @messagesSent, @lastActive, @reconnectAttempts, @lastQrRefreshAt, @conflictWarning,
      @sessionHealth, @sentCount, @failedCount, @retriedCount, @createdAt, @updatedAt, @removedAt
    )
  `).run({
    id: device.id,
    ownerUserId: device.ownerUserId || null,
    userId: device.userId,
    deviceLabel: device.deviceLabel || device.userId,
    phone: device.phone || "",
    status: device.status || "idle",
    isRemoved: device.isRemoved ? 1 : 0,
    shouldConnect: device.shouldConnect === false ? 0 : 1,
    messagesSent: device.messagesSent || 0,
    lastActive: device.lastActive || null,
    reconnectAttempts: device.reconnectAttempts || 0,
    lastQrRefreshAt: device.lastQrRefreshAt || null,
    conflictWarning: device.conflictWarning ? 1 : 0,
    sessionHealth: device.sessionHealth ?? 100,
    sentCount: device.sentCount || 0,
    failedCount: device.failedCount || 0,
    retriedCount: device.retriedCount || 0,
    createdAt: device.createdAt || nowIso(),
    updatedAt: device.updatedAt || nowIso(),
    removedAt: device.removedAt || null
  });
}

function updateDevice(userId, updates = {}) {
  const existing = getDeviceByUserId(userId);
  const timestamp = nowIso();

  if (!existing) {
    const created = {
      id: makeId("device"),
      ownerUserId: updates.ownerUserId || null,
      userId,
      deviceLabel: updates.deviceLabel || userId,
      phone: updates.phone || "",
      status: updates.status || "idle",
      isRemoved: updates.isRemoved || false,
      shouldConnect: updates.shouldConnect !== false,
      messagesSent: updates.messagesSent || 0,
      lastActive: updates.lastActive || null,
      reconnectAttempts: updates.reconnectAttempts || 0,
      lastQrRefreshAt: updates.lastQrRefreshAt || null,
      conflictWarning: updates.conflictWarning || false,
      sessionHealth: updates.sessionHealth ?? 100,
      sentCount: updates.sentCount || 0,
      failedCount: updates.failedCount || 0,
      retriedCount: updates.retriedCount || 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      removedAt: updates.removedAt || null
    };
    insertDevice(created);
    return getDeviceByUserId(userId);
  }

  const merged = {
    ...existing,
    ...updates,
    updatedAt: timestamp
  };

  db.prepare(`
    UPDATE devices
    SET owner_user_id = @ownerUserId,
        device_label = @deviceLabel,
        phone = @phone,
        status = @status,
        is_removed = @isRemoved,
        should_connect = @shouldConnect,
        messages_sent = @messagesSent,
        last_active = @lastActive,
        reconnect_attempts = @reconnectAttempts,
        last_qr_refresh_at = @lastQrRefreshAt,
        conflict_warning = @conflictWarning,
        session_health = @sessionHealth,
        sent_count = @sentCount,
        failed_count = @failedCount,
        retried_count = @retriedCount,
        updated_at = @updatedAt,
        removed_at = @removedAt
    WHERE user_id = @userId
  `).run({
    ownerUserId: merged.ownerUserId || null,
    deviceLabel: merged.deviceLabel || userId,
    phone: merged.phone || "",
    status: merged.status || "idle",
    isRemoved: merged.isRemoved ? 1 : 0,
    shouldConnect: merged.shouldConnect === false ? 0 : 1,
    messagesSent: merged.messagesSent || 0,
    lastActive: merged.lastActive || null,
    reconnectAttempts: merged.reconnectAttempts || 0,
    lastQrRefreshAt: merged.lastQrRefreshAt || null,
    conflictWarning: merged.conflictWarning ? 1 : 0,
    sessionHealth: merged.sessionHealth ?? 100,
    sentCount: merged.sentCount || 0,
    failedCount: merged.failedCount || 0,
    retriedCount: merged.retriedCount || 0,
    updatedAt: merged.updatedAt,
    removedAt: merged.removedAt || null,
    userId
  });

  return getDeviceByUserId(userId);
}

function markDeviceRemoved(userId) {
  return updateDevice(userId, {
    status: "removed",
    isRemoved: true,
    shouldConnect: false,
    removedAt: nowIso()
  });
}

function restoreDevice(userId) {
  return updateDevice(userId, {
    isRemoved: false,
    shouldConnect: true,
    removedAt: null
  });
}

function hardDeleteDevice(userId) {
  db.prepare("DELETE FROM devices WHERE user_id = ?").run(userId);
}

function migrateSessionFoldersToDb(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) {
    return;
  }

  for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const userId = entry.name;
    const existing = getDeviceByUserId(userId);
    const credsPath = path.join(sessionsDir, userId, "creds.json");
    let phone = existing?.phone || "";
    let lastActive = existing?.lastActive || null;

    if (fs.existsSync(credsPath)) {
      try {
        const creds = JSON.parse(fs.readFileSync(credsPath, "utf8"));
        phone = creds?.me?.id?.split(":")[0] || phone;
        lastActive = fs.statSync(credsPath).mtime.toISOString();
      } catch (error) {
        // Keep previous metadata if creds parsing fails.
      }
    }

    if (!existing) {
      insertDevice({
        id: makeId("device"),
        userId,
        deviceLabel: userId,
        phone,
        status: phone ? "saved" : "idle",
        shouldConnect: true,
        isRemoved: false,
        lastActive,
        sessionHealth: 100,
        createdAt: nowIso(),
        updatedAt: nowIso()
      });
      continue;
    }

    if (!existing.isRemoved) {
      updateDevice(userId, {
        phone,
        lastActive,
        deviceLabel: existing.deviceLabel || userId
      });
    }
  }
}

module.exports = {
  db,
  nowIso,
  makeId,
  hasUsers,
  getUserByUsername,
  getUserById,
  createUser,
  ensureSuperAdmin,
  createAuthSession,
  getAuthSessionByHash,
  touchAuthSession,
  deleteAuthSession,
  listDevices,
  listDevicesByOwner,
  listConnectableDevices,
  getDeviceByUserId,
  updateDevice,
  markDeviceRemoved,
  restoreDevice,
  hardDeleteDevice,
  migrateSessionFoldersToDb
};
