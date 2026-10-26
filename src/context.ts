import type { Config } from "./config.js";

/** A compaction target, not a hard cap on a single input or tool response. */
export function chatCompactionSettings(policy: Config["context"], contextWindow: number) {
  const window = Math.max(1024, contextWindow);
  const headroom = Math.min(8192, Math.floor(window / 4));
  const target = Math.min(policy.maxTokens, window - headroom);
  return {
    enabled: true,
    reserveTokens: window - target,
    keepRecentTokens: Math.min(policy.keepRecentTokens, Math.floor(target / 2)),
  };
}

/** Approximate new input before the provider can report usage; account for CJK text. */
export function chatTokenEstimate(text: string): number {
  const nonAscii = (text.match(/[^\x00-\x7f]/gu) ?? []).length;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii * 1.5);
}
