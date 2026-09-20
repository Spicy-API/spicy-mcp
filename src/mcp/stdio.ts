#!/usr/bin/env node

import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import { isMainModule } from "../runtime/entrypoint.js";
import { createSpicyMcpFactory, type SpicyMcpFactoryOptions } from "./server.js";

export function runStdioServer(options: SpicyMcpFactoryOptions = {}): StdioServerHandle {
  return serveStdio(createSpicyMcpFactory(options), {
    legacy: "serve",
    maxSubscriptions: 128,
  });
}

if (isMainModule(import.meta.url)) {
  const handle = runStdioServer({ onError: (error) => console.error(error.message) });
  const close = (): void => {
    void handle.close().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "failed to close MCP stdio server");
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
