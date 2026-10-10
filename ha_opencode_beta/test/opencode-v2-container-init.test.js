import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { requireCompiler } from "./helpers/native-compiler.js";

test("pre-init identifies missing mounts, non-directories and ownership mismatches without modifying them", { skip: process.platform !== "linux" }, async (t) => {
  if (!requireCompiler(t)) return;
  const root = await mkdtemp(join(tmpdir(), "ha-container-init-"));
  try {
    const source = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/container-init.c", import.meta.url));
    const fixture = join(root, "fixture.c");
    const binary = join(root, "fixture");
    // Exercise the shipped check without needing root, publishing a readiness
    // marker, or executing the container's /init on the developer machine.
    await writeFile(fixture, `#define main container_main\n#include ${JSON.stringify(source)}\n#undef main\nint main(int argc, char **argv) {\n  if (argc != 3) return 2;\n  require_directory(argv[1], getuid() + (argv[2][0] == '1'), getgid());\n  return 0;\n}\n`);
    const compiled = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", fixture, "-o", binary], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
    const directory = join(root, "workspace");
    const link = join(root, "linked-workspace");
    const file = join(root, "file");
    await mkdir(directory);
    await symlink(directory, link);
    await writeFile(file, "unchanged");
    const probe = (path, mismatch = "0") => spawnSync(binary, [path, mismatch], { encoding: "utf8" });
    assert.equal(probe(directory).status, 0);
    const missing = probe(join(root, "missing"));
    assert.equal(missing.status, 126);
    assert.match(missing.stderr, /cannot inspect .*missing: No such file or directory/);
    for (const path of [link, file]) {
      const result = probe(path);
      assert.equal(result.status, 126);
      assert.ok(result.stderr.includes(path));
      assert.match(result.stderr, /must be a real directory/);
    }
    const ownership = probe(directory, "1");
    assert.equal(ownership.status, 126);
    assert.ok(ownership.stderr.includes(`has uid=${process.getuid()} gid=${process.getgid()}; expected uid=${process.getuid() + 1}`));
    assert.match(ownership.stderr, /no files were changed/);
    assert.equal(probe(directory).status, 0, "the mismatch must not change directory ownership");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
