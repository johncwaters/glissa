// Minimal ambient typing for the `express` surface this repo's TypeScript touches. Express 5 ships no
// declarations and @types/express is not a dependency, so this states exactly what is called here: the
// app factory, the three mounts (use/get/post), express.static, and the request/response members the
// routes read. The app doubles as a plain http request listener, which is how the remote listener
// shares it.
declare module "express" {
  import type { IncomingMessage, ServerResponse } from "node:http";
  import type { Socket } from "node:net";

  interface Request extends IncomingMessage {
    readonly params: Record<string, string>;
    readonly query: Record<string, unknown>;
    readonly socket: Socket;
  }

  interface Response extends ServerResponse {
    status(code: number): Response;
    json(body?: unknown): Response;
    type(contentType: string): Response;
    send(body?: unknown): Response;
    redirect(status: number, url: string): void;
  }

  type NextFunction = (error?: unknown) => void;
  type RequestHandler = (request: Request, response: Response, next: NextFunction) => void;

  interface Express {
    (request: IncomingMessage, response: ServerResponse): void;
    use(handler: RequestHandler): Express;
    use(path: string, handler: RequestHandler): Express;
    get(path: string, handler: RequestHandler): Express;
    post(path: string, handler: RequestHandler): Express;
  }

  interface ExpressFactory {
    (): Express;
    static(root: string): RequestHandler;
  }

  const express: ExpressFactory;
  export default express;
  export type { Express, NextFunction, Request, RequestHandler, Response };
}
