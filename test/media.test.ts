import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { boundedBody, ImagePipeline, imageUrl, isPublicAddress, publicLookup } from "../src/media.js";
import { config } from "./helpers.js";

const signal = new AbortController().signal;
test("image URL and socket DNS checks reject private, mapped, reserved and mixed addresses", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.2", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "0.0.0.0"]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  for (const url of ["http://example.com/a", "https://127.1/a", "https://[::1]/a", "https://user:pass@example.com/a", "https://example.com:8443/a"]) assert.throws(() => imageUrl(url, []));
  assert.throws(() => imageUrl("https://evil.example/a", ["cdn.example"]));
  assert.equal(imageUrl("https://cdn.example/image?q=1", ["cdn.example"]).hostname, "cdn.example");
  const resolver = publicLookup(async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await assert.rejects(new Promise((resolve, reject) => resolver("cdn.example", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), /Non-public/);
  const safe = publicLookup(async () => [{ address: "8.8.8.8", family: 4 }]);
  assert.deepEqual(await new Promise((resolve, reject) => safe("cdn.example", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))), [{ address: "8.8.8.8", family: 4 }]);
});

test("streaming byte cap rejects unbounded/chunked bodies without buffering the whole file", async () => {
  let read = 0;
  async function* chunks() { for (let i = 0; i < 10; i++) { read++; yield Buffer.alloc(8); } }
  await assert.rejects(boundedBody(chunks(), 10, signal), /大小/);
  assert.equal(read, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(boundedBody(chunks(), 100, controller.signal));
});

test("decode verifies image bytes, strips metadata, bounds pixels and normalizes before Pi input", async () => {
  const cfg = config().images;
  cfg.enabled = true;
  cfg.maxDimension = 256;
  const bytes = await sharp({ create: { width: 400, height: 200, channels: 3, background: "red" } }).withMetadata().png().toBuffer();
  const pipeline = new ImagePipeline(cfg, async () => bytes);
  const [image] = await pipeline.load([{ content_type: "image/png", url: "https://cdn.example/a" }], signal);
  assert.ok(image);
  const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 128);
  assert.equal(metadata.exif, undefined);
  await assert.rejects(pipeline.normalize(Buffer.from("not an image"), signal), /解码/);
  cfg.maxPixels = 10000;
  await assert.rejects(new ImagePipeline(cfg).normalize(bytes, signal), /像素/);
  await assert.rejects(pipeline.load([{ content_type: "application/pdf", url: "https://cdn.example/a" }], signal), /静态图片/);
});

test("media timeouts cover body download and disabled/oversized batches never fetch", async () => {
  const cfg = config().images;
  let calls = 0;
  const pipeline = new ImagePipeline(cfg, async (_url, _max, signal) => {
    calls++;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const attachment = { content_type: "image/png", url: "https://cdn.example/a" };
  await assert.rejects(pipeline.load([attachment], signal), /未启用/);
  cfg.enabled = true; cfg.maxImages = 1; cfg.timeoutMs = 10;
  await assert.rejects(pipeline.load([attachment, attachment], signal), /最多/);
  assert.equal(calls, 0);
  await assert.rejects(pipeline.load([attachment], signal), /超时/);
  assert.equal(calls, 1);
});
