declare module "ws" {
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  export class WebSocket {
    constructor(url: string, options?: { handshakeTimeout?: number });
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    once(event: "open", listener: () => void): this;
    once(event: "error", listener: (error?: unknown) => void): this;
    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: { toString(): string }) => void): this;
    on(event: "close" | "error", listener: (error?: unknown) => void): this;
  }

  export class WebSocketServer {
    constructor(options: { noServer: true; maxPayload?: number });
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
    close(callback?: (error?: Error) => void): void;
  }
}
