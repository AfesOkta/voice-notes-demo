// Voice note backend: upload -> duration check -> transcription -> realtime broadcast.
// Run: npm start   (Transcription needs OPENAI_API_KEY; without it, MOCK transcripts are used.)

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const http = require("http");
const { Server } = require("socket.io");
const { MAX_SECONDS, parseProbeOutput, isValidDuration, isTooLong, formatDuration } = require("./duration");

const execFileAsync = promisify(execFile);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const DB_PATH = path.join(__dirname, "notes.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "[]");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "1h" }));

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".webm").toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype) || /\.(webm|ogg|mp3|wav|m4a|mp4)$/i.test(file.originalname)),
});

const readNotes = () => JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const writeNotes = (notes) => fs.writeFileSync(DB_PATH, JSON.stringify(notes, null, 2));

async function probeDuration(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  return parseProbeOutput(stdout);
}

async function transcribe(filePath) {
  if (!process.env.OPENAI_API_KEY) {
    return "[mock transcript] Replace OPENAI_API_KEY to transcribe for real. Duration enforced server-side.";
  }
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: "audio/webm" }), path.basename(filePath));
  form.append("model", process.env.TRANSCRIBE_MODEL || "whisper-1");
  form.append("response_format", "text");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`);
  return (await res.text()).trim();
}

app.get("/api/notes", (_req, res) => res.json(readNotes()));

app.post("/api/notes", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "audio file required" });
  const filePath = req.file.path;

  try {
    const duration = await probeDuration(filePath);
    if (!isValidDuration(duration)) throw new Error("unreadable audio");
    if (isTooLong(duration)) {
      fs.unlinkSync(filePath);
      return res.status(422).json({ error: `voice note exceeds ${MAX_SECONDS}s limit`, duration });
    }

    let transcript = "";
    try {
      transcript = await transcribe(filePath);
    } catch (err) {
      console.error("transcription error:", err.message);
      transcript = "[transcription unavailable]";
    }

    const note = {
      id: crypto.randomUUID(),
      url: `/uploads/${path.basename(filePath)}`,
      author: (req.body.author || "field-tech").slice(0, 40),
      duration: formatDuration(duration),
      transcript,
      listenedBy: [],
      createdAt: new Date().toISOString(),
    };
    const notes = readNotes();
    notes.unshift(note);
    writeNotes(notes);
    io.emit("note:new", note);
    res.status(201).json(note);
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(400).json({ error: err.message });
  }
});

// "listened" state: who has played the note, broadcast so senders see delivery
app.post("/api/notes/:id/listened", (req, res) => {
  const notes = readNotes();
  const note = notes.find((n) => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "not found" });
  const who = (req.body?.by || "field-tech").slice(0, 40);
  if (!note.listenedBy.includes(who)) note.listenedBy.push(who);
  writeNotes(notes);
  io.emit("note:listened", { id: note.id, listenedBy: note.listenedBy });
  res.json(note);
});

io.on("connection", (socket) => {
  socket.emit("notes:sync", readNotes().slice(0, 50));
});

server.listen(PORT, () => console.log(`voice-notes demo on http://localhost:${PORT}`));
