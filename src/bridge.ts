import { WebSocketServer, WebSocket } from "ws";

const BRIDGE_PORT = Number(process.env.TABLM_BRIDGE_PORT || 8765);
const BRIDGE_TOKEN =
  process.env.TABLM_BRIDGE_TOKEN || process.env.TABLM_GATEWAY_TOKEN || "";

let client: WebSocket | null = null;
const pending = new Map<
  string,
  { resolve: (m: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();
let seq = 0;

export function startBridge(): void {
  const wss = new WebSocketServer({ port: BRIDGE_PORT }, () => {
    console.log(`tablm bridge (extension) listening on ws://0.0.0.0:${BRIDGE_PORT}`);
  });
  wss.on("connection", (ws) => {
    let authed = false;
    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type !== "hello") {
          ws.close(4002, "expected hello");
          return;
        }
        if (BRIDGE_TOKEN && msg.token !== BRIDGE_TOKEN) {
          console.log("[bridge] extension rejected: bad token");
          ws.close(4001, "bad token");
          return;
        }
        authed = true;
        client = ws;
        ws.send(JSON.stringify({ type: "hello_ack" }));
        console.log(`[bridge] extension connected (browser=${msg.browser ?? "?"})`);
        return;
      }
      if (msg.type === "heartbeat") return;
      if (msg.type === "job_result" || msg.type === "job_error" || msg.type === "job_cancelled") {
        const p = pending.get(msg.job_id);
        if (!p) return;
        pending.delete(msg.job_id);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
    });
    ws.on("close", () => {
      if (client !== ws) return;
      client = null;
      console.log("[bridge] extension disconnected");
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.reject(new Error("extension disconnected mid-job"));
      }
    });
  });
  wss.on("error", (e: any) => {
    console.error(`[bridge] server error: ${e.message}`);
  });
}

export function bridgeConnected(): boolean {
  return client !== null && client.readyState === WebSocket.OPEN;
}

export interface ExtJobResult {
  type: "job_result" | "job_error" | "job_cancelled";
  text: string;
  conversationId: string | null;
  error?: string;
  reason?: string;
  stoppedGeneration?: boolean;
}

export function submitJob(job: {
  site: string;
  operation?: "model.turn" | "site.health";
  prompt?: string;
  conversation?: { mode: string; conversation_id?: string };
  timeoutS?: number;
}): Promise<ExtJobResult> {
  if (!bridgeConnected()) {
    return Promise.reject(
      new Error(
        "extension not connected to the bridge - in the extension popup set the endpoint ws://<gateway-ip>:8765 and the token, then connect"
      )
    );
  }
  const jobId = `tablm-${Date.now()}-${++seq}`;
  const timeoutS = Math.max(10, Math.floor(job.timeoutS ?? 300));
  const msg: any = {
    type: "job",
    job_id: jobId,
    tunnel_id: "chrome-remote",
    site: job.site,
    operation: job.operation ?? "model.turn",
    request_id: jobId,
    generation_epoch: 0,
    stage: job.operation === "site.health" ? "health" : "turn",
    conversation: job.conversation ?? { mode: "fresh" },
    timeout_s: timeoutS,
  };
  if (job.prompt !== undefined) msg.prompt = job.prompt;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(jobId);
      reject(new Error(`extension job timed out after ${timeoutS}s`));
    }, (timeoutS + 15) * 1000);
    pending.set(jobId, {
      resolve: (m: any) =>
        resolve({
          type: m.type,
          text: String(m.text ?? ""),
          conversationId: m.conversation_id ?? null,
          error: m.error,
          reason: m.reason,
          stoppedGeneration: Boolean(m.stopped_generation),
        }),
      reject,
      timer,
    });
    client!.send(JSON.stringify(msg));
  });
}
