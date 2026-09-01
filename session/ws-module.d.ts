// Minimal ambient typing for the `ws` surface this repo's TypeScript touches. The package ships no
// declarations and @types/ws is not a dependency, so this states exactly what is called here, in the
// shape ws/wrapper.mjs exports it (a default WebSocket plus named classes).
declare module "ws" {
  import type { EventEmitter } from "node:events";
  import type { AddressInfo } from "node:net";
  import type { Server as HttpServer } from "node:http";

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    readonly readyState: number;
    constructor(address: string);
    send(data: string | Buffer): void;
    close(code?: number, reason?: string): void;
    on(event: "open", listener: () => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
  }

  class WebSocketServer extends EventEmitter {
    readonly clients: Set<WebSocket>;
    constructor(options: { host?: string; port?: number; server?: HttpServer; noServer?: boolean; path?: string });
    address(): AddressInfo | string;
    close(callback?: (error?: Error) => void): void;
    on(event: "connection", listener: (socket: WebSocket) => void): this;
    on(event: "listening", listener: () => void): this;
    on(event: "error", listener: (error: Error) => void): this;
  }

  export default WebSocket;
  export { WebSocket, WebSocketServer };
}
