import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

export function requireCompiler(t) {
  const probe = spawnSync("cc", ["--version"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT" && process.env.HA_NATIVE_TESTS_REQUIRED !== "1") {
    t.skip("requires a C compiler; production images intentionally omit build tools");
    return false;
  }
  assert.equal(probe.status, 0, probe.stderr || probe.error?.message);
  return true;
}
