// Duration rules for voice notes, kept out of server.js so they are testable.

const MAX_SECONDS = 120;
const TOLERANCE = 0.5; // codec/frame padding: 120s recordings report slightly over

function parseProbeOutput(stdout) {
  return Number.parseFloat(String(stdout).trim());
}

// Invalid audio (unreadable length) is rejected, not accepted.
function isValidDuration(seconds) {
  return Number.isFinite(seconds) && seconds > 0;
}

function isTooLong(seconds, limit = MAX_SECONDS) {
  return seconds > limit + TOLERANCE;
}

function formatDuration(seconds) {
  return Math.round(seconds * 10) / 10;
}

module.exports = { MAX_SECONDS, TOLERANCE, parseProbeOutput, isValidDuration, isTooLong, formatDuration };
