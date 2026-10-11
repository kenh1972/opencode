/**
 * Secret-free MCP configuration contract. The caller must establish installation
 * provenance before calling this resolver: Supervisor merges image defaults with
 * saved options, so absent settings alone never establish a new installation.
 * Persistence and transport activation belong to startup, not this module.
 */
export const MCP_CONFIG_VERSION = 1;
export const NATIVE_MCP_SELECTIONS = Object.freeze(["home_assistant", "assist", "custom"]);

function invalid(message) {
  // Do not interpolate option/environment values: unrelated options may be secrets.
  throw new TypeError(`Home Assistant MCP configuration: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
}

function booleanOption(options, name, fallback) {
  if (!Object.hasOwn(options, name)) return fallback;
  if (typeof options[name] !== "boolean") invalid(`${name} must be true or false`);
  return options[name];
}

function apiId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value.trim())) {
    invalid("Specific API requires an API ID, not a URL or an empty value");
  }
  return value.trim();
}

function legacySelection(value) {
  if (value === "") return { selection: "home_assistant", apiId: null };
  const id = apiId(value);
  return { selection: id === "assist" ? "assist" : "custom", apiId: id };
}

function validateCompatibility(value) {
  if (value === null) return null;
  object(value, "compatibility record");
  if (Object.keys(value).some((key) => !["version", "selection", "apiId", "endpointMode"].includes(key))
    || value.version !== MCP_CONFIG_VERSION || value.endpointMode !== "auto"
    || !["assist", "custom"].includes(value.selection)) {
    invalid("unsupported compatibility record");
  }
  const id = apiId(value.apiId);
  if (id !== value.apiId || (value.selection === "assist") !== (id === "assist")) {
    invalid("invalid compatibility selection");
  }
  return { version: MCP_CONFIG_VERSION, selection: value.selection, apiId: id, endpointMode: "auto" };
}

export function resolveMcpConfiguration({
  options = {},
  provenance,
  overrides = {},
  compatibility = null,
} = {}) {
  object(options, "options");
  object(overrides, "overrides");
  if (!["new", "legacy", "current"].includes(provenance)) {
    invalid("explicit new, legacy or current installation provenance is required");
  }
  if (Object.keys(overrides).some((key) => !["HA_NATIVE_MCP_API_ID", "HA_NATIVE_MCP_ENDPOINT_MODE"].includes(key))) {
    invalid("unsupported native override");
  }
  const priorCompatibility = validateCompatibility(compatibility);
  if (provenance !== "current" && priorCompatibility) {
    invalid("compatibility records require current installation provenance");
  }

  const bundledEnabled = booleanOption(options, "mcp_enabled", true);
  const profile = Object.hasOwn(options, "mcp_tool_profile") ? options.mcp_tool_profile : "full";
  if (!["compact", "configuration", "full"].includes(profile)) invalid("unknown bundled tool profile");
  const nativeRequested = booleanOption(options, "native_ha_mcp_enabled", provenance === "new");
  const hasSelection = Object.hasOwn(options, "native_ha_mcp_selection");
  if (provenance === "current" && ["native_ha_mcp_enabled", "native_ha_mcp_selection", "native_ha_mcp_api_id"]
    .some((key) => !Object.hasOwn(options, key))) {
    invalid("current installations require complete persisted native settings");
  }
  if (provenance === "legacy" && hasSelection) invalid("legacy provenance conflicts with explicit native selection");

  const storedId = options.native_ha_mcp_api_id;
  if (Object.hasOwn(options, "native_ha_mcp_api_id") && typeof storedId !== "string") {
    invalid("native_ha_mcp_api_id must be a string");
  }
  let selection;
  let selectedId;
  if (hasSelection) {
    selection = options.native_ha_mcp_selection;
    if (!NATIVE_MCP_SELECTIONS.includes(selection)) invalid("unknown native tool selection");
    selectedId = selection === "home_assistant" ? null : selection === "assist" ? "assist" : apiId(storedId);
  } else if (provenance === "legacy" || storedId !== undefined) {
    const legacy = legacySelection((storedId ?? "assist").trim());
    selection = legacy.selection;
    selectedId = legacy.apiId;
  } else {
    selection = "home_assistant";
    selectedId = null;
  }

  if (Object.hasOwn(overrides, "HA_NATIVE_MCP_API_ID")) {
    if (typeof overrides.HA_NATIVE_MCP_API_ID !== "string") invalid("native API override must be a string");
    const override = legacySelection(overrides.HA_NATIVE_MCP_API_ID.trim());
    if (provenance === "legacy") {
      selection = override.selection;
      selectedId = override.apiId;
    } else if (override.apiId !== selectedId) {
      invalid("native API override conflicts with the selected API; remove the override or update the selection");
    }
  }

  let endpointMode = selectedId ? "keyed" : "configured";
  const retainedCompatibility = priorCompatibility?.selection === selection
    && priorCompatibility.apiId === selectedId ? priorCompatibility : null;
  if (provenance === "legacy" && selectedId) endpointMode = "auto";
  else if (retainedCompatibility) endpointMode = retainedCompatibility.endpointMode;

  if (Object.hasOwn(overrides, "HA_NATIVE_MCP_ENDPOINT_MODE")) {
    const override = overrides.HA_NATIVE_MCP_ENDPOINT_MODE;
    if (!["auto", "keyed", "configured"].includes(override)) invalid("unknown native endpoint-mode override");
    if (provenance === "legacy") {
      // The old configured mode ignores the saved API ID. Preserve the endpoint
      // actually used, rather than migrating its unused ID into a keyed request.
      if (override === "configured" || selectedId === null) {
        selection = "home_assistant";
        selectedId = null;
        endpointMode = "configured";
      } else endpointMode = override;
    } else if (override !== endpointMode) {
      invalid("native endpoint-mode override conflicts with the resolved selection; remove the override");
    }
  }

  // One-time upgrade policy: legacy Assist (including the old implicit default)
  // moves to HA's configured API catalogue. Resolve legacy overrides first so a
  // custom API remains custom. Never rewrite explicit post-migration selections
  // or change effective enablement; startup must disclose the scope change.
  const migrateAssist = provenance === "legacy" && selection === "assist";
  if (migrateAssist) {
    selection = "home_assistant";
    selectedId = null;
    endpointMode = "configured";
  }

  const nativeEnabled = provenance === "legacy" ? bundledEnabled && nativeRequested : nativeRequested;
  const canonicalOptions = {
    native_ha_mcp_enabled: nativeEnabled,
    native_ha_mcp_selection: selection,
    native_ha_mcp_api_id: selection === "custom" ? selectedId : "",
  };
  const optionPatch = Object.fromEntries(Object.entries(canonicalOptions)
    .filter(([key, value]) => !Object.hasOwn(options, key) || options[key] !== value));
  const nextCompatibility = endpointMode === "auto" ? {
    version: MCP_CONFIG_VERSION, selection, apiId: selectedId, endpointMode,
  } : null;

  return {
    version: MCP_CONFIG_VERSION,
    provenance,
    bundled: { enabled: bundledEnabled, profile },
    native: { enabled: nativeEnabled, selection, apiId: selectedId, endpointMode },
    hab: { available: bundledEnabled && profile === "full" },
    sidecarRequired: bundledEnabled || nativeEnabled,
    selectionMigration: migrateAssist ? "assist_to_home_assistant" : null,
    optionPatch,
    // Startup must persist this even when null: returning to an earlier selection
    // must not resurrect retired legacy fallback behavior.
    compatibility: nextCompatibility,
  };
}
