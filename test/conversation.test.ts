import test from "node:test";
import assert from "node:assert/strict";
import { cleanContent, Deduplicator, replyChunks, RequestBudget } from "../src/conversation.js";
import { groupMessage } from "./helpers.js";

test("dedup expires below capacity", () => {
  const d = new Deduplicator(10);
  assert.equal(d.accept("x", 0), true);
  assert.equal(d.accept("x", 9), false);
  assert.equal(d.accept("x", 10), true);
});
test("budget expires and rejected requests consume no other tier", () => {
  const b = new RequestBudget(10);
  assert.equal(b.accept([["a", 1], ["global", 2]], 0), true);
  assert.equal(b.accept([["a", 1], ["global", 2]], 1), false);
  assert.equal(b.accept([["b", 1], ["global", 2]], 2), true);
  assert.equal(b.accept([["a", 1], ["global", 2]], 11), true);
});
test("remove only self mentions, including opaque IDs with regex characters", () => {
  assert.equal(cleanContent(groupMessage({ content: "<@!a.b> /help <@other>", mentions: [{ id: "a.b", is_you: true }] })), "/help <@other>");
});
test("long replies are bounded without breaking emoji", () => {
  const chunks = replyChunks("😀".repeat(15000));
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every(s => Array.from(s).length <= 4000 && !s.includes("�")));
  assert.match(chunks[2]!, /回复过长/);
});
