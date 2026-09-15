// Tool registry. Each tool may declare validate(): a last line of defense that
// runs BEFORE the tool executes. This is the second fail-closed layer - even if
// the gateway somehow passed through an unresolved "@payload:KEY" marker, the
// tool refuses to run and the file is never clobbered.

export interface ToolContext {
  cwd: string;
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  /** returns an error message to refuse execution, or null to allow */
  validate?: (input: any) => string | null;
  run: (input: any, ctx: ToolContext) => Promise<string>;
}

/** Reject any string argument that still contains an unresolved payload marker. */
export function rejectUnresolvedPayloads(input: any): string | null {
  const check = (v: unknown): boolean => {
    if (typeof v === "string") return /^@payload:[A-Za-z0-9_]+$/.test(v.trim());
    if (Array.isArray(v)) return v.some(check);
    if (v && typeof v === "object") return Object.values(v).some(check);
    return false;
  };
  if (check(input)) {
    return "refused: argument contains an unresolved @payload: marker - the raw @@TABLM block was never emitted. Re-emit the call with its payload block.";
  }
  return null;
}

/**
 * Enforce a tool's validate() INSIDE its run(), so the check cannot be skipped
 * by any caller. The old design had validate() as a separate hook the loop had
 * to remember to call - a direct run() call bypassed it and the file got
 * clobbered with the literal 16-char placeholder.
 */
export function guarded(tool: Tool): Tool {
  const validate = tool.validate;
  return {
    ...tool,
    run: async (input, ctx) => {
      if (validate) {
        const refusal = validate(input);
        if (refusal) return `[error] ${refusal}`;
      }
      return tool.run(input, ctx);
    },
  };
}
