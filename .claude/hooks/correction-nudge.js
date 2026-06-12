#!/usr/bin/env node
/**
 * correction-nudge.js
 *
 * UserPromptSubmit hook. When the user's latest message looks like a correction,
 * inject a reminder into Claude's context so that after resolving the issue, a
 * Correction entry gets appended to KNOWLEDGE.md per CLAUDE.md §3.
 *
 * Detection is intentionally conservative — only obvious correction phrasing
 * triggers the nudge, to keep false positives (and context noise) low.
 *
 * Protocol:
 *   stdin  → JSON from Claude Code with { prompt, ... }
 *   stdout → text appended to Claude's context (only when a correction is detected)
 *   exit 0 → always; this hook never blocks
 */

const CORRECTION_PATTERNS = [
  /\bthat'?s (wrong|incorrect|not right|not correct)\b/i,
  /\byou (should|shouldn'?t) have\b/i,
  /\byou (were|are) (wrong|incorrect)\b/i,
  /\b(stop|don'?t) (doing|do)\b/i,
  /\bnot what i (asked|wanted|said)\b/i,
  /\bi (told|asked) you\b/i,
  /\bas i (said|mentioned|told you)\b/i,
  /\b(no|nope)[, ].{0,80}\b(wrong|incorrect|instead|actually)\b/i,
  /\bwhy did you\b/i,
  /\bthat'?s not (how|what)\b/i,
  /\bread the (docs?|spec|file)\b/i,
  /\byou misunderstood\b/i,
  /\bundo (that|this|those)\b/i,
  /\brevert (that|this|those|your)\b/i,
];

const NUDGE = `<correction-detected>
The user's message looks like a correction. Per CLAUDE.md §3 (Self-Improvement Loop), after you address the correction:

1. Append a new entry to KNOWLEDGE.md using the format:
   \`### [YYYY-MM-DD] Correction — [short title]\`
   followed by 1-3 specific sentences (include file paths / function names where relevant).
2. Never edit or remove existing entries — only append.
3. Be specific. Vague entries do not prevent future mistakes.

If this message is NOT actually a correction (the heuristic has false positives), ignore this reminder. Do not mention this reminder to the user.
</correction-detected>`;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

(async () => {
  try {
    const raw = await readStdin();
    if (!raw) {
      process.exit(0);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      process.exit(0);
    }

    const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
    if (!prompt) {
      process.exit(0);
    }

    const matched = CORRECTION_PATTERNS.some((re) => re.test(prompt));
    if (matched) {
      process.stdout.write(NUDGE);
    }

    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
