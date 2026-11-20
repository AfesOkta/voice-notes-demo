const test = require("node:test");
const assert = require("node:assert");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MAX_SECONDS, parseProbeOutput, isValidDuration, isTooLong, formatDuration } = require("../duration");

test("two-minute rule boundaries", () => {
  assert.equal(isTooLong(0), false);
  assert.equal(isTooLong(119), false);
  assert.equal(isTooLong(MAX_SECONDS), false);
  assert.equal(isTooLong(120.4), false, "codec padding under tolerance is allowed");
  assert.equal(isTooLong(120.6), true);
  assert.equal(isTooLong(200), true);
});

test("duration formatting", () => {
  assert.equal(formatDuration(5), 5);
  assert.equal(formatDuration(4.96), 5, "rounds to one decimal");
  assert.equal(formatDuration(119.96), 120);
  assert.equal(formatDuration(12.34), 12.3);
});

test("ffprobe output parsing", () => {
  assert.equal(parseProbeOutput("5.024000\n"), 5.024);
  assert.equal(parseProbeOutput("N/A"), NaN);
  assert.equal(isValidDuration(5.024), true);
  assert.equal(isValidDuration(NaN), false, "unreadable audio is rejected");
  assert.equal(isValidDuration(0), false);
});

test("upload over 120s is rejected by the API", async (t) => {
  let ffmpeg = true;
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    ffmpeg = false;
  }
  if (!ffmpeg) return t.skip("ffmpeg not installed");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-notes-test-"));
  const shortFile = path.join(dir, "short.wav");
  const longFile = path.join(dir, "long.wav");
  const make = (file, secs) =>
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`, "-ac", "1", "-ar", "8000", file], { stdio: "ignore" });
  make(shortFile, 3);
  make(longFile, 130);

  const port = 3210;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: "" },
    stdio: "ignore",
  });
  t.after(() => {
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const ping = () =>
      fetch(`http://127.0.0.1:${port}/api/notes`).then(resolve).catch(() => {
        if (Date.now() > deadline) reject(new Error("server did not start"));
        else setTimeout(ping, 100);
      });
    ping();
  });

  const post = async (file) => {
    const form = new FormData();
    form.append("audio", new Blob([fs.readFileSync(file)], { type: "audio/wav" }), path.basename(file));
    return fetch(`http://127.0.0.1:${port}/api/notes`, { method: "POST", body: form });
  };

  const ok = await post(shortFile);
  assert.equal(ok.status, 201);
  const note = await ok.json();
  assert.equal(note.duration, 3);
  assert.match(note.transcript, /mock transcript/, "no API key means mock transcript");

  const late = await post(longFile);
  assert.equal(late.status, 422);
  const body = await late.json();
  assert.match(body.error, /120s limit/);
  assert.ok(body.duration > 120);

  const stored = fs.readdirSync(path.join(__dirname, "..", "uploads"));
  assert.equal(stored.filter((f) => f.endsWith(".wav")).length, 1, "rejected upload is deleted, not stored");
});
