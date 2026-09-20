#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";

import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { isMainModule } from "../runtime/entrypoint.js";
import { createSpicyMcpFactory, type SpicyMcpFactoryOptions } from "./server.js";

const MAX_MCP_BODY_BYTES = 2 * 1_024 * 1_024;

export interface SpicyMcpHttpOptions extends Omit<SpicyMcpFactoryOptions, "client"> {
  host?: string;
  port?: number;
  token?: string;
}

export interface SpicyMcpHttpHandle {
  server: Server;
  url: string;
  close: () => Promise<void>;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (provided.byteLength !== expected.byteLength) {
    const padded = Buffer.alloc(expected.byteLength);
    provided.copy(padded, 0, 0, expected.byteLength);
    timingSafeEqual(expected, padded);
    return false;
  }
  return timingSafeEqual(expected, provided);
}

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? "8765");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new TypeError("SPICY_MCP_PORT must be an integer between 0 and 65535");
  }
  return parsed;
}

class RequestBodyTooLargeError extends Error {}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    total += chunk.byteLength;
    if (total > MAX_MCP_BODY_BYTES) throw new RequestBodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function startHttpServer(
  options: SpicyMcpHttpOptions = {},
): Promise<SpicyMcpHttpHandle> {
  const host = options.host ?? process.env.SPICY_MCP_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(
      "remote MCP HTTP is disabled: use a standards-compliant OAuth resource server with audience-bound tokens",
    );
  }
  const port = options.port ?? parsePort(process.env.SPICY_MCP_PORT);
  const token = options.token ?? process.env.SPICY_MCP_HTTP_TOKEN;
  if (!token || Buffer.byteLength(token, "utf8") < 32) {
    throw new Error(
      "SPICY_MCP_HTTP_TOKEN must contain at least 32 bytes of random secret material",
    );
  }
  const apiKey = options.clientOptions?.apiKey ?? process.env.SPICY_API_KEY;
  if (apiKey && token === apiKey) {
    throw new Error("SPICY_MCP_HTTP_TOKEN must be separate from SPICY_API_KEY");
  }

  const factory = createSpicyMcpFactory({
    ...options,
    stateSecret: options.stateSecret ?? token,
    principalBinding: options.principalBinding ?? "local-http-token",
  });
  const handler = createMcpHandler(factory, {
    legacy: "stateless",
    responseMode: "auto",
    maxSubscriptions: 128,
    onerror: options.onError ?? ((error) => console.error(error.message)),
  });
  const nodeHandler = toNodeHandler(handler);
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  const server = createServer({
    requestTimeout: 120_000,
    headersTimeout: 15_000,
    keepAliveTimeout: 5_000,
  });
  server.on("request", (request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (pathname === "/healthz" && request.method === "GET") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end('{"ok":true}');
        return;
      }
      if (pathname !== "/mcp") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end('{"error":"not found"}');
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) return;
      if (!authorized(request.headers.authorization, token)) {
        response.writeHead(401, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Bearer realm="spicyapi-mcp"',
        });
        response.end('{"error":"unauthorized"}');
        return;
      }
      const declaredLength = Number(request.headers["content-length"] ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_BODY_BYTES) {
        response.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        response.end('{"error":"request body too large"}');
        return;
      }
      try {
        const body = await readBoundedBody(request);
        await nodeHandler(
          {
            headers: request.headers,
            ...(request.method === undefined ? {} : { method: request.method }),
            ...(request.url === undefined ? {} : { url: request.url }),
            [Symbol.asyncIterator]: () =>
              Readable.from(body.byteLength > 0 ? [body] : [])[Symbol.asyncIterator](),
          },
          response,
        );
      } catch (error) {
        if (!(error instanceof RequestBodyTooLargeError)) throw error;
        request.resume();
        if (!response.headersSent) {
          response.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
        }
        if (!response.writableEnded) response.end('{"error":"request body too large"}');
      }
    })().catch((error: unknown) => {
      (options.onError ?? console.error)(
        error instanceof Error ? error : new Error("MCP HTTP request failed"),
      );
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      if (!response.writableEnded) response.end('{"error":"internal error"}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("MCP HTTP server did not bind a TCP port");
  const displayHost = host === "::1" ? "[::1]" : host;

  return {
    server,
    url: `http://${displayHost}:${address.port}/mcp`,
    close: async () => {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

if (isMainModule(import.meta.url)) {
  const handle = await startHttpServer();
  console.error(`SpicyAPI MCP HTTP listening at ${handle.url}`);
  const close = (): void => {
    void handle.close().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "failed to close MCP HTTP server");
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
