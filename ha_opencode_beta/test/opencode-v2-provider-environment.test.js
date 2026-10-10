import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { prepareUserConfig } from "../rootfs/opt/opencode-v2-homeassistant/user-config.js";
import { requireCompiler } from "./helpers/native-compiler.js";

const launcher = fileURLToPath(new URL("../rootfs/opt/opencode-v2-homeassistant/secure-launcher.c", import.meta.url));

test("native launcher loads only the secured provider environment and rejects unsafe files/entries", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0 ? "requires Linux root and a C compiler (run in the CI build environment)" : false,
}, async (t) => {
  if (!requireCompiler(t)) return;
  const root = await mkdtemp(join(tmpdir(), "ha-provider-env-"));
  try {
    const runtime = join(root, "runtime");
    await mkdir(runtime);
    const source = join(root, "probe.c");
    const binary = join(root, "probe");
    await writeFile(source, `#define main launcher_main
#include ${JSON.stringify(launcher)}
#undef main
int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 2;
  set_environment(argv[1], "/fixture-generation", "/fixture-cache");
  if (getenv("SUPERVISOR_TOKEN") || getenv("OPENCODE_CONFIG_CONTENT") || getenv("PPQ_API_KEY")) return 3;
  const char *key = getenv("FIXTURE_API_KEY");
  if (argc == 3 ? key != NULL : (!key || strcmp(key, "fixture-key-$'backtick=literal") != 0)) return 4;
  const char *search_keys[] = {"EXA_API_KEY", "FIRECRAWL_API_KEY", "PARALLEL_API_KEY", "TAVILY_API_KEY", NULL};
  for (int i = 0; search_keys[i]; i++) {
    const char *value = getenv(search_keys[i]);
    if (argc == 3 ? value != NULL : (!value || strcmp(value, "fixture-search-key") != 0)) return 6;
  }
  if (strcmp(getenv("OPENCODE_DISABLE_PROJECT_CONFIG"), "1") != 0) return 5;
  return 0;
}
`);
    const built = spawnSync("cc", ["-Wall", "-Wextra", "-Werror", source, "-o", binary], { encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr || built.error?.message);
    const file = join(runtime, "provider-env");
    const run = (expectEmpty = false) => spawnSync(binary, [runtime, ...(expectEmpty ? ["empty"] : [])], { encoding: "utf8", env: {
      PATH: process.env.PATH, SUPERVISOR_TOKEN: "fixture-supervisor", OPENCODE_CONFIG_CONTENT: "fixture-override", PPQ_API_KEY: "fixture-ppq",
    } });
    const missing = run();
    assert.equal(missing.status, 126, "a missing provider-env must fail closed, not start without configured keys");
    assert.match(missing.stderr, /provider environment is not a secured root-owned file/);
    await writeFile(file, "", { mode: 0o600 });
    assert.equal(run(true).status, 0, "an explicit secured empty environment is valid");
    const valid = prepareUserConfig({ env_vars: [
      { name: "FIXTURE_API_KEY", value: "fixture-key-$'backtick=literal" },
      ...["EXA", "FIRECRAWL", "PARALLEL", "TAVILY"].map((provider) => ({ name: `${provider}_API_KEY`, value: "fixture-search-key" })),
    ] }).providerEnvironment;
    await writeFile(file, valid, { mode: 0o600 });
    assert.equal(run().status, 0);

    for (const payload of [
      "SUPERVISOR_API_KEY=fixture-private\0", "OPENCODE_CONFIG_CONTENT=fixture-private\0",
      "HA_API_KEY=fixture-private\0", "PPQ_API_KEY=fixture-private\0", "LD_PRELOAD=fixture-private\0",
      "NODE_OPTIONS=fixture-private\0", "BAD_API_KEY=fixture-private", "NO_EQUALS\0", "=fixture-private\0",
    ]) {
      await writeFile(file, payload);
      const result = run();
      assert.equal(result.status, 126);
      assert.doesNotMatch(result.stderr, /fixture-private/);
    }
    await writeFile(file, valid);
    await chmod(file, 0o644);
    assert.equal(run().status, 126);
    await chmod(file, 0o4600);
    assert.equal(run().status, 126);
    await chmod(file, 0o600);
    const alias = join(root, "alias");
    await link(file, alias);
    assert.equal(run().status, 126);
    await rm(alias);
    await rm(file);
    await writeFile(alias, valid, { mode: 0o600 });
    await symlink(alias, file);
    assert.equal(run().status, 126);
  } finally { await rm(root, { recursive: true, force: true }); }
});
