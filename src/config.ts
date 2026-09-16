// Central env access. Every TABLM_* variable is read HERE once, validated, and
// exported as a typed field. Nothing else in the codebase should touch
// process.env for tablm config - scattered `Number(process.env.X || d)` calls
// made it impossible to know the full surface or to catch typos.
//
// Rule: add a field here, document it in README's env table, never read the
// raw var elsewhere.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`env ${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const config = {
  // --- gateway wire ---
  gatewayUrl: str("TABLM_GATEWAY_URL", "http://127.0.0.1:8788"),
  gatewayHttp: str("TABLM_GATEWAY_HTTP", "http://127.0.0.1:8788"),
  gatewayPort: num("TABLM_GATEWAY_PORT", 8788),
  gatewayHost: str("TABLM_GATEWAY_HOST", "127.0.0.1"),
  authToken: str("TABLM_AUTH_TOKEN", "tablm"),

  // --- agent loop ---
  maxTurns: num("TABLM_MAX_TURNS", 50),
  maxResultChars: num("TABLM_MAX_RESULT_CHARS", 8000),
  maxCallsPerTurn: num("TABLM_MAX_CALLS_PER_TURN", 6),
  maxRepairs: num("TABLM_MAX_REPAIRS", 3),

  // --- prompts / conversation ---
  maxPromptChars: num("TABLM_MAX_PROMPT_CHARS", 60_000),
  maxSystemChars: num("TABLM_MAX_SYSTEM_CHARS", 2_000),
  maxToolResultChars: num("TABLM_MAX_TOOL_RESULT_CHARS", 8_000),
  maxToolUseInputChars: num("TABLM_MAX_TOOL_USE_INPUT_CHARS", 2_000),
  chatRolloverChars: num("TABLM_CHAT_ROLLOVER_CHARS", 400_000),

  // --- models / sites ---
  defaultModel: str("TABLM_MODEL", "web-zai"),
  defaultSite: str("TABLM_DEFAULT_SITE", "zai"),
  sitesConfigPath: process.env.TABLM_SITES_CONFIG || "",
  chatgptTemporary: bool("TABLM_CHATGPT_TEMPORARY", false),

  // --- tools ---
  toolProfile: str("TABLM_TOOLS", "full").toLowerCase(),

  // --- transport ---
  cdpUrl: str("TABLM_CDP_URL", "http://127.0.0.1:9222"),
  chromeBin: process.env.TABLM_CHROME_BIN || "",
  chromeProfile: process.env.TABLM_CHROME_PROFILE || "",
  noLocalChrome: bool("TABLM_NO_LOCAL_CHROME", false),
  transport: str("TABLM_TRANSPORT", "cdp") as "cdp" | "extension",
  bridgePort: num("TABLM_BRIDGE_PORT", 8765),
  bridgeToken: str(
    "TABLM_BRIDGE_TOKEN",
    str("TABLM_GATEWAY_TOKEN", "")
  ),

  // --- paths ---
  sessionsFile: process.env.TABLM_SESSIONS || "",
} as const;

export type Config = typeof config;
