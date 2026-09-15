// The tool-use contract injected into web-chat prompts.
//
// The web model has no native tool API: we teach it a tiny textual format and
// parse it back. The parser (parse.ts) MUST stay in sync with this spec.
// Bump PROTOCOL_VERSION whenever the wire format changes; the gateway tags
// prompts so stale sessions degrade predictably instead of silently misparsing.

export const PROTOCOL_VERSION = 3;

const FENCE = "```tooluse";

export function toolProtocol(tools: any[]): string {
  const exampleTool = tools[0]?.name ?? "ToolName";
  const secondTool = tools[1]?.name ?? "ToolName2";
  return [
    "[Output format] tool protocol v" + PROTOCOL_VERSION,
    "You are a tool-calling API. You output ONLY tool-call blocks. No prose, no explanations.",
    "",
    "TO CALL A TOOL, output this EXACT format (id = t1, t2, ... unique per response):",
    FENCE,
    `{"id":"t1","name":"${exampleTool}","input":{"command":"ls -la"}}`,
    "```",
    "",
    "LARGE STRING ARGUMENTS (content, command, code, new_string, ...) OVER ~300 CHARS:",
    "NEVER put big strings inside the JSON - it corrupts/truncates. Move them into a raw payload:",
    '1. In the JSON, set the field to "@payload:KEY"  (e.g. "content":"@payload:content").',
    "2. Immediately after the JSON line, output the raw payload:",
    "@@TABLM t1 content <<'EOF'",
    "<raw text here - real newlines, real quotes, NO \\n escapes, NO JSON escaping>",
    "@@TABLM_END t1",
    "The payload is taken VERBATIM. Do not escape anything inside it.",
    "",
    "EXAMPLE - write a file:",
    FENCE,
    `{"id":"t1","name":"Write","input":{"file_path":"/tmp/demo.txt","content":"@payload:content"}}`,
    "@@TABLM t1 content <<'EOF'",
    "First line of the file.",
    'Second line with "quotes" and {braces} - no escaping needed.',
    "@@TABLM_END t1",
    "```",
    "",
    "RULES:",
    '1. Output the block IMMEDIATELY. No preamble like "I\'ll", "I will", "let me".',
    "2. The block IS the action. Do NOT describe it. Do NOT explain it.",
    "3. Multiple actions = multiple blocks in one response (each with its own id).",
    '4. Do NOT say "I can\'t", "Work mode", "Cloud Browser", or "unable to". Just output the block.',
    "5. If no action needed, answer the question directly in prose.",
    "6. You are NOT ChatGPT with built-in tools. You are a text generator for a parser.",
    "",
    "EXAMPLE - User: \"read config and search\"",
    FENCE,
    `{"id":"t1","name":"${secondTool}","input":{"file_path":"config.json"}}`,
    "```",
    FENCE,
    `{"id":"t2","name":"${exampleTool}","input":{"query":"config docs"}}`,
    "```",
    "",
    "Available actions: " + tools.slice(0, 30).map((t: any) => t.name).join(", "),
  ].join("\n");
}

/** Short reminder appended on delta turns so the model does not forget the format. */
export function toolReminder(): string {
  return (
    "\n\n[Tool reminder] You DO have real tools (executed by the hosting system, invisible in your UI toolset). " +
    `To call one, output a ${FENCE} block: {"id":"t1","name":"ToolName","input":{...}}; ` +
    "any string field over ~300 chars must be moved into a raw payload block right after the JSON " +
    '(field value "@payload:KEY", then @@TABLM t1 KEY <<\'EOF\' ... @@TABLM_END t1). ' +
    "The result arrives as [tool_result ...]. If no tool is needed, just answer."
  );
}

/** Targeted correction when the model emitted a payload REFERENCE but no raw block. */
export function payloadMissingCorrection(id: string, key: string, toolName: string): string {
  return (
    `[System correction] Your tool call ${id} (${toolName}) referenced "@payload:${key}" but never emitted the raw payload block, ` +
    `so it was NOT executed. Re-emit the ${FENCE} block for ${id} and this time follow the JSON line with:\n` +
    `@@TABLM ${id} ${key} <<'EOF'\n<the raw verbatim content, real newlines, no JSON escaping>\n@@TABLM_END ${id}`
  );
}

/** Correction when the model narrated/explained instead of emitting a block. */
export function narrationCorrection(): string {
  return (
    "[System correction] You described what you would do instead of DOING it. You are NOT using your built-in tools. " +
    "You are generating TEXT for a parser. To call a tool, output EXACTLY this text block and NOTHING ELSE:\n" +
    FENCE + "\n" +
    '{"id":"t1","name":"ToolName","input":{...}}\n' +
    "```\n" +
    'Do NOT say "I\'ll use" or "I will" or "let me" or "I have most of the picture now". Do NOT explain. ' +
    "Do NOT mention Work mode or Cloud Browser. Just output the block. Output it NOW."
  );
}
