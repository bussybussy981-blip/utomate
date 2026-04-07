const crypto = require("crypto");
const { readJson, writeJson } = require("./store");

const defaults = {
  templates: [],
  contacts: [],
  lists: [],
  media: [],
  operators: [
    { id: "admin", name: "Admin", role: "admin", active: true }
  ],
  audit: [],
  schedules: [],
  history: []
};

function load(name) {
  return readJson(name, defaults[name] || []);
}

function save(name, value) {
  writeJson(name, value);
  return value;
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function pushItem(bucket, item, limit = 200) {
  const items = load(bucket);
  items.unshift(item);

  if (items.length > limit) {
    items.length = limit;
  }

  save(bucket, items);
  return item;
}

function upsertItem(bucket, item) {
  const items = load(bucket);
  const index = items.findIndex((entry) => entry.id === item.id);

  if (index >= 0) {
    items[index] = item;
  } else {
    items.unshift(item);
  }

  save(bucket, items);
  return item;
}

function removeItem(bucket, itemId) {
  const items = load(bucket).filter((item) => item.id !== itemId);
  save(bucket, items);
  return items;
}

function logAudit(action, payload = {}) {
  return pushItem("audit", {
    id: id("audit"),
    action,
    payload,
    createdAt: nowIso()
  }, 500);
}

module.exports = {
  defaults,
  load,
  save,
  id,
  nowIso,
  pushItem,
  upsertItem,
  removeItem,
  logAudit
};
