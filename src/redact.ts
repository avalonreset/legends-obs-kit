const secretKey = /(^|[_-])(password|passwd|token|secret|api[_-]?key|authorization|cookie|stream[_-]?key|access[_-]?key|refresh[_-]?token)($|[_-])|^(?:key|password|passwd|refreshToken|accessToken|apiKey|streamKey|authorization|cookie|cookieId)$/i;
const webhookPattern = /(https:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/)\d+\/[^?\s"']+/gi;
const sensitiveText = [
  /ya29\.[A-Za-z0-9._-]+/g,
  /1\/\/[A-Za-z0-9._-]+/g,
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:xox(?:b|p|a|r|s|e)|xapp)-[A-Za-z0-9-]{10,}\b/g,
  webhookPattern,
];

const embeddedUrl = /\b(?:https?|rtmps?|wss?):\/\/[^\s<>"']+/gi;
const userProfilePath = /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+/gi;

function redactUrl(value: string): string {
  if (!/^(?:https?|rtmps?|wss?):\/\//i.test(value)) return value;
  try {
    const parsed = new URL(value);
    let changed = false;
    if (parsed.username) {
      parsed.username = "[REDACTED]";
      changed = true;
    }
    if (parsed.password) {
      parsed.password = "[REDACTED]";
      changed = true;
    }
    for (const key of [...parsed.searchParams.keys()]) {
      if (secretKey.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
        changed = true;
      }
    }
    return changed ? parsed.toString() : value;
  } catch {
    return value;
  }
}

export function redactUnknown(value: unknown, key = ""): unknown {
  if (secretKey.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        redactUnknown(childValue, childKey),
      ]),
    );
  }
  if (typeof value === "string") return redactText(value);
  return value;
}

export function redactText(value: string): string {
  const urlsRedacted = value.replace(embeddedUrl, (url) => redactUrl(url));
  const profileRedacted = urlsRedacted.replace(userProfilePath, "%USERPROFILE%");
  return sensitiveText.reduce((text, pattern) => {
    pattern.lastIndex = 0;
    return text.replace(pattern, pattern === webhookPattern ? "$1[REDACTED]" : "[REDACTED]");
  }, profileRedacted);
}

export function containsSecretMarker(value: unknown): boolean {
  return containsCredential(value);
}

function containsCredential(value: unknown, key = ""): boolean {
  if (secretKey.test(key)) {
    return value !== null && value !== undefined && value !== "" && value !== "[REDACTED]" && typeof value !== "boolean";
  }
  if (Array.isArray(value)) return value.some((item) => containsCredential(item));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([childKey, childValue]) => containsCredential(childValue, childKey));
  }
  if (typeof value !== "string") return false;
  if (redactUrl(value) !== value) return true;
  let embeddedCredential = false;
  value.replace(embeddedUrl, (url) => {
    if (redactUrl(url) !== url) embeddedCredential = true;
    return url;
  });
  if (embeddedCredential) return true;
  return sensitiveText.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
