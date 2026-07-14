"use strict";

const fs = require("fs");
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const VALID_HEROES = new Set(["bolt", "tank", "ghost", "magnet"]);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INDEX_FILE = path.resolve(__dirname, "index.html");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 300_000,
  pingInterval: 20_000,
  pingTimeout: 15_000,
  transports: ["websocket", "polling"]
});

const rooms = new Map();
const matchmakingQueue = new Map();

app.disable("x-powered-by");
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    rooms: rooms.size,
    waitingPlayers: matchmakingQueue.size,
    time: new Date().toISOString()
  });
});

function sendGame(_req, res) {
  if (fs.existsSync(INDEX_FILE)) {
    res.sendFile(INDEX_FILE);
    return;
  }
  res.status(500).type("html").send(`<!doctype html><html lang="fi"><meta charset="utf-8"><title>Tiedosto puuttuu</title><style>body{font-family:system-ui;background:#111827;color:white;padding:40px}code{background:#263244;padding:4px 8px;border-radius:6px}</style><h1>index.html puuttuu</h1><p>Lataa <code>index.html</code> samaan GitHub-kansioon kuin <code>server.js</code>.</p></html>`);
}
app.get("/", sendGame);
app.get("*", sendGame);

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function cleanName(value) {
  const name = String(value || "Pelaaja")
    .replace(/[<>\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 16);
  return name || "Pelaaja";
}

function cleanConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  return {
    name: cleanName(config.name),
    hero: VALID_HEROES.has(config.hero) ? config.hero : "bolt",
    level: Math.floor(clampNumber(config.level, 1, 99, 1)),
    rating: Math.floor(clampNumber(config.rating, 0, 9999, 500))
  };
}

function cleanCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, 6);
}

function createUniqueCode() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Huonekoodia ei voitu luoda");
}

function safeAck(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function removeSocketFromQueue(socket, notify = false) {
  if (!socket || !matchmakingQueue.has(socket.id)) return;
  matchmakingQueue.delete(socket.id);
  socket.data.inMatchmaking = false;
  if (notify && socket.connected) socket.emit("matchmakingCancelled");
}

function removeSocketFromCurrentRoom(socket, notify = true) {
  removeSocketFromQueue(socket, false);

  const code = socket.data.roomCode;
  if (!code) return;

  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  socket.data.role = null;

  if (!room) return;

  const wasHost = room.hostId === socket.id;
  const wasGuest = room.guestId === socket.id;
  if (wasHost) room.hostId = null;
  if (wasGuest) room.guestId = null;

  const otherId = wasHost ? room.guestId : room.hostId;
  if (notify && otherId) io.to(otherId).emit("opponentLeft");

  if (!room.hostId || !room.guestId) {
    for (const id of [room.hostId, room.guestId]) {
      if (!id) continue;
      const otherSocket = io.sockets.sockets.get(id);
      if (!otherSocket) continue;
      otherSocket.leave(code);
      otherSocket.data.roomCode = null;
      otherSocket.data.role = null;
    }
    rooms.delete(code);
  }
}

function inputPayload(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    up: Boolean(value.up),
    down: Boolean(value.down),
    left: Boolean(value.left),
    right: Boolean(value.right),
    fire: Boolean(value.fire),
    skill: Boolean(value.skill),
    ult: Boolean(value.ult),
    aimX: clampNumber(value.aimX, 0, 1280, 640),
    aimY: clampNumber(value.aimY, 0, 720, 360)
  };
}

function searchLimits(entry, now = Date.now()) {
  const waitedSeconds = Math.max(0, (now - entry.joinedAt) / 1000);
  return {
    waitedSeconds,
    level: Math.min(12, 1 + Math.floor(waitedSeconds / 8)),
    rating: Math.min(800, 100 + Math.floor(waitedSeconds / 6) * 45)
  };
}

function canMatch(a, b, now) {
  const aLimits = searchLimits(a, now);
  const bLimits = searchLimits(b, now);
  const levelDifference = Math.abs(a.config.level - b.config.level);
  const ratingDifference = Math.abs(a.config.rating - b.config.rating);
  return levelDifference <= Math.max(aLimits.level, bLimits.level)
    && ratingDifference <= Math.max(aLimits.rating, bLimits.rating);
}

function matchScore(a, b) {
  const levelDifference = Math.abs(a.config.level - b.config.level);
  const ratingDifference = Math.abs(a.config.rating - b.config.rating);
  return levelDifference * 1000 + ratingDifference;
}

function createMatchmadeRoom(hostEntry, guestEntry) {
  const hostSocket = io.sockets.sockets.get(hostEntry.socketId);
  const guestSocket = io.sockets.sockets.get(guestEntry.socketId);
  if (!hostSocket || !guestSocket || !hostSocket.connected || !guestSocket.connected) return false;

  removeSocketFromQueue(hostSocket, false);
  removeSocketFromQueue(guestSocket, false);
  removeSocketFromCurrentRoom(hostSocket, false);
  removeSocketFromCurrentRoom(guestSocket, false);

  const code = createUniqueCode();
  const configs = [cleanConfig(hostEntry.config), cleanConfig(guestEntry.config)];
  const room = {
    code,
    hostId: hostSocket.id,
    guestId: guestSocket.id,
    configs,
    matchmade: true,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  rooms.set(code, room);

  hostSocket.join(code);
  guestSocket.join(code);
  hostSocket.data.roomCode = code;
  hostSocket.data.role = "host";
  guestSocket.data.roomCode = code;
  guestSocket.data.role = "guest";

  hostSocket.emit("matchFound", {
    role: "host",
    code,
    opponent: configs[1],
    levelDifference: Math.abs(configs[0].level - configs[1].level)
  });
  guestSocket.emit("matchFound", {
    role: "guest",
    code,
    opponent: configs[0],
    levelDifference: Math.abs(configs[0].level - configs[1].level)
  });

  io.to(code).emit("roomReady", { code, configs, matchmade: true });
  return true;
}

function tryMatchmaking() {
  const now = Date.now();
  const entries = [...matchmakingQueue.values()]
    .filter(entry => {
      const socket = io.sockets.sockets.get(entry.socketId);
      return Boolean(socket && socket.connected);
    })
    .sort((a, b) => a.joinedAt - b.joinedAt);

  const used = new Set();
  for (const entry of entries) {
    if (used.has(entry.socketId) || !matchmakingQueue.has(entry.socketId)) continue;

    let best = null;
    let bestScore = Infinity;
    for (const candidate of entries) {
      if (candidate.socketId === entry.socketId || used.has(candidate.socketId) || !matchmakingQueue.has(candidate.socketId)) continue;
      if (!canMatch(entry, candidate, now)) continue;
      const score = matchScore(entry, candidate);
      if (score < bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (!best) continue;
    used.add(entry.socketId);
    used.add(best.socketId);
    createMatchmadeRoom(entry, best);
  }
}

function sendQueueStatuses() {
  const now = Date.now();
  for (const entry of matchmakingQueue.values()) {
    const socket = io.sockets.sockets.get(entry.socketId);
    if (!socket || !socket.connected) {
      matchmakingQueue.delete(entry.socketId);
      continue;
    }
    const limits = searchLimits(entry, now);
    socket.emit("queueStatus", {
      waitedSeconds: Math.floor(limits.waitedSeconds),
      levelRange: limits.level,
      ratingRange: limits.rating,
      waitingPlayers: matchmakingQueue.size
    });
  }
}

io.on("connection", socket => {
  socket.data.roomCode = null;
  socket.data.role = null;
  socket.data.inMatchmaking = false;
  socket.data.lastInputAt = 0;
  socket.data.lastStateAt = 0;

  socket.on("findMatch", (payload, ack) => {
    try {
      removeSocketFromCurrentRoom(socket, false);
      removeSocketFromQueue(socket, false);
      const config = cleanConfig(payload && payload.config);
      matchmakingQueue.set(socket.id, {
        socketId: socket.id,
        config,
        joinedAt: Date.now()
      });
      socket.data.inMatchmaking = true;
      safeAck(ack, { ok: true, level: config.level, rating: config.rating });
      sendQueueStatuses();
      tryMatchmaking();
    } catch (error) {
      console.error("Pelaajahaun käynnistys epäonnistui:", error);
      safeAck(ack, { ok: false, error: "Pelaajahakua ei voitu käynnistää." });
    }
  });

  socket.on("cancelMatch", (_payload, ack) => {
    removeSocketFromQueue(socket, false);
    safeAck(ack, { ok: true });
  });

  socket.on("createRoom", (payload, ack) => {
    try {
      removeSocketFromCurrentRoom(socket, false);
      const code = createUniqueCode();
      const config = cleanConfig(payload && payload.config);
      const room = {
        code,
        hostId: socket.id,
        guestId: null,
        configs: [config, null],
        matchmade: false,
        createdAt: Date.now(),
        lastActivity: Date.now()
      };
      rooms.set(code, room);
      socket.join(code);
      socket.data.roomCode = code;
      socket.data.role = "host";
      safeAck(ack, { ok: true, code });
    } catch (error) {
      console.error("Huoneen luonti epäonnistui:", error);
      safeAck(ack, { ok: false, error: "Huonetta ei voitu luoda." });
    }
  });

  socket.on("joinRoom", (payload, ack) => {
    const code = cleanCode(payload && payload.code);
    if (code.length !== 6) {
      safeAck(ack, { ok: false, error: "Huonekoodi ei kelpaa." });
      return;
    }

    const room = rooms.get(code);
    if (!room || !room.hostId) {
      safeAck(ack, { ok: false, error: "Huonetta ei löytynyt." });
      return;
    }
    if (room.guestId) {
      safeAck(ack, { ok: false, error: "Huoneessa on jo kaksi pelaajaa." });
      return;
    }
    if (room.hostId === socket.id) {
      safeAck(ack, { ok: false, error: "Et voi liittyä omaan huoneeseesi." });
      return;
    }

    removeSocketFromCurrentRoom(socket, false);
    const config = cleanConfig(payload && payload.config);
    room.guestId = socket.id;
    room.configs[1] = config;
    room.lastActivity = Date.now();
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = "guest";

    safeAck(ack, { ok: true, code });
    io.to(code).emit("roomReady", {
      code,
      configs: room.configs.map(cleanConfig),
      matchmade: false
    });
  });

  socket.on("gameMessage", data => {
    const code = socket.data.roomCode;
    const role = socket.data.role;
    const room = code && rooms.get(code);
    if (!room || !role || !data || typeof data.type !== "string") return;

    room.lastActivity = Date.now();
    const now = Date.now();

    if (role === "guest" && data.type === "input") {
      if (now - socket.data.lastInputAt < 11) return;
      socket.data.lastInputAt = now;
      if (room.hostId) {
        io.to(room.hostId).emit("gameMessage", {
          type: "input",
          input: inputPayload(data.input)
        });
      }
      return;
    }

    if (role === "host" && data.type === "state") {
      if (now - socket.data.lastStateAt < 22) return;
      socket.data.lastStateAt = now;
      if (!data.state || typeof data.state !== "object") return;
      let byteLength = 0;
      try { byteLength = Buffer.byteLength(JSON.stringify(data.state), "utf8"); }
      catch { return; }
      if (byteLength > 250_000) return;
      if (room.guestId) io.to(room.guestId).emit("gameMessage", { type: "state", state: data.state });
      return;
    }

    if (role === "host" && data.type === "start") {
      const configs = Array.isArray(data.configs) && data.configs.length === 2
        ? data.configs.map(cleanConfig)
        : room.configs.map(cleanConfig);
      room.configs = configs;
      if (room.guestId) {
        io.to(room.guestId).emit("gameMessage", {
          type: "start",
          configs,
          seed: Number.isFinite(data.seed) ? data.seed : Date.now()
        });
      }
      return;
    }

    if (role === "guest" && data.type === "rematch" && room.hostId) {
      io.to(room.hostId).emit("gameMessage", { type: "rematch" });
    }
  });

  socket.on("leaveRoom", () => removeSocketFromCurrentRoom(socket, true));
  socket.on("disconnect", () => removeSocketFromCurrentRoom(socket, true));
});

setInterval(() => {
  sendQueueStatuses();
  tryMatchmaking();
}, 1000).unref();

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity <= ROOM_TTL_MS) continue;
    if (room.hostId) io.to(room.hostId).emit("opponentLeft");
    if (room.guestId) io.to(room.guestId).emit("opponentLeft");
    rooms.delete(code);
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Neuroni Nexus -pelipalvelin käynnissä portissa ${PORT}`);
  console.log(`Avaa selaimessa: http://localhost:${PORT}`);
});
