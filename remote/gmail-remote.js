import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as http from "node:http";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const API_KEY = process.env.GMAIL_MCP_API_KEY || "";
const GMAIL_MCP_COMMAND = process.env.GMAIL_MCP_COMMAND || "uv";
const GMAIL_MCP_ARGS = (
  process.env.GMAIL_MCP_ARGS ||
  "--directory /opt/gmail-mcp run gmail --creds-file-path /opt/gmail-mcp/secrets/credentials.json --token-path /opt/gmail-mcp/secrets/tokens.json"
)
  .match(/(?:[^\s"]+|"[^"]*")+/g)
  ?.map((arg) => arg.replace(/^"|"$/g, "")) || [];

if (!API_KEY) {
  console.error("GMAIL_MCP_API_KEY is required");
  process.exit(1);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;max-width:720px;width:100%}
  h1{font-size:24px;margin-bottom:12px;color:#1a1a1a}
  p{color:#555;line-height:1.6;margin-bottom:12px}
  code{background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px}
  pre{background:#1a1a2e;color:#e0e0e0;border-radius:8px;padding:16px;font-size:12px;overflow-x:auto;margin-top:12px;line-height:1.5}
</style>
</head><body><div class="card">${body}</div></body></html>`;
}

function extractApiKey(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

async function withGmailClient(callback) {
  const transport = new StdioClientTransport({
    command: GMAIL_MCP_COMMAND,
    args: GMAIL_MCP_ARGS,
  });
  const client = new Client(
    { name: "gmail-mcp-remote-proxy", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  try {
    return await callback(client);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function createMcpServer() {
  const server = new Server(
    { name: "gmail-mcp-remote", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    withGmailClient((client) => client.listTools()),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    withGmailClient((client) => client.callTool(request.params)),
  );

  return server;
}

async function handleMcpRequest(req, res) {
  if (extractApiKey(req) !== API_KEY) {
    sendJson(res, 401, {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Unauthorized. Provide the configured Bearer token.",
      },
      id: null,
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null,
    });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: error instanceof Error ? error.message : "Parse error",
          },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      service: "gmail-mcp-remote",
      mcp: `${BASE_URL}/mcp`,
    });
    return;
  }

  if (url.pathname === "/mcp") {
    await handleMcpRequest(req, res);
    return;
  }

  if (url.pathname === "/") {
    const cursorConfig = JSON.stringify(
      {
        mcpServers: {
          gmail: {
            command: "npx",
            args: [
              "mcp-remote",
              `${BASE_URL}/mcp`,
              "--header",
              "Authorization:${GMAIL_MCP_AUTH}",
            ],
            env: {
              GMAIL_MCP_AUTH: "Bearer <your-api-key>",
            },
          },
        },
      },
      null,
      2,
    );

    sendHtml(
      res,
      200,
      pageShell(
        "Gmail MCP",
        `<h1>Gmail MCP Remote Server</h1>
        <p>This server exposes the Gmail MCP tools over authenticated Streamable HTTP.</p>
        <p>MCP endpoint: <code>${BASE_URL}/mcp</code></p>
        <p>Cursor / Claude Code clients should pass the configured Bearer token as an Authorization header.</p>
        <pre>${cursorConfig}</pre>`,
      ),
    );
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Gmail MCP remote server listening on port ${PORT}`);
  console.log(`MCP:    ${BASE_URL}/mcp`);
  console.log(`Health: ${BASE_URL}/health`);
});

process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  httpServer.close();
  process.exit(0);
});
