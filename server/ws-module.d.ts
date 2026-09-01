declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { AddressInfo } from "node:net";
  import type { IncomingMessage, Server as HttpServer } from "node:http";
  import type { Duplex } from "node:stream";

  type WebSocketError = Error & { code?: string };

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: number;
    readonly bufferedAmount: number;
    constructor(address: string, options?: { origin?: string; headers?: Record<string, string> });
    send(data: string | Buffer): void;
    ping(data?: string | Buffer): void;
    pong(data?: string | Buffer): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "open", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: WebSocketError) => void): this;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: "pong", listener: (data: Buffer) => void): this;

    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  class WebSocketServer extends EventEmitter {
    readonly clients: Set<WebSocket>;
    constructor(options: {
      host?: string;
      port?: number;
      server?: HttpServer;
      noServer?: boolean;
      path?: string;
      maxPayload?: number;
    });
    address(): AddressInfo | string;
    close(callback?: (error?: Error) => void): void;
    handleUpgrade(
      request: IncomingMessage,
      socket: Duplex,
      head: Buffer,
      callback: (client: WebSocket, request: IncomingMessage) => void,
    ): void;
    on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
    on(event: "listening", listener: () => void): this;
    on(event: "error", listener: (error: WebSocketError) => void): this;
  }

  export default WebSocket;
  export { WebSocket, WebSocketServer };
  export type { WebSocketError };
}
