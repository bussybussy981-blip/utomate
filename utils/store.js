const fs = require("fs");
const path = require("path");
const { dataDir } = require("./paths");

function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function filePath(name) {
  ensureDir();
  return path.join(dataDir, `${name}.json`);
}

function readJson(name, fallback) {
  const target = filePath(name);

  if (!fs.existsSync(target)) {
    writeJson(name, fallback);
    return structuredCloneSafe(fallback);
  }

  try {
    return JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    writeJson(name, fallback);
    return structuredCloneSafe(fallback);
  }
}

function writeJson(name, value) {
  const target = filePath(name);
  fs.writeFileSync(target, JSON.stringify(value, null, 2));
}

function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = {
  readJson,
  writeJson
};
