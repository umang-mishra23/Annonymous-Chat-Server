import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* ====== Config ====== */
const PORT = process.env.PORT || 3000;
const ROOM_CODE_LENGTH = 7; // Base62 length
const PRIVATE_ROOM_MIN_PARTICIPANTS = 2;
const ROOM_GRACE_MS = 20 * 1000; // 20 seconds grace for reconnects
const ROOM_TTL_MS = 5 * 60 * 1000; // 5 minutes inactivity TTL
const PUBLIC_BUFFER_LIMIT = 50; // last N public messages held in RAM for new joiners
const MESSAGE_CHAR_LIMIT = 1000; // per message
const RATE_LIMIT_PER_MINUTE = 120; // messages per minute per user in total

/* ====== Helpers ====== */
function randomRoomCode(len = ROOM_CODE_LENGTH) {
  // Base62 [A-Za-z0-9]
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}
function escapeHtml(s) {
  if (!s) return "";
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

/* ====== In-memory state ====== */
const clients = new Map(); // ws -> { userId, currentRoom: "public" | roomId, rate: {count, windowStart} }
const rooms = new Map(); // roomId -> { id, sockets: Set(ws), participants: Set(userId), messages: [], createdAt, lastActivityAt, graceTimer, ttlTimer }

/* ====== Public room buffer ====== */
const publicBuffer = []; // last PUBLIC_BUFFER_LIMIT messages {id, userId, text, ts}

/* ====== Rate limiting ====== */
function rateAllow(clientMeta) {
  const now = Date.now();
  const window = 60 * 1000;
  if (!clientMeta.rate) clientMeta.rate = { count: 0, start: now };
  if (now - clientMeta.rate.start > window) {
    clientMeta.rate.start = now;
    clientMeta.rate.count = 0;
  }
  clientMeta.rate.count += 1;
  return clientMeta.rate.count <= RATE_LIMIT_PER_MINUTE;
}

/* ====== Room utility functions ====== */
function createRoom() {
  let id;
  do {
    id = randomRoomCode();
  } while (rooms.has(id));
  const r = {
    id,
    sockets: new Set(),
    participants: new Set(),
    messages: [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    graceTimer: null,
    ttlTimer: null
  };
  // start TTL timer
  r.ttlTimer = setTimeout(() => {
    // Double-check inactivity
    const elapsed = Date.now() - r.lastActivityAt;
    if (elapsed >= ROOM_TTL_MS) {
      deleteRoom(id, "ttl_expired");
    } else {
      // reschedule remaining time
      clearTimeout(r.ttlTimer);
      r.ttlTimer = setTimeout(() => deleteRoom(id, "ttl_expired"), ROOM_TTL_MS - (Date.now() - r.lastActivityAt));
    }
  }, ROOM_TTL_MS);
  rooms.set(id, r);
  return r;
}

function scheduleRoomDeletionIfNeeded(room) {
  if (!room) return;
  const count = room.sockets.size;
  if (count >= PRIVATE_ROOM_MIN_PARTICIPANTS) {
    // cancel any pending deletion
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    return;
  }
  // start grace timer
  if (room.graceTimer) return; // already scheduled
  room.graceTimer = setTimeout(() => {
    if (room.sockets.size < PRIVATE_ROOM_MIN_PARTICIPANTS) {
      deleteRoom(room.id, "participant_below_threshold");
    } else {
      // someone rejoined
      room.graceTimer = null;
    }
  }, ROOM_GRACE_MS);
}

function deleteRoom(roomId, reason = "deleted") {
  const room = rooms.get(roomId);
  if (!room) return;
  // Inform any connected sockets
  for (const ws of room.sockets) {
    try {
      ws.send(JSON.stringify({ type: "room_deleted", roomId, reason }));
      // move user back to public automatically
      const meta = clients.get(ws);
      if (meta) {
        meta.currentRoom = "public";
        // No automatic rejoin broadcast to public; the client will rejoin public by protocol if desired.
      }
    } catch (e) { /* ignore */ }
  }
  // clean timers
  if (room.graceTimer) clearTimeout(room.graceTimer);
  if (room.ttlTimer) clearTimeout(room.ttlTimer);
  rooms.delete(roomId);
}

/* ====== Broadcasting helpers ====== */
function sendToSocket(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {}
}

function broadcastPublic(obj) {
  const raw = JSON.stringify(obj);
  for (const [ws, meta] of clients) {
    if (meta.currentRoom === "public" && ws.readyState === ws.OPEN) {
      try { ws.send(raw); } catch (e) {}
    }
  }
}

function broadcastRoom(roomId, obj) {
  const room = rooms.get(roomId);
  if (!room) return;
  const raw = JSON.stringify(obj);
  for (const ws of room.sockets) {
    try { if (ws.readyState === ws.OPEN) ws.send(raw); } catch (e) {}
  }
}

/* ====== WebSocket handling ====== */
wss.on("connection", (ws, req) => {
  const userId = crypto.randomUUID();
  const meta = { userId, connectedAt: Date.now(), currentRoom: "public" };
  clients.set(ws, meta);

  // Assign ID to client
  sendToSocket(ws, { type: "assign_id", userId });

  // Send last public buffer
  sendToSocket(ws, { type: "public_buffer", messages: publicBuffer });

  // Announce join to public (optional)
  broadcastPublic({ type: "user_joined_public", userId });

  ws.on("message", (raw) => {
    let obj;
    try {
      obj = JSON.parse(raw.toString());
    } catch (e) {
      sendToSocket(ws, { type: "error", code: "bad_json", message: "Invalid JSON." });
      return;
    }

    // Rate limiting
    if (!rateAllow(meta)) {
      sendToSocket(ws, { type: "error", code: "rate_limited", message: "Rate limit exceeded." });
      return;
    }

    // Handle types
    if (obj.type === "create_room") {
      // Create private room and put this user into it
      const room = createRoom();
      // add socket
      room.sockets.add(ws);
      room.participants.add(meta.userId);
      meta.currentRoom = room.id;
      room.lastActivityAt = Date.now();
      sendToSocket(ws, { type: "room_created", roomId: room.id });
      // no broadcast until another joins
    } else if (obj.type === "join_room") {
      const roomId = String(obj.roomId || "").trim();
      if (!roomId) {
        sendToSocket(ws, { type: "error", code: "no_room", message: "No roomId provided." });
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        sendToSocket(ws, { type: "error", code: "no_room", message: "Room not found or expired." });
        return;
      }
      // join: remove socket from previous room if private
      if (meta.currentRoom && meta.currentRoom !== "public") {
        const prev = rooms.get(meta.currentRoom);
        if (prev) {
          prev.sockets.delete(ws);
          prev.participants.delete(meta.userId);
          scheduleRoomDeletionIfNeeded(prev);
        }
      }
      // add
      room.sockets.add(ws);
      room.participants.add(meta.userId);
      meta.currentRoom = room.id;
      room.lastActivityAt = Date.now();
      // cancel deletion if any
      if (room.graceTimer) {
        clearTimeout(room.graceTimer);
        room.graceTimer = null;
      }
      // send join ack with participant count and last few messages (private)
      sendToSocket(ws, { type: "joined", roomId: room.id, participants: Array.from(room.participants), messages: room.messages.slice(-50) });
      // notify other participant(s)
      broadcastRoom(room.id, { type: "user_joined_room", roomId: room.id, userId: meta.userId });
    } else if (obj.type === "leave_room") {
      // leave current private room, go back to public
      if (meta.currentRoom && meta.currentRoom !== "public") {
        const prev = rooms.get(meta.currentRoom);
        if (prev) {
          prev.sockets.delete(ws);
          prev.participants.delete(meta.userId);
          scheduleRoomDeletionIfNeeded(prev);
        }
      }
      meta.currentRoom = "public";
      sendToSocket(ws, { type: "left_room" });
      // Optionally inform public that user rejoined
      broadcastPublic({ type: "user_joined_public", userId: meta.userId });
    } else if (obj.type === "message") {
      const textRaw = String(obj.text || "");
      if (!textRaw.trim()) return;
      if (textRaw.length > MESSAGE_CHAR_LIMIT) {
        sendToSocket(ws, { type: "error", code: "too_long", message: `Message longer than ${MESSAGE_CHAR_LIMIT} chars.` });
        return;
      }
      const text = escapeHtml(textRaw).slice(0, MESSAGE_CHAR_LIMIT);
      const msg = { id: crypto.randomUUID(), userId: meta.userId, text, ts: Date.now() };

      if (meta.currentRoom === "public" || !meta.currentRoom) {
        // public message
        publicBuffer.push(msg);
        if (publicBuffer.length > PUBLIC_BUFFER_LIMIT) publicBuffer.shift();
        broadcastPublic({ type: "message", scope: "public", message: msg });
      } else {
        // private room message
        const room = rooms.get(meta.currentRoom);
        if (!room) {
          // room expired -> tell client
          meta.currentRoom = "public";
          sendToSocket(ws, { type: "error", code: "room_gone", message: "Room no longer exists." });
          return;
        }
        // store in room messages (in-memory only)
        room.messages.push(msg);
        room.lastActivityAt = Date.now();
        // keep room TTL updated
        if (room.ttlTimer) {
          clearTimeout(room.ttlTimer);
          room.ttlTimer = setTimeout(() => {
            const elapsed = Date.now() - room.lastActivityAt;
            if (elapsed >= ROOM_TTL_MS) deleteRoom(room.id, "ttl_expired");
            else {
              clearTimeout(room.ttlTimer);
              room.ttlTimer = setTimeout(() => deleteRoom(room.id, "ttl_expired"), ROOM_TTL_MS - (Date.now() - room.lastActivityAt));
            }
          }, ROOM_TTL_MS);
        }
        broadcastRoom(room.id, { type: "message", scope: "room", roomId: room.id, message: msg });
      }
    } else if (obj.type === "ping") {
      sendToSocket(ws, { type: "pong" });
    } else {
      sendToSocket(ws, { type: "error", code: "unknown", message: "Unknown message type." });
    }
  });

  ws.on("close", () => {
    // remove from clients & any room
    const meta = clients.get(ws);
    if (!meta) return;
    // If in private room, remove from it and schedule deletion
    if (meta.currentRoom && meta.currentRoom !== "public") {
      const room = rooms.get(meta.currentRoom);
      if (room) {
        room.sockets.delete(ws);
        room.participants.delete(meta.userId);
        // notify remaining
        broadcastRoom(room.id, { type: "user_left_room", roomId: room.id, userId: meta.userId });
        scheduleRoomDeletionIfNeeded(room);
      }
    } else {
      // public disconnect
      broadcastPublic({ type: "user_left_public", userId: meta.userId });
    }
    clients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("ws error:", err);
  });
});

/* ====== Start server ====== */
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
