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
