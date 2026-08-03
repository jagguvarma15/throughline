#!/usr/bin/env node
// stdio entry point: `throughline-mcp`. stdout is the MCP wire; humans get stderr.
// Store resolution mirrors the CLI and control-plane: DATABASE_URL wins, else SQLite.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOps } from "@through-line/core";
import { postgres } from "@through-line/store-postgres";
import { sqlite } from "@through-line/store-sqlite";
import { createThroughlineMcpServer } from "./server";

const store = process.env.DATABASE_URL
  ? postgres(process.env.DATABASE_URL)
  : sqlite(process.env.THROUGHLINE_DB ?? "throughline.db");

const server = createThroughlineMcpServer(createOps(store));
await server.connect(new StdioServerTransport());
console.error("throughline-mcp serving on stdio");
