import crypto from "node:crypto";
import type { JsonObject } from "./types.js";
import type { ObsWebSocketConfig } from "./obs-config.js";

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

function sha256Base64(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64");
}

export class ObsWebSocketClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<string, PendingRequest>();
  private nextRequestId = 1;

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static async connect(host: string, config: ObsWebSocketConfig, timeoutMs = 5000): Promise<ObsWebSocketClient> {
    if (!config.server_enabled) throw new Error("OBS WebSocket server is disabled");
    if (config.auth_required && !config.server_password) throw new Error("OBS WebSocket authentication is enabled but no password is configured");

    const socket = new WebSocket(`ws://${host}:${config.server_port}`);
    const client = new ObsWebSocketClient(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out identifying with OBS WebSocket")), timeoutMs);
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };

      socket.onerror = () => fail(new Error(`Could not connect to OBS WebSocket on ${host}:${config.server_port}`));
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { op: number; d: JsonObject };
          if (message.op === 0) {
            const offeredRpcVersion = Number(message.d.rpcVersion);
            if (!Number.isFinite(offeredRpcVersion) || offeredRpcVersion < 1) {
              fail(new Error(`OBS WebSocket does not offer supported RPC version 1 (offered ${String(message.d.rpcVersion)})`));
              socket.close();
              return;
            }
            const identification: JsonObject = { rpcVersion: 1, eventSubscriptions: 0 };
            const authentication = message.d.authentication as JsonObject | undefined;
            if (authentication) {
              const salt = String(authentication.salt);
              const challenge = String(authentication.challenge);
              const secret = sha256Base64(`${config.server_password ?? ""}${salt}`);
              identification.authentication = sha256Base64(`${secret}${challenge}`);
            }
            socket.send(JSON.stringify({ op: 1, d: identification }));
            return;
          }
          if (message.op === 2) {
            const negotiatedRpcVersion = Number(message.d.negotiatedRpcVersion);
            if (negotiatedRpcVersion !== 1) {
              fail(new Error(`OBS WebSocket negotiated unsupported RPC version ${String(message.d.negotiatedRpcVersion)}`));
              socket.close();
              return;
            }
            clearTimeout(timer);
            socket.onerror = () => client.rejectPending(new Error("OBS WebSocket transport error"));
            socket.onclose = () => client.rejectPending(new Error("OBS WebSocket closed before pending requests completed"));
            socket.onmessage = (requestEvent) => client.handleMessage(String(requestEvent.data));
            resolve();
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
    });
    return client;
  }

  async request<T extends JsonObject = JsonObject>(requestType: string, requestData: JsonObject = {}): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("OBS WebSocket is not open");
    const requestId = String(this.nextRequestId++);
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${requestType} timed out`));
      }, 8000);
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500);
      this.socket.addEventListener("close", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.close(1000);
    });
  }

  private handleMessage(raw: string): void {
    let message: { op: number; d: JsonObject };
    try {
      message = JSON.parse(raw) as { op: number; d: JsonObject };
    } catch {
      return;
    }
    if (message.op !== 7) return;
    const requestId = String(message.d.requestId);
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    const status = message.d.requestStatus as JsonObject;
    if (status.result === true) {
      pending.resolve((message.d.responseData as JsonObject | undefined) ?? {});
    } else {
      pending.reject(new Error(`${String(message.d.requestType)} failed (${String(status.code)}): ${String(status.comment ?? "unknown error")}`));
    }
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export async function getOutputActivity(client: ObsWebSocketClient): Promise<JsonObject> {
  const status = async (requestType: string): Promise<JsonObject> => {
    try {
      return await client.request(requestType);
    } catch (error) {
      // OBS reports disabled/unavailable outputs with 604. An unavailable
      // replay buffer or virtual camera is inactive, not an unsafe mutation.
      if (error instanceof Error && /\(604\):/.test(error.message)) return { outputActive: false };
      throw error;
    }
  };
  const [record, stream, replay, virtualCamera] = await Promise.all([
    status("GetRecordStatus"),
    status("GetStreamStatus"),
    status("GetReplayBufferStatus"),
    status("GetVirtualCamStatus"),
  ]);
  return {
    recording: record.outputActive === true,
    streaming: stream.outputActive === true,
    replayBuffer: replay.outputActive === true,
    virtualCamera: virtualCamera.outputActive === true,
  };
}

export async function assertOutputsIdle(client: ObsWebSocketClient): Promise<JsonObject> {
  const activity = await getOutputActivity(client);
  const active = Object.entries(activity).filter(([, value]) => value === true).map(([name]) => name);
  if (active.length > 0) throw new Error(`Refusing profile mutation while outputs are active: ${active.join(", ")}`);
  return activity;
}
