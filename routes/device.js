const express = require("express");
const router = express.Router();

const { createSocket, reconnectSocket } = require("../whatsapp/socket");
const { getDeviceByUserId, updateDevice } = require("../utils/db");
const {
  getSessionRecord,
  listSessionRecords,
  removeSession,
  updateSessionStatus,
  updateSessionProfile
} = require("../whatsapp/sessions");

function mapRecord(record) {
  return {
    userId: record.userId,
    deviceName: record.deviceLabel || record.userId,
    status: record.status,
    messagesSent: record.messagesSent,
    lastActive: record.lastActive,
    mobile: record.phone,
    active: record.status === "connected",
    reconnectAttempts: record.reconnectAttempts,
    lastQrRefreshAt: record.lastQrRefreshAt,
    conflictWarning: record.conflictWarning,
    sessionHealth: record.sessionHealth,
    sentCount: record.sentCount,
    failedCount: record.failedCount,
    retriedCount: record.retriedCount
  };
}

function requireOwnedDevice(req, userId, { allowUnowned = false } = {}) {
  const device = getDeviceByUserId(userId);

  if (!device) {
    return null;
  }

  if (device.ownerUserId && device.ownerUserId !== req.authUser.id) {
    const error = new Error("This device belongs to another account");
    error.statusCode = 403;
    throw error;
  }

  if (!allowUnowned && !device.ownerUserId) {
    const error = new Error("This device is not assigned to your account");
    error.statusCode = 403;
    throw error;
  }

  return device;
}

function claimDevice(req, userId, existingDevice) {
  return updateDevice(userId, {
    ownerUserId: req.authUser.id,
    deviceLabel: existingDevice?.deviceLabel || userId,
    isRemoved: false,
    shouldConnect: true,
    removedAt: null
  });
}

router.get("/", (req, res) => {
  const devices = listSessionRecords()
    .filter((record) => {
      const device = getDeviceByUserId(record.userId);
      return device?.ownerUserId === req.authUser.id;
    })
    .map(mapRecord);

  res.json({ devices });
});

router.post("/connect", async (req, res) => {
  try {
    const { userId } = req.body;
    const existingDevice = requireOwnedDevice(req, userId, { allowUnowned: true });

    if (!existingDevice?.ownerUserId) {
      claimDevice(req, userId, existingDevice);
    }

    const existing = getSessionRecord(userId);

    if (existing?.sock) {
      if (existing.status === "connected") {
        return res.json({ qr: null, status: "connected" });
      }

      if (existing.sock.qr) {
        return res.json({ qr: existing.sock.qr, status: "qr_ready" });
      }
    }

    const sock = await createSocket(userId);

    if (sock.qr) {
      return res.json({ qr: sock.qr, status: "qr_ready" });
    }

    const timeout = setTimeout(() => {
      sock.ev.off("connection.update", handleConnectionUpdate);
      const record = getSessionRecord(userId);

      res.status(202).json({
        qr: record?.sock?.qr || null,
        status: record?.status || "waiting_for_qr"
      });
    }, 20000);

    function handleConnectionUpdate(update) {
      if (update.qr) {
        clearTimeout(timeout);
        sock.ev.off("connection.update", handleConnectionUpdate);
        res.json({ qr: update.qr, status: "qr_ready" });
      }

      if (update.connection === "open") {
        clearTimeout(timeout);
        sock.ev.off("connection.update", handleConnectionUpdate);
        res.json({ qr: null, status: "connected" });
      }
    }

    sock.ev.on("connection.update", handleConnectionUpdate);
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to connect device" });
  }
});

router.post("/:userId/refresh", async (req, res) => {
  try {
    requireOwnedDevice(req, req.params.userId);
    const existing = getSessionRecord(req.params.userId);

    if (existing?.sock && ["connected", "connecting", "qr_ready"].includes(existing.status)) {
      return res.json({
        success: true,
        qr: existing.sock.qr || null,
        status: existing.status
      });
    }

    const sock = await reconnectSocket(req.params.userId);

    res.json({
      success: true,
      qr: sock.qr || null,
      status: getSessionRecord(req.params.userId)?.status || "connecting"
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to refresh session" });
  }
});

router.post("/:userId/relogin", async (req, res) => {
  try {
    requireOwnedDevice(req, req.params.userId);
    updateSessionStatus(req.params.userId, "relogin_requested");
    const sock = await reconnectSocket(req.params.userId);

    res.json({
      success: true,
      qr: sock.qr || null,
      status: getSessionRecord(req.params.userId)?.status || "connecting"
    });
  } catch (error) {
    console.error(error);
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to relogin device" });
  }
});

router.delete("/:userId", (req, res) => {
  try {
    requireOwnedDevice(req, req.params.userId);
    removeSession(req.params.userId);
    res.json({ success: true });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to remove device" });
  }
});

router.patch("/:userId", (req, res) => {
  try {
    requireOwnedDevice(req, req.params.userId);
    const record = updateSessionProfile(req.params.userId, {
      deviceLabel: req.body.deviceLabel || req.params.userId
    });

    res.json({ success: true, device: mapRecord(record) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to rename device" });
  }
});

router.get("/:userId", (req, res) => {
  try {
    requireOwnedDevice(req, req.params.userId);
    const record = getSessionRecord(req.params.userId);

    if (!record?.sock) {
      return res.json({ status: "not_connected" });
    }

    res.json({
      status: record.status,
      hasQr: Boolean(record.sock.qr),
      mobile: record.phone,
      messagesSent: record.messagesSent,
      lastActive: record.lastActive
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message || "Failed to fetch device" });
  }
});

module.exports = router;
