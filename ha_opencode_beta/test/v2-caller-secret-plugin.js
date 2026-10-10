// Loaded only by the in-image boundary fixture, never installed as a user plugin.
import plugin from "/opt/opencode-v2-homeassistant/plugin.js";

export default {
  ...plugin,
  async setup(ctx) {
    let previous;
    for (let generation = 0; generation < 3; generation++) {
      // Exercise distinct module generations in the real host. OpenCode 2.0.26
      // intentionally disallows importing its private plugin source loader.
      {
        const module = await import(new URL(`./generation-${generation}.js`, import.meta.url).href);
        if (module.createSetup === previous) throw new Error("Fixture did not reload the plugin module");
        previous = module.createSetup;
        const setup = module.createSetup();
        for (let activation = 0; activation < 2; activation++) {
          let registered = false;
          const dispose = await setup({
            options: ctx.options,
            mcp: { async transform(callback) {
              callback({ set(name, config) {
                if (config.headers.Authorization !== `Bearer ${"0".repeat(64)}`) {
                  throw new Error("Reloaded plugin did not acquire the fixture credential");
                }
                if (name === "homeassistant") registered = true;
              } });
              return { async dispose() {} };
            } },
          });
          if (!registered) throw new Error("Reloaded plugin did not register MCP");
          await dispose();
        }
      }
    }
    // Keep the real MCP registration for the live V2 policy/tool checks.
    const dispose = await plugin.setup(ctx);
    console.log("V2 caller credential module-reload regression passed");
    return dispose;
  },
};
