import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const LEGACY_API_KEY = process.env.GMAIL_MCP_API_KEY || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";
const CREDENTIALS_PATH =
  process.env.GOOGLE_CREDENTIALS_PATH ||
  "/opt/gmail-mcp/secrets/credentials.json";
const USERS_FILE =
  process.env.GMAIL_MCP_USERS_FILE ||
  "/opt/gmail-mcp/secrets/users.json";
const CLIENTS_FILE =
  process.env.GMAIL_MCP_CLIENTS_FILE ||
  "/opt/gmail-mcp/secrets/oauth-clients.json";
const USER_TOKENS_DIR =
  process.env.GMAIL_MCP_USER_TOKENS_DIR ||
  "/opt/gmail-mcp/secrets/users";
const LEGACY_TOKEN_PATH =
  process.env.GMAIL_MCP_LEGACY_TOKEN_PATH ||
  "/opt/gmail-mcp/secrets/tokens.json";
const GMAIL_MCP_COMMAND = process.env.GMAIL_MCP_COMMAND || "uv";
const GMAIL_MCP_ARGS_TEMPLATE =
  process.env.GMAIL_MCP_ARGS_TEMPLATE ||
  "--directory /opt/gmail-mcp run gmail --creds-file-path /opt/gmail-mcp/secrets/credentials.json --token-path {{TOKEN_PATH}}";
const SCOPES = (process.env.GOOGLE_OAUTH_SCOPES ||
  "https://www.googleapis.com/auth/gmail.modify")
  .split(/[,\s]+/)
  .filter(Boolean);
const MCP_SCOPES = ["gmail"];
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const pendingStates = new Map();
const pendingAuthorizationCodes = new Map();

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pageShell(title, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:40px;max-width:760px;width:100%}
  h1{font-size:24px;margin-bottom:12px;color:#1a1a1a}
  h2{font-size:18px;margin-bottom:12px;color:#16a34a}
  p{color:#555;line-height:1.6;margin-bottom:12px}
  a.btn{display:inline-block;background:#2563eb;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600;margin-top:8px}
  code{background:#f0f2f5;padding:2px 6px;border-radius:4px;font-size:13px}
  pre{background:#1a1a2e;color:#e0e0e0;border-radius:8px;padding:16px;font-size:12px;overflow-x:auto;margin:12px 0;line-height:1.5}
  .label{font-size:13px;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-top:20px}
  .value{background:#f5f7fa;border:1px solid #e2e6ea;border-radius:8px;padding:12px 16px;font-family:'SF Mono',monospace;font-size:13px;word-break:break-all;margin-bottom:16px;color:#1a1a1a}
  .warn{color:#92400e;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;padding:12px;margin-bottom:16px}
</style>
</head><body><div class="card">${body}</div></body></html>`;
}

function parseArgs(value) {
  return (
    value
      .match(/(?:[^\s"]+|"[^"]*")+/g)
      ?.map((arg) => arg.replace(/^"|"$/g, "")) || []
  );
}

function argsForTokenPath(tokenPath) {
  return parseArgs(GMAIL_MCP_ARGS_TEMPLATE.replaceAll("{{TOKEN_PATH}}", tokenPath));
}

function ensureStores() {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true, mode: 0o700 });
  fs.mkdirSync(USER_TOKENS_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(USERS_FILE)) {
    saveUsers({ users: {} });
  }
  if (!fs.existsSync(CLIENTS_FILE)) {
    saveClients({ clients: {} });
  }
}

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return { users: {} };
  }
}

function saveUsers(store) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function loadClients() {
  try {
    return JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf8"));
  } catch {
    return { clients: {} };
  }
}

function saveClients(store) {
  fs.writeFileSync(CLIENTS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function findClient(clientId) {
  return loadClients().clients[clientId] || null;
}

function upsertClient(client) {
  const store = loadClients();
  store.clients[client.client_id] = client;
  saveClients(store);
  return client;
}

function loadGoogleClient() {
  const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const config = raw.web || raw.installed;
  if (!config?.client_id || !config?.client_secret) {
    throw new Error("Google OAuth credentials must include client_id and client_secret");
  }
  return {
    type: raw.web ? "web" : "installed",
    clientId: config.client_id,
    clientSecret: config.client_secret,
  };
}

function userTokenPath(apiKey) {
  const digest = crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 24);
  return path.join(USER_TOKENS_DIR, `${digest}.json`);
}

function findUserByKey(apiKey) {
  const store = loadUsers();
  if (store.users[apiKey]) return store.users[apiKey];

  if (LEGACY_API_KEY && apiKey === LEGACY_API_KEY && fs.existsSync(LEGACY_TOKEN_PATH)) {
    return {
      mcp_api_key: LEGACY_API_KEY,
      email: "legacy-user",
      token_path: LEGACY_TOKEN_PATH,
      legacy: true,
    };
  }

  return null;
}

function upsertUser(user) {
  const store = loadUsers();
  for (const [key, stored] of Object.entries(store.users)) {
    if (stored.email === user.email && key !== user.mcp_api_key) {
      delete store.users[key];
    }
  }
  store.users[user.mcp_api_key] = user;
  saveUsers(store);
}

function extractApiKey(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}

function oauthProtectedResourceMetadata() {
  return {
    resource: `${BASE_URL}/mcp`,
    authorization_servers: [BASE_URL],
    scopes_supported: MCP_SCOPES,
    bearer_methods_supported: ["header"],
  };
}

function oauthAuthorizationServerMetadata() {
  return {
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: MCP_SCOPES,
  };
}

function verifyPkce(codeVerifier, codeChallenge) {
  const digest = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  if (digest.length !== codeChallenge.length) return false;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(codeChallenge));
}

function appendParams(uri, params) {
  const redirect = new URL(uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      redirect.searchParams.set(key, value);
    }
  }
  return redirect.toString();
}

function redirectOAuthError(res, redirectUri, state, error, description) {
  res.writeHead(302, {
    Location: appendParams(redirectUri, {
      error,
      error_description: description,
      state,
    }),
  });
  res.end();
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        if (req.headers["content-type"]?.includes("application/json")) {
          resolve(JSON.parse(raw));
        } else {
          resolve(Object.fromEntries(new URLSearchParams(raw)));
        }
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function exchangeCodeForToken(code) {
  const google = loadGoogleClient();
  const body = new URLSearchParams({
    code,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Google token exchange failed");
  }
  return { google, token: data };
}

async function fetchGmailProfile(accessToken) {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || "Failed to read Gmail profile");
  }
  return data;
}

function writeAuthorizedUserToken({ google, token, apiKey, existingTokenPath }) {
  const tokenPath = existingTokenPath || userTokenPath(apiKey);
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  } catch {
    previous = {};
  }

  const refreshToken = token.refresh_token || previous.refresh_token;
  if (!refreshToken) {
    throw new Error("Google did not return a refresh token. Reconnect with consent prompt.");
  }

  const authorizedUser = {
    token: token.access_token,
    refresh_token: refreshToken,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: google.clientId,
    client_secret: google.clientSecret,
    scopes: SCOPES,
    expiry: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(),
  };

  fs.writeFileSync(tokenPath, JSON.stringify(authorizedUser, null, 2), { mode: 0o600 });
  return tokenPath;
}

async function withGmailClient(user, callback) {
  const transport = new StdioClientTransport({
    command: GMAIL_MCP_COMMAND,
    args: argsForTokenPath(user.token_path),
  });
  const client = new Client(
    { name: "gmail-mcp-remote-proxy", version: "0.2.0" },
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

function createMcpServer(user) {
  const server = new Server(
    { name: "gmail-mcp-remote", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    withGmailClient(user, (client) => client.listTools()),
  );

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    withGmailClient(user, (client) => client.callTool(request.params)),
  );

  return server;
}

async function handleMcpRequest(req, res) {
  const apiKey = extractApiKey(req);
  const user = apiKey ? findUserByKey(apiKey) : null;

  if (!user) {
    sendJson(res, 401, {
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: `Unauthorized. Visit ${BASE_URL}/auth to connect Gmail.`,
      },
      id: null,
    }, {
      "WWW-Authenticate": `Bearer resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
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
    const server = createMcpServer(user);
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

function renderClientConfig(apiKey) {
  return JSON.stringify(
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
            GMAIL_MCP_AUTH: `Bearer ${apiKey}`,
          },
        },
      },
    },
    null,
    2,
  );
}

async function handleClientRegistration(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const body = await parseRequestBody(req);
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  if (redirectUris.length === 0) {
    sendJson(res, 400, { error: "invalid_client_metadata", error_description: "redirect_uris is required" });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const client = upsertClient({
    client_id: `client-${crypto.randomBytes(24).toString("hex")}`,
    client_name: body.client_name || "Claude MCP Client",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    created_at: Date.now(),
  });

  sendJson(res, 201, {
    client_id: client.client_id,
    client_id_issued_at: now,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
  });
}

async function handleAuthorize(url, res) {
  const responseType = url.searchParams.get("response_type");
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const state = url.searchParams.get("state");
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");
  const scope = url.searchParams.get("scope") || MCP_SCOPES.join(" ");

  if (responseType !== "code") {
    sendHtml(res, 400, pageShell("Invalid Request", "<h1>Invalid Request</h1><p>Only response_type=code is supported.</p>"));
    return;
  }

  const client = clientId ? findClient(clientId) : null;
  if (!client || !redirectUri || !client.redirect_uris.includes(redirectUri)) {
    sendHtml(res, 400, pageShell("Invalid Client", "<h1>Invalid Client</h1><p>The OAuth client is not registered for this redirect URI.</p>"));
    return;
  }

  if (!codeChallenge || codeChallengeMethod !== "S256") {
    redirectOAuthError(res, redirectUri, state, "invalid_request", "PKCE S256 is required");
    return;
  }

  const googleState = crypto.randomBytes(20).toString("hex");
  pendingStates.set(googleState, {
    createdAt: Date.now(),
    mode: "oauth",
    clientId,
    redirectUri,
    clientState: state,
    codeChallenge,
    scope,
  });

  await startGoogleAuth(res, googleState);
}

async function handleToken(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  const body = await parseRequestBody(req);
  if (body.grant_type !== "authorization_code") {
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  const authorization = pendingAuthorizationCodes.get(body.code);
  pendingAuthorizationCodes.delete(body.code);
  if (!authorization || Date.now() - authorization.createdAt > 5 * 60 * 1000) {
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }
  if (authorization.clientId !== body.client_id || authorization.redirectUri !== body.redirect_uri) {
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }
  if (!body.code_verifier || !verifyPkce(body.code_verifier, authorization.codeChallenge)) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "Invalid PKCE verifier" });
    return;
  }

  sendJson(res, 200, {
    access_token: authorization.apiKey,
    token_type: "Bearer",
    expires_in: 2592000,
    scope: authorization.scope || MCP_SCOPES.join(" "),
  }, {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  });
}

async function startGoogleAuth(res, state) {
  const google = loadGoogleClient();
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
  });
  res.end();
}

async function startAuth(res) {
  const state = crypto.randomBytes(20).toString("hex");
  pendingStates.set(state, { createdAt: Date.now(), mode: "manual" });
  await startGoogleAuth(res, state);
}

async function handleAuthCallback(url, res) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const pending = state ? pendingStates.get(state) : null;
  if (!pending) {
    sendHtml(res, 400, pageShell("Invalid State", "<h1>Invalid State</h1><p>Session expired. <a href='/auth'>Try again</a>.</p>"));
    return;
  }
  pendingStates.delete(state);
  if (!code) {
    sendHtml(res, 400, pageShell("Missing Code", "<h1>No Authorization Code</h1><p>Google did not return a code. <a href='/auth'>Try again</a>.</p>"));
    return;
  }

  const { google, token } = await exchangeCodeForToken(code);
  const profile = await fetchGmailProfile(token.access_token);
  const email = profile.emailAddress;
  const existing = Object.values(loadUsers().users).find((user) => user.email === email);
  const apiKey = existing?.mcp_api_key || `sk-gmail-mcp-${crypto.randomBytes(24).toString("hex")}`;
  const tokenPath = writeAuthorizedUserToken({
    google,
    token,
    apiKey,
    existingTokenPath: existing?.token_path,
  });

  const user = {
    mcp_api_key: apiKey,
    email,
    token_path: tokenPath,
    created_at: existing?.created_at || Date.now(),
    updated_at: Date.now(),
  };
  upsertUser(user);

  if (pending.mode === "oauth") {
    const authorizationCode = crypto.randomBytes(32).toString("hex");
    pendingAuthorizationCodes.set(authorizationCode, {
      createdAt: Date.now(),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scope: pending.scope,
      apiKey,
    });
    res.writeHead(302, {
      Location: appendParams(pending.redirectUri, {
        code: authorizationCode,
        state: pending.clientState,
      }),
    });
    res.end();
    return;
  }

  sendHtml(
    res,
    200,
    pageShell(
      "Connected",
      `<h2>Connected to Gmail</h2>
      <p>Authenticated as <strong>${escapeHtml(email)}</strong>.</p>
      <p class="label">MCP Endpoint</p>
      <div class="value">${escapeHtml(`${BASE_URL}/mcp`)}</div>
      <p class="label">Your MCP API Key</p>
      <div class="value">${escapeHtml(apiKey)}</div>
      <p>Add this to a local MCP client that supports headers:</p>
      <pre>${escapeHtml(renderClientConfig(apiKey))}</pre>
      <p class="warn">Keep this API key private. Anyone with the key can use the Gmail MCP tools as this Gmail account.</p>`,
    ),
  );
}

setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingStates) {
    if (now - data.createdAt > 10 * 60 * 1000) pendingStates.delete(state);
  }
  for (const [code, data] of pendingAuthorizationCodes) {
    if (now - data.createdAt > 5 * 60 * 1000) pendingAuthorizationCodes.delete(code);
  }
}, 10 * 60 * 1000);

ensureStores();

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    if (
      url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === "/.well-known/oauth-protected-resource/mcp"
    ) {
      sendJson(res, 200, oauthProtectedResourceMetadata(), {
        "Cache-Control": "public, max-age=300",
      });
      return;
    }

    if (
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server/mcp"
    ) {
      sendJson(res, 200, oauthAuthorizationServerMetadata(), {
        "Cache-Control": "public, max-age=300",
      });
      return;
    }

    if (url.pathname === "/health") {
      const users = loadUsers();
      sendJson(res, 200, {
        status: "ok",
        service: "gmail-mcp-remote",
        mcp: `${BASE_URL}/mcp`,
        auth: `${BASE_URL}/auth`,
        authorization_server: BASE_URL,
        user_count: Object.keys(users.users).length,
        legacy_enabled: Boolean(LEGACY_API_KEY && fs.existsSync(LEGACY_TOKEN_PATH)),
      });
      return;
    }

    if (url.pathname === "/register") {
      await handleClientRegistration(req, res);
      return;
    }

    if (url.pathname === "/authorize" && req.method === "GET") {
      await handleAuthorize(url, res);
      return;
    }

    if (url.pathname === "/token") {
      await handleToken(req, res);
      return;
    }

    if (url.pathname === "/auth" && req.method === "GET") {
      await startAuth(res);
      return;
    }

    if (url.pathname === "/auth/callback" && req.method === "GET") {
      await handleAuthCallback(url, res);
      return;
    }

    if (url.pathname === "/admin/users" && req.method === "GET") {
      if (!ADMIN_API_KEY || extractApiKey(req) !== ADMIN_API_KEY) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const users = Object.values(loadUsers().users).map((user) => ({
        email: user.email,
        created_at: user.created_at,
        updated_at: user.updated_at,
      }));
      sendJson(res, 200, { users });
      return;
    }

    if (url.pathname === "/mcp") {
      await handleMcpRequest(req, res);
      return;
    }

    if (url.pathname === "/") {
      let credentialWarning = "";
      try {
        const google = loadGoogleClient();
        if (google.type !== "web") {
          credentialWarning = `<p class="warn">This server currently uses a Google OAuth <strong>${escapeHtml(google.type)}</strong> client. For team onboarding, use a Web OAuth client and add <code>${escapeHtml(REDIRECT_URI)}</code> as an authorized redirect URI.</p>`;
        }
      } catch (error) {
        credentialWarning = `<p class="warn">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
      }

      sendHtml(
        res,
        200,
        pageShell(
          "Gmail MCP",
          `<h1>Gmail MCP Remote Server</h1>
          ${credentialWarning}
          <p>Each team member can connect their own Gmail account and receive a personal MCP API key.</p>
          <p>MCP endpoint: <code>${escapeHtml(`${BASE_URL}/mcp`)}</code></p>
          <a class="btn" href="/auth">Connect Gmail</a>`,
        ),
      );
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendHtml(
      res,
      500,
      pageShell("Error", `<h1>Something went wrong</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`),
    );
  }
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Gmail MCP remote server listening on port ${PORT}`);
  console.log(`Auth:   ${BASE_URL}/auth`);
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
