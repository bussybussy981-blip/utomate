const express = require("express");
const cors = require("cors");
const path = require("path");

const authRoutes = require("./routes/auth");
const deviceRoutes = require("./routes/device");
const messageRoutes = require("./routes/message");
const featureRoutes = require("./routes/features");
const { ensureSuperAdmin } = require("./utils/db");
const { requireAuth, getAuthUserFromRequest } = require("./utils/auth");
const { hashPassword } = require("./utils/auth");
const { connectSavedSessions } = require("./whatsapp/socket");

const app = express();
const port = Number(process.env.PORT) || 5000;

ensureSuperAdmin({
  username: "tada",
  name: "Tada",
  passwordHash: hashPassword("tadatada")
});

app.use(cors());
app.use(express.json({ limit: "250mb" }));

app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/logo.png", (req, res) => {
  res.sendFile(path.join(__dirname, "logo.png"));
});

app.get("/login-motion.mp4", (req, res) => {
  const target = path.join(__dirname, "login-motion.mp4");
  res.sendFile(target, (error) => {
    if (error) {
      res.status(error.statusCode || 404).json({ error: "login-motion.mp4 not found" });
    }
  });
});

app.get("/login", (req, res) => {
  const authUser = getAuthUserFromRequest(req);

  if (authUser) {
    return res.redirect("/");
  }

  res.sendFile(path.join(__dirname, "login.html"));
});

app.get("/register", (req, res) => {
  const authUser = getAuthUserFromRequest(req);

  if (authUser) {
    return res.redirect("/");
  }

  res.sendFile(path.join(__dirname, "register.html"));
});

app.get("/", (req, res) => {
  const authUser = getAuthUserFromRequest(req);

  if (!authUser) {
    return res.redirect("/login");
  }

  res.sendFile(path.join(__dirname, "index.html"));
});

app.use("/api/auth", authRoutes);
app.use("/api/device", requireAuth, deviceRoutes);
app.use("/api/message", requireAuth, messageRoutes);
app.use("/api/features", requireAuth, featureRoutes);

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  connectSavedSessions().catch((error) => {
    console.error("Saved session auto-connect failed", error);
  });
});
