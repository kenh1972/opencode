// simple-git 4 copies only own environment keys, losing OpenChamber's trusted
// inherited server settings. Preserve inherited keys ONLY when the caller has
// explicitly included them in allowEnvironment. Own-key and argv guards stay on.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const requireWeb = createRequire(path.join(process.argv[2], "package.json"));
const entry = requireWeb.resolve("simple-git");
const directory = path.dirname(entry);
const file = path.join(directory, "index.mjs");
const source = fs.readFileSync(file, "utf8");
const before = "const o = { ...r.env ?? process.env }, i = new Set(";
if (source.split(before).length !== 2) throw new Error("Review pinned simple-git environment implementation");
const after = `const inherited = {};
      for (const key in r.env ?? {}) {
        if (!Object.hasOwn(r.env, key) && n.has(key.toLowerCase().trim())) inherited[key] = r.env[key];
      }
      const o = { ...inherited, ...r.env ?? process.env }, i = new Set(`;
// Bun may hard-link installs to its cache. Replace the inode, not the cache.
fs.writeFileSync(file + ".ha-patched", source.replace(before, after));
fs.renameSync(file + ".ha-patched", file);
console.log("Git ESM runtime retains explicitly allowed inherited environment keys; argument guards unchanged");
