const fs = require("fs");
const path = require("path");
const { sessionsDir } = require("../utils/paths");
const {
  listDevices,
  listConnectableDevices,
  getDeviceByUserId,
  updateDevice,
  hardDeleteDevice,
  migrateSessionFoldersToDb
} = require("../utils/db");

const sessions = {};

function syncRecordFromDevice(record, device) {
  if (!device) {
    return record;
  }

  record.userId = device.userId;
  record.status = device.status || record.status;
  record.messagesSent = device.messagesSent || 0;
  record.lastActive = device.lastActive || null;
  record.phone = device.phone || "";
  record.deviceLabel = device.deviceLabel || device.userId;
  record.reconnectAttempts = device.reconnectAttempts || 0;
  record.lastQrRefreshAt = device.lastQrRefreshAt || null;
  record.conflictWarning = Boolean(device.conflictWarning);
  record.sessionHealth = device.sessionHealth ?? 100;
  record.sentCount = device.sentCount || 0;
  record.failedCount = device.failedCount || 0;
  record.retriedCount = device.retriedCount || 0;
  return record;
}

function syncRecordToDevice(record) {
  updateDevice(record.userId, {
    deviceLabel: record.deviceLabel || record.userId,
    phone: record.phone || "",
    status: record.status,
    messagesSent: record.messagesSent || 0,
    lastActive: record.lastActive || null,
    reconnectAttempts: record.reconnectAttempts || 0,
    lastQrRefreshAt: record.lastQrRefreshAt || null,
    conflictWarning: Boolean(record.conflictWarning),
    sessionHealth: record.sessionHealth ?? 100,
    sentCount: record.sentCount || 0,
    failedCount: record.failedCount || 0,
    retriedCount: record.retriedCount || 0,
    shouldConnect: record.status !== "removed" && record.status !== "logged_out",
    isRemoved: record.status === "removed"
  });
}

function ensureRecord(userId) {
  if (!sessions[userId]) {
    const device = getDeviceByUserId(userId);
    sessions[userId] = {
      userId,
      sock: null,
      status: device?.status || "idle",
      reconnecting: false,
      messagesSent: device?.messagesSent || 0,
      lastActive: device?.lastActive || null,
      phone: device?.phone || "",
      deviceLabel: device?.deviceLabel || userId,
      reconnectAttempts: device?.reconnectAttempts || 0,
      lastQrRefreshAt: device?.lastQrRefreshAt || null,
      conflictWarning: Boolean(device?.conflictWarning),
      sessionHealth: device?.sessionHealth ?? 100,
      sentCount: device?.sentCount || 0,
      failedCount: device?.failedCount || 0,
      retriedCount: device?.retriedCount || 0
    };
  }

  return sessions[userId];
}

function bootstrapSavedSessions() {
  migrateSessionFoldersToDb(sessionsDir);

  for (const device of listDevices()) {
    syncRecordFromDevice(ensureRecord(device.userId), device);
  }
}

function setSession(userId, sock, status = "connecting") {
  const record = ensureRecord(userId);
  record.sock = sock;
  record.status = status;
  syncRecordToDevice(record);
  return record;
}

function getSession(userId) {
  return sessions[userId]?.sock;
}

function getSessionRecord(userId) {
  const device = getDeviceByUserId(userId);

  if (!device && !sessions[userId]) {
    return null;
  }

  const record = ensureRecord(userId);
  if (device) {
    syncRecordFromDevice(record, device);
  }
  return record;
}

function listSessionRecords() {
  const devices = listDevices();
  return devices.map((device) => syncRecordFromDevice(ensureRecord(device.userId), device));
}

function listSavedUserIds() {
  return listConnectableDevices().map((device) => device.userId);
}

function updateSessionStatus(userId, status) {
  const record = ensureRecord(userId);
  record.status = status;
  record.lastActive = new Date().toISOString();

  if (status === "connected") {
    record.sessionHealth = 100;
    record.conflictWarning = false;
  }

  if (status === "conflict") {
    record.sessionHealth = Math.max(30, record.sessionHealth - 20);
    record.conflictWarning = true;
  }

  if (status === "disconnected") {
    record.sessionHealth = Math.max(40, record.sessionHealth - 10);
  }

  if (status === "logged_out") {
    record.conflictWarning = false;
  }

  syncRecordToDevice(record);
  return record;
}

function setReconnectState(userId, reconnecting) {
  const record = ensureRecord(userId);
  record.reconnecting = reconnecting;
  return record;
}

function incrementMessageCount(userId, count = 1) {
  const record = ensureRecord(userId);
  record.messagesSent += count;
  record.sentCount += count;
  record.lastActive = new Date().toISOString();
  syncRecordToDevice(record);
  return record;
}

function updateSessionProfile(userId, profile = {}) {
  const record = ensureRecord(userId);
  Object.assign(record, profile);
  syncRecordToDevice(record);
  return record;
}

function markFailedMessage(userId, count = 1) {
  const record = ensureRecord(userId);
  record.failedCount += count;
  syncRecordToDevice(record);
  return record;
}

function markRetried(userId, count = 1) {
  const record = ensureRecord(userId);
  record.retriedCount += count;
  syncRecordToDevice(record);
  return record;
}

function noteQrRefresh(userId) {
  const record = ensureRecord(userId);
  record.lastQrRefreshAt = new Date().toISOString();
  syncRecordToDevice(record);
  return record;
}

function noteReconnectAttempt(userId) {
  const record = ensureRecord(userId);
  record.reconnectAttempts += 1;
  record.retriedCount += 1;
  record.lastActive = new Date().toISOString();
  syncRecordToDevice(record);
  return record;
}

function removeSession(userId) {
  const record = sessions[userId];

  if (record?.sock?.logout) {
    try {
      record.sock.logout();
    } catch (error) {
      // Ignore logout failures during remove.
    }
  }

  if (record?.sock?.end) {
    try {
      record.sock.end();
    } catch (error) {
      // Ignore socket close failures during remove.
    }
  }

  delete sessions[userId];

  const sessionPath = path.join(sessionsDir, userId);
  if (fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore session folder cleanup failures during remove.
    }
  }

  hardDeleteDevice(userId);
}

bootstrapSavedSessions();

module.exports = {
  setSession,
  getSession,
  getSessionRecord,
  listSessionRecords,
  listSavedUserIds,
  updateSessionStatus,
  setReconnectState,
  incrementMessageCount,
  updateSessionProfile,
  markFailedMessage,
  markRetried,
  noteQrRefresh,
  noteReconnectAttempt,
  removeSession
};
