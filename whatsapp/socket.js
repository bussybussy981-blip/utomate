const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const path = require("path");
const { sessionsDir } = require("../utils/paths");

const {
  setSession,
  getSessionRecord,
  listSavedUserIds,
  updateSessionStatus,
  setReconnectState,
  updateSessionProfile,
  noteQrRefresh,
  noteReconnectAttempt
} = require("./sessions");

const pendingSockets = new Map();
let savedSessionsConnectPromise = null;

async function createSocket(userId, options = {}) {
  const existing = getSessionRecord(userId);

  if (!options.forceNew && existing?.sock && ["connecting", "connected", "qr_ready"].includes(existing.status)) {
    return existing.sock;
  }

  const pending = pendingSockets.get(userId);

  if (pending && !options.forceNew) {
    return pending;
  }

  if (pending && options.forceNew) {
    return pending;
  }

  updateSessionStatus(userId, "connecting");
  setReconnectState(userId, false);

  const socketPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionsDir, userId));
    const { version, isLatest } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      auth: state,
      version,
      browser: ["Web", "Chrome", "122.0.0.0"],
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    console.log(`Using WA version ${version.join(".")} for ${userId}. latest=${isLatest}`);

    setSession(userId, sock, "connecting");

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, qr, lastDisconnect } = update;
      const record = getSessionRecord(userId);

      if (record?.sock !== sock) {
        return;
      }

      if (qr) {
        sock.qr = qr;
        updateSessionStatus(userId, "qr_ready");
        noteQrRefresh(userId);
        console.log(`QR for ${userId}:`, qr);
      }

      if (connection === "open") {
        sock.qr = null;
        updateSessionStatus(userId, "connected");
        setReconnectState(userId, false);
        pendingSockets.delete(userId);
        updateSessionProfile(userId, {
          phone: sock.user?.id?.split(":")[0] || "",
          deviceLabel: sock.user?.name || userId
        });
        console.log(`Connected: ${userId}`);
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isConflict = statusCode === 440;
        const isQrExpired = statusCode === 408 && !sock.user;
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut &&
          !isConflict &&
          !isQrExpired;

        if (isQrExpired) {
          sock.qr = null;
        }

        updateSessionStatus(
          userId,
          shouldReconnect ? "disconnected" : isQrExpired ? "qr_expired" : isConflict ? "conflict" : "logged_out"
        );

        console.log("Disconnected:", {
          userId,
          statusCode,
          shouldReconnect,
          isQrExpired
        });

        if (shouldReconnect && !record.reconnecting) {
          setReconnectState(userId, true);
          noteReconnectAttempt(userId);

          setTimeout(() => {
            const latestRecord = getSessionRecord(userId);

            if (latestRecord?.sock !== sock) {
              return;
            }

            pendingSockets.delete(userId);
            createSocket(userId, { forceNew: true }).catch((error) => {
              setReconnectState(userId, false);
              console.error(`Reconnect failed for ${userId}`, error);
            });
          }, 3000);
        } else {
          pendingSockets.delete(userId);
        }
      }
    });

    return sock;
  })().catch((error) => {
    pendingSockets.delete(userId);
    throw error;
  });

  pendingSockets.set(userId, socketPromise);

  return socketPromise;
}

async function reconnectSocket(userId) {
  return createSocket(userId, { forceNew: true });
}

async function connectSavedSessions() {
  if (savedSessionsConnectPromise) {
    return savedSessionsConnectPromise;
  }

  const userIds = listSavedUserIds();

  savedSessionsConnectPromise = (async () => {
    for (const userId of userIds) {
      try {
        await createSocket(userId);
      } catch (error) {
        console.error(`Auto-connect failed for ${userId}`, error.message || error);
      }
    }
  })();

  try {
    await savedSessionsConnectPromise;
  } finally {
    savedSessionsConnectPromise = null;
  }
}

module.exports = {
  createSocket,
  reconnectSocket,
  connectSavedSessions
};
