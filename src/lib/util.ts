import { randomBytes } from "node:crypto";

export function now(): number {
  return Date.now();
}

export function rid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export function inviteCode(): string {
  const raw = randomBytes(8).toString("hex").toUpperCase();
  return raw.match(/.{1,4}/g)!.join("-");
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
