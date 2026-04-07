const express = require("express");
const router = express.Router();

const {
  load,
  save,
  id,
  nowIso,
  upsertItem,
  removeItem,
  logAudit
} = require("../utils/appData");

function listHandler(bucket) {
  return (req, res) => {
    res.json({ items: load(bucket) });
  };
}

function createHandler(bucket, mapper) {
  return (req, res) => {
    const item = mapper(req.body);
    upsertItem(bucket, item);
    logAudit(`${bucket}.create`, item);
    res.json({ success: true, item });
  };
}

function deleteHandler(bucket) {
  return (req, res) => {
    removeItem(bucket, req.params.itemId);
    logAudit(`${bucket}.delete`, { id: req.params.itemId });
    res.json({ success: true });
  };
}

router.get("/templates", listHandler("templates"));
router.post("/templates", createHandler("templates", (body) => ({
  id: body.id || id("tpl"),
  name: body.name || "Untitled template",
  content: body.content || "",
  variables: body.variables || [],
  createdAt: nowIso(),
  updatedAt: nowIso()
})));
router.delete("/templates/:itemId", deleteHandler("templates"));

router.get("/contacts", listHandler("contacts"));
router.post("/contacts", createHandler("contacts", (body) => ({
  id: body.id || id("contact"),
  name: body.name || "",
  number: body.number || "",
  tags: body.tags || [],
  createdAt: nowIso()
})));
router.delete("/contacts/:itemId", deleteHandler("contacts"));

router.get("/lists", listHandler("lists"));
router.post("/lists", createHandler("lists", (body) => ({
  id: body.id || id("list"),
  name: body.name || "Untitled list",
  contactIds: body.contactIds || [],
  createdAt: nowIso()
})));
router.delete("/lists/:itemId", deleteHandler("lists"));

router.get("/media", listHandler("media"));
router.post("/media", createHandler("media", (body) => ({
  id: body.id || id("media"),
  name: body.name || "Untitled media",
  mimeType: body.mimeType || "application/octet-stream",
  type: body.type || "document",
  data: body.data || "",
  caption: body.caption || "",
  createdAt: nowIso()
})));
router.delete("/media/:itemId", deleteHandler("media"));

router.get("/operators", listHandler("operators"));
router.post("/operators", createHandler("operators", (body) => ({
  id: body.id || id("operator"),
  name: body.name || "Operator",
  role: body.role || "viewer",
  active: body.active !== false,
  createdAt: nowIso()
})));
router.delete("/operators/:itemId", deleteHandler("operators"));

router.get("/audit", (req, res) => {
  res.json({ items: load("audit") });
});

router.get("/schedules", (req, res) => {
  const schedules = load("schedules").filter((item) => item.type !== "recurring");
  res.json({ items: schedules });
});

router.post("/schedules", (req, res) => {
  const item = {
    id: req.body.id || id("schedule"),
    type: "one_time",
    userId: req.body.userId || "",
    number: req.body.number || "",
    numbers: req.body.numbers || [],
    message: req.body.message || "",
    scheduledFor: req.body.scheduledFor || nowIso(),
    timezone: req.body.timezone || "Asia/Calcutta",
    status: "scheduled",
    createdAt: nowIso()
  };

  upsertItem("schedules", item);
  logAudit("schedules.create", item);
  res.json({ success: true, item });
});

router.delete("/schedules/:itemId", deleteHandler("schedules"));

module.exports = router;
