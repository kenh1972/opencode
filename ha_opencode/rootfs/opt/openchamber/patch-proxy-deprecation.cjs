// Keep the pinned proxy behavior while removing Node's deprecated shallow copy.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const root = process.argv[2];
if (!root) throw new Error("Provide the OpenChamber web package directory");
const webRequire = createRequire(path.join(root, "package.json"));
const proxyRequire = createRequire(webRequire.resolve("http-proxy-middleware"));
const proxyRoot = path.dirname(proxyRequire.resolve("http-proxy/package.json"));
if (JSON.parse(fs.readFileSync(path.join(proxyRoot, "package.json"))).version !== "1.18.1") {
  throw new Error("Review the proxy deprecation patch for the new upstream version");
}
const files = ["index.js", "common.js"].map(name => {
  const file = path.join(proxyRoot, "lib/http-proxy", name);
  const source = fs.readFileSync(file, "utf8");
  const matches = source.match(/require\('util'\)\._extend/g) || [];
  if (matches.length !== 1) throw new Error(`Unexpected shallow-copy implementation in ${name}`);
  return [file, source.replace("require('util')._extend", "Object.assign")];
});
for (const [file, source] of files) {
  fs.writeFileSync(file + ".ha-patched", source);
  fs.renameSync(file + ".ha-patched", file);
}
console.log("Pinned proxy uses Object.assign without util._extend");
