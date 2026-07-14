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

app.disable("x-powered-by");
app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, time: new Date().toISOString() });
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
    hero: VALID_HEROES.has(config.hero) ? config.hero : "bolt"
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

function removeSocketFromCurrentRoom(socket, notify = true) {
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

  // Ottelu ei voi jatkua turvallisesti ilman isäntää tai vierasta.
  if (!room.hostId || !room.guestId) {
    if (room.hostId) {
      const hostSocket = io.sockets.sockets.get(room.hostId);
      if (hostSocket) {
        hostSocket.leave(code);
        hostSocket.data.roomCode = null;
        hostSocket.data.role = null;
      }
    }
    if (room.guestId) {
      const guestSocket = io.sockets.sockets.get(room.guestId);
      if (guestSocket) {
        guestSocket.leave(code);
        guestSocket.data.roomCode = null;
        guestSocket.data.role = null;
      }
    }
    rooms.delete(code);
  }
}

function safeAck(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function inputPayload(input) {
  const value = input && typeof input === "object" ? input : {};
  const clamp = (number, min, max, fallback) => {
    const n = Number(number);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  return {
    up: Boolean(value.up),
    down: Boolean(value.down),
    left: Boolean(value.left),
    right: Boolean(value.right),
    fire: Boolean(value.fire),
    skill: Boolean(value.skill),
    ult: Boolean(value.ult),
    aimX: clamp(value.aimX, 0, 1280, 640),
    aimY: clamp(value.aimY, 0, 720, 360)
  };
}

io.on("connection", socket => {
  socket.data.roomCode = null;
  socket.data.role = null;
  socket.data.lastInputAt = 0;
  socket.data.lastStateAt = 0;

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
      configs: room.configs.map(cleanConfig)
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
      // Enintään noin 90 ohjausviestiä sekunnissa.
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
      // Enintään noin 45 tilapäivitystä sekunnissa.
      if (now - socket.data.lastStateAt < 22) return;
      socket.data.lastStateAt = now;
      if (!data.state || typeof data.state !== "object") return;
      let byteLength = 0;
      try { byteLength = Buffer.byteLength(JSON.stringify(data.state), "utf8"); }
      catch { return; }
      if (byteLength > 250_000) return;
      if (room.guestId) {
        io.to(room.guestId).emit("gameMessage", { type: "state", state: data.state });
      }
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
