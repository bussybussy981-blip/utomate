const fs = require("fs");
const path = require("path");

function resolveStorageRoot() {
  const configuredRoot =
    process.env.STORAGE_ROOT ||
    process.env.RENDER_DISK_ROOT ||
    path.join(__dirname, "..");

  const absoluteRoot = path.resolve(configuredRoot);

  if (!fs.existsSync(absoluteRoot)) {
    fs.mkdirSync(absoluteRoot, { recursive: true });
  }

  return absoluteRoot;
}

const storageRoot = resolveStorageRoot();

function ensureSubdir(name) {
  const target = path.join(storageRoot, name);

  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  return target;
}

module.exports = {
  storageRoot,
  dataDir: ensureSubdir("data"),
  sessionsDir: ensureSubdir("sessions")
};
