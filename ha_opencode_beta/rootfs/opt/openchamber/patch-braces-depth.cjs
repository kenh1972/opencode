// GHSA-vfj7-8cjw-p6xm has no published fix. Bound both parsed patterns and
// caller-supplied AST recursion without relabelling the upstream package version.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const root = process.argv[2];
if (!root) throw new Error("Provide the OpenChamber web package directory");
const web = createRequire(path.join(root, "package.json"));
const proxy = createRequire(web.resolve("http-proxy-middleware"));
const matcher = createRequire(proxy.resolve("micromatch"));
const directory = path.dirname(matcher.resolve("braces/package.json"));
if (JSON.parse(fs.readFileSync(path.join(directory, "package.json"))).version !== "3.0.3") {
  throw new Error("Review the braces depth mitigation for this upstream version");
}
function once(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("Unexpected braces implementation; review the depth mitigation");
  return source.replace(before, after);
}
const guard = '    if (depth > 64) throw new SyntaxError("Brace nesting exceeds the supported depth of 64");\n';
const files = ["parse", "compile", "expand", "stringify"].map(name => {
  const file = path.join(directory, "lib", name + ".js");
  let source = fs.readFileSync(file, "utf8");
  if (name === "parse") {
    source = once(source, "  while (index < length) {\n", '  while (index < length) {\n    if (stack.length > 64) throw new SyntaxError("Brace nesting exceeds the supported depth of 64");\n');
  } else {
    const walk = name === "stringify" ? "stringify" : "walk";
    source = once(source, `  const ${walk} = (node, parent = {}) => {\n`, `  const ${walk} = (node, parent = {}, depth = 0) => {\n${guard}`);
    source = once(source, name === "stringify" ? "stringify(child)" : "walk(child, node)", `${walk}(child, node, depth + 1)`);
  }
  return [file, source];
});
for (const [file, source] of files) {
  fs.writeFileSync(file + ".ha-patched", source);
  fs.renameSync(file + ".ha-patched", file);
}
const hashes = Object.fromEntries(files.map(([file, source]) => [path.basename(file), createHash("sha256").update(source).digest("hex")]));
fs.writeFileSync(path.join(directory, "ha-depth-mitigation.json"), JSON.stringify({ advisory: "GHSA-vfj7-8cjw-p6xm", version: "3.0.3", hashes }, null, 2) + "\n");
console.log("Mitigated braces parser and AST walker recursion; advisory remains visible as vendor-patched");
