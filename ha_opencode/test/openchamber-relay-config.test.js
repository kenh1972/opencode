const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const addon = path.resolve(__dirname, "..");
const { parseDocument } = createRequire(path.join(addon, "rootfs/opt/ha-mcp-server/package.json"))("yaml");

test("relay option and translations are valid independent mappings", () => {
  const load = (file) => {
    const doc = parseDocument(fs.readFileSync(path.join(addon, file), "utf8"), { uniqueKeys: true });
    assert.deepEqual(doc.errors, []);
    return doc.toJS();
  };
  const config = load("config.yaml");
  const translations = load("translations/en.yaml").configuration;
  assert.equal(config.options.openchamber_relay_host, false);
  assert.equal(config.schema.openchamber_relay_host, "bool?");
  for (const key of ["openchamber_lan_native_apps", "openchamber_relay_host"]) {
    assert.equal(typeof translations[key].name, "string");
    assert.equal(typeof translations[key].description, "string");
  }
  assert.notEqual(translations.openchamber_lan_native_apps.name, translations.openchamber_relay_host.name);
});

test("managed launcher passes absent/false/true relay options to its scrubbed environment", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ha-relay-launcher-"));
  try {
    // Intercept exec env, so the real launcher runs without starting services or
    // accessing /data. Every other external operation is stubbed explicitly.
    fs.writeFileSync(path.join(root, "env"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const launcher = path.join(addon, "rootfs/etc/s6-overlay/s6-rc.d/ha-openchamber/run");
    const harness = `cat() { printf openchamber; }
mkdir() { :; }
bashio::log.info() { :; }
bashio::config() { printf '%s' "\${RELAY_TEST_OPTION:-$2}"; }
source "$1"`;
    for (const [option, expected] of [["", "off"], ["false", "off"], ["true", "on"]]) {
      const result = spawnSync("bash", ["-c", harness, "relay-fixture", launcher], {
        encoding: "utf8", env: { PATH: `${root}:/usr/bin:/bin`, RELAY_TEST_OPTION: option },
      });
      assert.equal(result.status, 0, result.stderr);
      const args = result.stdout.trim().split("\n");
      assert.equal(args[0], "-i");
      assert.ok(args.includes(`OPENCHAMBER_RELAY_HOST=${expected}`));
      assert.ok(args.includes("OPENCHAMBER_HOST=127.0.0.1"));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
