// Real captured model outputs used as parser fixtures.
// Each of these stalled or corrupted a session today; the parser must handle them.

export const NARRATION_NO_TOOLS = `I have most of the picture now. Let me read the remaining core files fully before making changes.`;

export const PAYLOAD_MISSING = `Restoring via heredoc instead:

\`\`\`tooluse
{"id":"t1","name":"Write","input":{"file_path":"README.md","content":"@payload:content"}}
\`\`\``;

// The exact turn that clobbered README.md to 16 bytes: a @payload ref with no raw block.
export const PAYLOAD_REF_ONLY = `{"id":"t1","name":"Write","input":{"file_path":"README.md","content":"@payload:content"}}`;

// Big content correctly moved out of JSON into a raw payload (the happy path).
export const PAYLOAD_OK =
  '```tooluse\n' +
  '{"id":"t1","name":"Write","input":{"file_path":"/tmp/demo.txt","content":"@payload:content"}}\n' +
  '@@TABLM t1 content <<\'EOF\'\n' +
  '# title\n\n' +
  'Line with "quotes" and {braces} - no escaping needed.\n' +
  'A ``` fence inside the payload must not start a new call.\n' +
  '@@TABLM_END t1\n' +
  '```';

// Payload whose raw body contains a ``` fence - the non-greedy regex hazard.
export const PAYLOAD_WITH_INNER_FENCE =
  '```tooluse\n' +
  '{"id":"t1","name":"Write","input":{"file_path":"/tmp/f.md","content":"@payload:content"}}\n' +
  "@@TABLM t1 content <<'EOF'\n" +
  '```js\nconsole.log("hi");\n```\n' +
  '@@TABLM_END t1\n' +
  '```';

// The model gave up on payloads and stuffed a 5KB heredoc into an escaped JSON string.
export const HEREDOC_IN_JSON =
  '```tooluse\n' +
  '{"id":"t1","name":"Bash","input":{"command":"cat > README.md <<\'TABLM_README_EOF\'\\n# tablm\\n\\nUse web AI chats.\\nTABLM_README_EOF\\nwc -l README.md && head -5 README.md"}}\n' +
  '```';

// Truncated mid-payload: END marker never emitted.
export const PAYLOAD_TRUNCATED =
  '```tooluse\n' +
  '{"id":"t1","name":"Write","input":{"file_path":"/tmp/big.txt","content":"@payload:content"}}\n' +
  "@@TABLM t1 content <<'EOF'\n" +
  'line one\nline two\nline three... [cut off here, no end marker';

// Multiple calls in one response.
export const MULTI_CALL =
  '```tooluse\n{"id":"t1","name":"Read","input":{"file_path":"a.txt"}}\n```\n' +
  '```tooluse\n{"id":"t2","name":"Grep","input":{"pattern":"foo","path":"src"}}\n```';

// ChatGPT-style ```json fence.
export const JSON_FENCE_CALL =
  '```json\n{"id":"t1","name":"Bash","input":{"command":"ls"}}\n```';

// Bare JSON, backticks stripped by the web chat.
export const BARE_JSON_CALL = '{"id":"t1","name":"Bash","input":{"command":"pwd"}}';

// Contract v5: the model writes @TBF@ instead of literal ``` inside payloads
// (the web UI's markdown renderer eats literal fences).
export const PAYLOAD_WITH_TBF_TOKEN =
  '```tooluse\n' +
  '{"id":"t1","name":"Write","input":{"file_path":"/tmp/x.md","content":"@payload:content"}}\n' +
  "@@TABLM t1 content <<'EOF'\n" +
  '# Title\n\n' +
  '@TBF@bash\necho hi\n@TBF@\n' +
  '@@TABLM_END t1\n' +
  '```';
