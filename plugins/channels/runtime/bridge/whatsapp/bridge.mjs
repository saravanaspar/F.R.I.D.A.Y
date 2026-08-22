#!/usr/bin/env node
/*
 * FRIDAY WhatsApp bridge. Transport design adapted from the MIT-licensed
 * Hermes Agent Baileys bridge: local-only sidecar, durable queue, QR pairing,
 * reconnect, and normalized HTTP ingress/egress. See root LICENSE.
 */
import http from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import qrcode from "qrcode-terminal";
import pino from "pino";
import {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

process.umask(0o077);

function reportOperationalError({ component, operation, error }) {
  const message = String(error instanceof Error ? error.message : error)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/gi, "$1 [REDACTED]")
    .replace(/([?&](?:password|passwd|secret|token|access_token|refresh_token|id_token|session_token|api_key|apikey|client_secret|credential)=)([^&#\s]+)/gi, "$1[REDACTED]")
    .replace(/\b(password|passwd|secret|token|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|credential|client[-_]?secret|private[-_]?key|signing[-_]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 2_048);
  process.stderr.write(`${JSON.stringify({
    type: "friday.operational-error",
    at: new Date().toISOString(),
    component: String(component).slice(0, 128),
    operation: String(operation).slice(0, 256),
    severity: "error",
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: message || "unknown failure",
  })}\n`);
}

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const PORT = Number.parseInt(arg("port", "3301"), 10);
const SESSION_DIR = path.resolve(arg("session", path.join(process.env.HOME || ".", ".friday", "channels", "whatsapp", "default", "session")));
const BRIDGE_SECRET = String(process.env.FRIDAY_WHATSAPP_BRIDGE_SECRET || "");
if (!BRIDGE_SECRET || BRIDGE_SECRET.length < 32) {
  process.stderr.write("FRIDAY WhatsApp bridge requires an ephemeral bridge secret\n");
  process.exit(2);
}
mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });

const logger = pino({ level: "silent" });
const QUEUE_FILE = path.join(SESSION_DIR, "inbound-queue.json");
const MAX_BATCH = 256;
const LONG_POLL_TIMEOUT_MS = 25_000;
const MAX_LONG_POLL_WAITERS = 64;
const waiters = new Set();

class BridgeBusyError extends Error {}

function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("queue is not an array");
    return parsed.filter((item) => item && typeof item === "object" && typeof item.messageId === "string");
  } catch (error) {
    reportOperationalError({ component: "channels.whatsapp-bridge", operation: "load durable inbound queue", error });
    // Never overwrite an unreadable queue. Refuse startup so the supervising host
    // can surface/retry instead of silently discarding user messages.
    throw error;
  }
}

const queue = loadQueue();

function persistQueue() {
  const temporary = `${QUEUE_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(queue)}\n`, { mode: 0o600, flush: true });
  chmodSync(temporary, 0o600);
  renameSync(temporary, QUEUE_FILE);
  chmodSync(QUEUE_FILE, 0o600);
}
let sock;
let connectionState = "starting";
let reconnectTimer;
let reconnectAttempt = 0;
let stopped = false;

function normalizeJid(value) {
  const raw = String(value || "").trim();
  const colon = raw.indexOf(":");
  const at = raw.indexOf("@");
  if (colon > 0 && at > colon) return `${raw.slice(0, colon)}${raw.slice(at)}`;
  return raw;
}

function unwrap(content) {
  let current = content || {};
  for (let i = 0; i < 4; i += 1) {
    const next = current.ephemeralMessage?.message
      || current.viewOnceMessage?.message
      || current.viewOnceMessageV2?.message
      || current.documentWithCaptionMessage?.message;
    if (!next) break;
    current = next;
  }
  return current;
}

function textFrom(content) {
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || "";
}

function attachmentsFrom(content, messageId) {
  const values = [];
  const candidates = [
    ["image", content.imageMessage],
    ["audio", content.audioMessage],
    ["video", content.videoMessage],
    ["document", content.documentMessage],
    ["sticker", content.stickerMessage],
  ];
  for (const [kind, item] of candidates) {
    if (!item) continue;
    values.push({
      kind,
      externalId: `${messageId}:${kind}`,
      ...(item.mimetype ? { mimeType: String(item.mimetype) } : {}),
      ...(item.fileName ? { fileName: String(item.fileName) } : {}),
      ...(Number.isFinite(item.fileLength) ? { sizeBytes: Number(item.fileLength) } : {}),
    });
  }
  return values;
}

function enqueue(event) {
  // Baileys may redeliver around reconnects; messageId is the provider identity.
  if (queue.some((queued) => queued.messageId === event.messageId)) return;
  queue.push(event);
  persistQueue();
  for (const resolve of waiters) resolve();
  waiters.clear();
}

async function connect() {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  let version;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (error) {
    reportOperationalError({ component: "channels.whatsapp-bridge", operation: "fetch recommended protocol version", error });
    version = undefined;
  }

  sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ["FRIDAY", "Chrome", "120.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => ({ conversation: "" }),
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      process.stderr.write("\nScan this QR in WhatsApp -> Linked devices:\n");
      qrcode.generate(qr, { small: true }, (rendered) => process.stderr.write(`${rendered}\n`));
    }
    if (connection === "open") {
      connectionState = "connected";
      reconnectAttempt = 0;
      process.stderr.write("FRIDAY WhatsApp bridge connected\n");
      return;
    }
    if (connection !== "close" || stopped) return;
    const status = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
    if (status === DisconnectReason.loggedOut) {
      connectionState = "logged_out";
      process.stderr.write("FRIDAY WhatsApp bridge logged out; remove the session directory to pair again\n");
      return;
    }
    connectionState = "reconnecting";
    const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(5, reconnectAttempt++)));
    reconnectTimer = setTimeout(() => void connect().catch((error) => {
      reportOperationalError({ component: "channels.whatsapp-bridge", operation: "reconnect", error });
    }), delayMs);
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const message of messages || []) {
      const key = message.key || {};
      if (key.fromMe) continue;
      const chatId = normalizeJid(key.remoteJid);
      if (!chatId || chatId === "status@broadcast" || chatId.endsWith("@newsletter")) continue;
      const senderId = normalizeJid(key.participant || chatId);
      const content = unwrap(message.message);
      if (!content || Object.keys(content).length === 0) continue;
      const body = String(textFrom(content) || "");
      const messageId = String(key.id || `${Date.now()}`);
      const attachments = attachmentsFrom(content, messageId);
      if (!body && attachments.length === 0) continue;
      enqueue({
        messageId,
        chatId,
        senderId,
        senderName: message.pushName ? String(message.pushName) : undefined,
        chatName: chatId,
        isGroup: chatId.endsWith("@g.us"),
        body,
        timestamp: Number(message.messageTimestamp || Math.floor(Date.now() / 1000)),
        quotedMessageId: content.extendedTextMessage?.contextInfo?.stanzaId,
        attachments,
      });
    }
  });
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${BRIDGE_SECRET}`;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function bodyJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function takeMessages() {
  if (queue.length > 0) return queue.slice(0, MAX_BATCH);
  const timeout = LONG_POLL_TIMEOUT_MS;
  if (waiters.size >= MAX_LONG_POLL_WAITERS) {
    throw new BridgeBusyError("too many pending message polls");
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(done);
      resolve();
    }, timeout);
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    waiters.add(done);
  });
  return queue.slice(0, MAX_BATCH);
}

function acknowledgeMessages(messageIds) {
  const accepted = new Set(messageIds.map((value) => String(value || "")).filter(Boolean));
  if (accepted.size === 0) return;
  let write = 0;
  for (let read = 0; read < queue.length; read += 1) {
    if (accepted.has(queue[read]?.messageId)) continue;
    queue[write] = queue[read];
    write += 1;
  }
  if (write === queue.length) return;
  queue.length = write;
  persistQueue();
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true, connectionState });
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      return json(res, 200, await takeMessages());
    }
    if (req.method === "POST" && url.pathname === "/messages/ack") {
      const body = await bodyJson(req);
      if (!Array.isArray(body.messageIds)) return json(res, 400, { error: "messageIds array is required" });
      acknowledgeMessages(body.messageIds);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/send") {
      if (!sock || connectionState !== "connected") return json(res, 503, { error: "whatsapp not connected" });
      const body = await bodyJson(req);
      const chatId = normalizeJid(body.chatId);
      const message = String(body.message || "");
      if (!chatId || !message) return json(res, 400, { error: "chatId and message are required" });
      const sent = await sock.sendMessage(chatId, { text: message });
      return json(res, 200, { messageId: String(sent?.key?.id || "") });
    }
    return json(res, 404, { error: "not found" });
  } catch (error) {
    if (error instanceof BridgeBusyError) {
      return json(res, 429, { error: "too many pending message polls" });
    }
    reportOperationalError({ component: "channels.whatsapp-bridge", operation: "handle local bridge request", error });
    return json(res, 500, { error: "bridge request failed" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`FRIDAY WhatsApp bridge listening on 127.0.0.1:${PORT}\n`);
});

void connect().catch((error) => {
  connectionState = "error";
  reportOperationalError({ component: "channels.whatsapp-bridge", operation: "initial connection", error });
});

async function shutdown() {
  if (stopped) return;
  stopped = true;
  clearTimeout(reconnectTimer);
  try { sock?.end?.(undefined); } catch (error) {
    reportOperationalError({ component: "channels.whatsapp-bridge", operation: "close socket", error });
  }
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
