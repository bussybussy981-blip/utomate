const express = require("express");
const router = express.Router();

const { getDeviceByUserId, listDevicesByOwner } = require("../utils/db");
const {
  getSessionRecord,
  incrementMessageCount,
  markFailedMessage
} = require("../whatsapp/sessions");
const {
  load,
  save,
  id,
  nowIso,
  logAudit
} = require("../utils/appData");

const history = load("history");
const duplicateGuard = new Map();
const rateWindow = new Map();
const scheduleTimers = new Map();

function persistScheduleUpdate(item) {
  const updated = load("schedules").map((entry) => entry.id === item.id ? item : entry);
  save("schedules", updated);
}

function normalizeNumber(number) {
  return String(number || "").replace(/[^\d]/g, "");
}

function validateNumbers(numbers) {
  return numbers.map(normalizeNumber).filter((number) => number.length >= 8);
}

function addHistoryEntry(entry) {
  history.unshift({
    id: id("history"),
    ...entry
  });

  if (history.length > 200) {
    history.length = 200;
  }

  save("history", history);
}

function canSendNow(userId, recipientCount) {
  const now = Date.now();
  const record = rateWindow.get(userId) || [];
  const recent = record.filter((time) => now - time < 15000);

  if (recent.length + recipientCount > 20) {
    rateWindow.set(userId, recent);
    return false;
  }

  for (let index = 0; index < recipientCount; index += 1) {
    recent.push(now);
  }

  rateWindow.set(userId, recent);
  return true;
}

function isDuplicate(userId, numbers, message, context = "") {
  const key = `${userId}:${numbers.join(",")}:${message}:${context}`;
  const now = Date.now();
  const existing = duplicateGuard.get(key);

  if (existing && now - existing < 10000) {
    return true;
  }

  duplicateGuard.set(key, now);
  return false;
}

function clearDuplicateGuard(userId, numbers, message, context = "") {
  const key = `${userId}:${numbers.join(",")}:${message}:${context}`;
  duplicateGuard.delete(key);
}

function applyTemplate(message, variables = {}) {
  return String(message || "").replace(/\{(\w+)\}/g, (_, key) => variables[key] ?? `{${key}}`);
}

async function assertWhatsAppRecipient(sock, jid) {
  if (typeof sock.onWhatsApp !== "function") {
    return;
  }

  const result = await sock.onWhatsApp(jid);
  const recipient = Array.isArray(result) ? result[0] : result;

  if (!recipient?.exists) {
    throw new Error("Recipient WhatsApp par available nahi hai ya number format invalid hai");
  }
}

async function sendTextMessage(sock, number, message) {
  const jid = `${normalizeNumber(number)}@s.whatsapp.net`;
  await assertWhatsAppRecipient(sock, jid);
  await sock.sendMessage(jid, { text: message });
  return jid;
}

async function sendMediaMessage(sock, number, media) {
  const jid = `${normalizeNumber(number)}@s.whatsapp.net`;
  await assertWhatsAppRecipient(sock, jid);
  const buffer = Buffer.from(media.data.split(",").pop(), "base64");
  const payload = media.type === "image"
    ? { image: buffer, caption: media.caption || "" }
    : { document: buffer, fileName: media.name || "document", mimetype: media.mimeType || "application/octet-stream", caption: media.caption || "" };

  await sock.sendMessage(jid, payload);
  return jid;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function filteredHistory(query) {
  return history.filter((item) => {
    if (query.userId && item.userId !== query.userId) return false;
    if (query.status && item.status.toLowerCase() !== query.status.toLowerCase()) return false;
    if (query.messageType && item.messageType.toLowerCase() !== query.messageType.toLowerCase()) return false;
    if (query.from && new Date(item.time) < new Date(query.from)) return false;
    if (query.to && new Date(item.time) > new Date(query.to)) return false;
    return true;
  });
}

function requireOwnedDevice(req, userId) {
  const device = getDeviceByUserId(userId);

  if (!device || device.ownerUserId !== req.authUser.id) {
    const error = new Error("This device is not available for your account");
    error.statusCode = 403;
    throw error;
  }

  return device;
}

async function dispatchMessage({ userId, numbers, message, templateId, variables, mediaId, messageType, duplicateContext = "" }) {
  const record = getSessionRecord(userId);

  if (!record?.sock || record.status !== "connected") {
    throw new Error("Device not connected");
  }

  const cleanNumbers = validateNumbers(numbers);

  if (!cleanNumbers.length) {
    throw new Error("At least one valid number is required");
  }

  if (!canSendNow(userId, cleanNumbers.length)) {
    throw new Error("Rate limit exceeded. Please wait a few seconds.");
  }

  const templates = load("templates");
  const selectedTemplate = templateId ? templates.find((item) => item.id === templateId) : null;
  const finalMessage = selectedTemplate
    ? applyTemplate(selectedTemplate.content, variables)
    : applyTemplate(message, variables);

  if (isDuplicate(userId, cleanNumbers, finalMessage, duplicateContext)) {
    throw new Error("Duplicate send prevented. Please wait before retrying.");
  }

  const media = mediaId ? load("media").find((item) => item.id === mediaId) : null;
  const results = [];
  const isRepeatedSingle = new Set(cleanNumbers).size === 1 && cleanNumbers.length > 1;

  for (const number of cleanNumbers) {
    try {
      const jid = media
        ? await sendMediaMessage(record.sock, number, media)
        : await sendTextMessage(record.sock, number, finalMessage);

      incrementMessageCount(userId, 1);
      addHistoryEntry({
        time: nowIso(),
        mode: "WEB",
        messageType,
        userId,
        fromDevice: record.deviceLabel || userId,
        to: jid,
        content: media ? `[${media.type}] ${media.name}` : finalMessage,
        status: "Sent"
      });
      results.push({ number, success: true });
    } catch (error) {
      markFailedMessage(userId, 1);
      addHistoryEntry({
        time: nowIso(),
        mode: "WEB",
        messageType,
        userId,
        fromDevice: record.deviceLabel || userId,
        to: number,
        content: media ? `[${media.type}] ${media.name}` : finalMessage,
        status: "Failed"
      });
      results.push({ number, success: false, error: error.message });
    }

    if (isRepeatedSingle) {
      await wait(1200);
    }
  }

  logAudit("message.dispatch", {
    userId,
    messageType,
    recipientCount: cleanNumbers.length
  });

  if (!results.some((item) => item.success)) {
    clearDuplicateGuard(userId, cleanNumbers, finalMessage, duplicateContext);
  }

  return {
    success: results.some((item) => item.success),
    successCount: results.filter((item) => item.success).length,
    failureCount: results.filter((item) => !item.success).length,
    results
  };
}

function buildRecipientNumber(rawNumber, rawDialCode = "") {
  const dialCode = normalizeNumber(rawDialCode);
  const input = normalizeNumber(rawNumber);

  if (!input) {
    return "";
  }

  if (!dialCode) {
    return input;
  }

  if (input.startsWith(dialCode) && input.length >= dialCode.length + 8) {
    return input;
  }

  return `${dialCode}${input}`;
}

function armSchedule(item) {
  const delay = Math.max(0, new Date(item.scheduledFor).getTime() - Date.now());
  const timer = setTimeout(async () => {
    try {
      await dispatchMessage({
        userId: item.userId,
        numbers: item.numbers.length ? item.numbers : [item.number],
        message: item.message,
        templateId: item.templateId,
        variables: item.variables,
        mediaId: item.mediaId,
        messageType: item.numbers.length ? "Scheduled Group" : "Scheduled Single"
      });
      item.status = "sent";
    } catch (error) {
      item.status = "failed";
      item.error = error.message;
    }

    persistScheduleUpdate(item);
    scheduleTimers.delete(item.id);
  }, delay);

  scheduleTimers.set(item.id, timer);
}

function scheduleMessage(payload) {
  const schedules = load("schedules");
  const item = {
    id: payload.id || id("schedule"),
    type: "one_time",
    userId: payload.userId,
    number: payload.number || "",
    numbers: payload.numbers || [],
    message: payload.message || "",
    templateId: payload.templateId || "",
    variables: payload.variables || {},
    mediaId: payload.mediaId || "",
    timezone: payload.timezone || "Asia/Calcutta",
    scheduledFor: payload.scheduledFor,
    status: "scheduled",
    createdAt: nowIso()
  };

  schedules.unshift(item);
  save("schedules", schedules);
  armSchedule(item);
  return item;
}

function restoreSchedules() {
  const schedules = load("schedules")
    .filter((item) => item.type === "one_time" && item.status === "scheduled");

  for (const item of schedules) {
    if (scheduleTimers.has(item.id)) {
      continue;
    }

    armSchedule(item);
  }
}

router.get("/history", (req, res) => {
  const allowedUserIds = new Set(listDevicesByOwner(req.authUser.id).map((item) => item.userId));
  const items = filteredHistory(req.query).filter((item) => allowedUserIds.has(item.userId));
  res.json({ history: items });
});

router.post("/send", async (req, res) => {
  try {
    requireOwnedDevice(req, req.body.userId);
    const repeatCount = Math.min(15, Math.max(1, Number.parseInt(req.body.repeatCount || 1, 10) || 1));
    const recipientNumber = buildRecipientNumber(req.body.number, req.body.dialCode);
    const data = await dispatchMessage({
      userId: req.body.userId,
      numbers: Array.from({ length: repeatCount }, () => recipientNumber),
      message: req.body.message,
      templateId: req.body.templateId,
      variables: req.body.variables,
      mediaId: req.body.mediaId,
      messageType: repeatCount > 1 ? "Single Repeat" : "Single",
      duplicateContext: repeatCount > 1 ? `repeat:${repeatCount}` : "single"
    });

    res.json({ ...data, mode: "single", repeatCount });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

router.post("/send-group", async (req, res) => {
  try {
    requireOwnedDevice(req, req.body.userId);
    if (req.body.confirm !== true && validateNumbers(req.body.numbers || []).length > 10) {
      return res.status(400).json({ error: "Confirm large group blast before sending" });
    }

    const data = await dispatchMessage({
      userId: req.body.userId,
      numbers: req.body.numbers || [],
      message: req.body.message,
      templateId: req.body.templateId,
      variables: req.body.variables,
      mediaId: req.body.mediaId,
      messageType: "Group",
      duplicateContext: "group"
    });

    res.json({ ...data, mode: "group" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

router.post("/send-media", async (req, res) => {
  try {
    requireOwnedDevice(req, req.body.userId);
    const singleNumber = buildRecipientNumber(req.body.number, req.body.dialCode);
    const data = await dispatchMessage({
      userId: req.body.userId,
      numbers: req.body.numbers?.length ? req.body.numbers : [singleNumber],
      message: req.body.message,
      templateId: req.body.templateId,
      variables: req.body.variables,
      mediaId: req.body.mediaId,
      messageType: "Media",
      duplicateContext: "media"
    });

    res.json({ ...data, mode: "media" });
  } catch (error) {
    res.status(error.statusCode || 400).json({ error: error.message });
  }
});

router.post("/schedule", (req, res) => {
  try {
    requireOwnedDevice(req, req.body.userId);
    if (!req.body.scheduledFor) {
      return res.status(400).json({ error: "scheduledFor is required" });
    }

    const item = scheduleMessage(req.body);
    res.json({ success: true, item });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete("/schedule/:itemId", (req, res) => {
  const itemId = req.params.itemId;
  const timer = scheduleTimers.get(itemId);

  if (timer) {
    clearTimeout(timer);
    scheduleTimers.delete(itemId);
  }

  const updated = load("schedules").filter((item) => item.id !== itemId);
  save("schedules", updated);
  logAudit("schedule.delete", { id: itemId });
  res.json({ success: true });
});

restoreSchedules();

module.exports = router;
