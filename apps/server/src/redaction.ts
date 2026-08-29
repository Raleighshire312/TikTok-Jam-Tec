import type { AppConfig } from "./config.js";

const REDACTION_TOKEN = "[REDACTED]";
const MAX_TRACE_TEXT_LENGTH = 4_000;

const literalSecretKeys = ["key", "token", "secret", "password", "passwd", "authorization"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncate(value: string, maxLength = MAX_TRACE_TEXT_LENGTH): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "... [truncated]";
}

export class Redactor {
  private readonly literalSecrets: string[];

  constructor(config: AppConfig) {
    this.literalSecrets = [config.arkApiKey, config.authToken]
      .map((value) => value.trim())
      .filter((value) => value.length >= 6 && !value.startsWith("replace-"));
  }

  redactText(value: string): { value: string; redacted: boolean } {
    let next = value;
    let redacted = false;

    for (const secret of this.literalSecrets) {
      const pattern = new RegExp(escapeRegExp(secret), "g");
      if (pattern.test(next)) {
        next = next.replace(pattern, REDACTION_TOKEN);
        redacted = true;
      }
    }

    const replacements: Array<[RegExp, string]> = [
      [/\b(?:sk|rk|pk)_[A-Za-z0-9_-]{8,}\b/g, REDACTION_TOKEN],
      [/\bAKIA[0-9A-Z]{16}\b/g, REDACTION_TOKEN],
      [/\bASIA[0-9A-Z]{16}\b/g, REDACTION_TOKEN],
      [/\b(?:ghp|github_pat)_[A-Za-z0-9_]{10,}\b/g, REDACTION_TOKEN],
      [/\bBearer\s+[A-Za-z0-9._=-]{12,}\b/gi, "Bearer " + REDACTION_TOKEN],
      [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, REDACTION_TOKEN],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTION_TOKEN],
      [/\b(?:postgres|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'`]+/gi, REDACTION_TOKEN],
      [
        /\b([A-Za-z0-9_.-]{0,32}(?:key|token|secret|password)[A-Za-z0-9_.-]{0,32})\s*[:=]\s*(['"]?)([^'"\s]{6,})\2/gi,
        "$1=" + REDACTION_TOKEN,
      ],
    ];

    for (const [pattern, replacement] of replacements) {
      if (pattern.test(next)) {
        next = next.replace(pattern, replacement);
        redacted = true;
      }
    }

    const truncated = truncate(next);
    return { value: truncated, redacted: redacted || truncated !== value };
  }

  redactUnknown<T>(value: T): { value: T; redacted: boolean } {
    if (typeof value === "string") {
      const result = this.redactText(value);
      return { value: result.value as T, redacted: result.redacted };
    }
    if (Array.isArray(value)) {
      let redacted = false;
      const next = value.map((item) => {
        const result = this.redactUnknown(item);
        redacted = redacted || result.redacted;
        return result.value;
      });
      return { value: next as T, redacted };
    }
    if (value && typeof value === "object") {
      let redacted = false;
      const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        if (literalSecretKeys.some((fragment) => key.toLowerCase().includes(fragment))) {
          redacted = true;
          return [key, REDACTION_TOKEN];
        }
        const result = this.redactUnknown(item);
        redacted = redacted || result.redacted;
        return [key, result.value];
      });
      return { value: Object.fromEntries(entries) as T, redacted };
    }
    return { value, redacted: false };
  }
}
