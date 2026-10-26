import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import sharp from "sharp";
import type { QQBotInboundMessage } from "@tencent-connect/qqbot-nodejs";
import type { Config } from "./config.js";
import { UserError, type ChatImage } from "./content.js";

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch { return false; }
}

export function imageUrl(raw: string, allowedHosts: string[]): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UserError("图片地址无效。"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (raw.length > 8192 || url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
    (isIP(hostname) && !isPublicAddress(hostname)) ||
    (allowedHosts.length && !allowedHosts.some(host => host.toLowerCase() === url.hostname.toLowerCase()))) {
    throw new UserError("图片地址不符合下载策略。");
  }
  return url;
}

/** Validate DNS results in the actual socket lookup, preventing check/fetch rebinding. */
export function publicLookup(resolve: (host: string) => Promise<LookupAddress[]> = host => lookup(host, { all: true })): LookupFunction {
  return (hostname, options, callback) => {
    void resolve(hostname).then(addresses => {
      if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Non-public image address");
      const family = typeof options.family === "number" ? options.family : options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : 0;
      const matching = addresses.filter(item => !family || item.family === family);
      if (!matching.length) throw new Error("No matching address");
      if (options.all) callback(null, matching);
      else callback(null, matching[0]!.address, matching[0]!.family);
    }).catch(error => callback(error instanceof Error ? error : new Error("DNS failure"), ""));
  };
}

export async function boundedBody(body: AsyncIterable<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > maxBytes) throw new UserError("图片超过大小限制。");
    chunks.push(Buffer.from(chunk));
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks, size);
}

export async function downloadImage(url: URL, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  return new Promise<Buffer>((resolve, reject) => {
    const req = request(url, { signal, agent: false, lookup: publicLookup(), headers: { Accept: "image/png,image/jpeg,image/webp" } }, response => {
      const length = Number(response.headers["content-length"] ?? 0);
      // No redirect handling: every accepted response belongs to this checked connection.
      if (response.statusCode !== 200 || !Number.isFinite(length) || length > maxBytes) {
        response.destroy(); reject(new UserError("图片下载失败或超过大小限制。")); return;
      }
      void boundedBody(response, maxBytes, signal).then(resolve, error => { response.destroy(); reject(error); });
    });
    req.on("error", reject);
    req.end();
  });
}

export interface MediaInput {
  load(attachments: NonNullable<QQBotInboundMessage["attachments"]>, signal: AbortSignal): Promise<ChatImage[]>;
  normalize(bytes: Buffer, signal: AbortSignal): Promise<ChatImage>;
}

export class ImagePipeline implements MediaInput {
  constructor(private config: Config["images"], private download = downloadImage) {}

  async normalize(bytes: Buffer, signal: AbortSignal): Promise<ChatImage> {
    signal.throwIfAborted();
    if (bytes.length > this.config.maxBytes) throw new UserError("图片超过大小限制。");
    const input = sharp(bytes, { limitInputPixels: this.config.maxPixels, failOn: "warning", pages: 1 });
    try {
      const metadata = await input.metadata();
      if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1) {
        throw new UserError("仅支持静态 PNG、JPEG 和 WebP 图片。");
      }
      const normalized = await input.rotate().resize({ width: this.config.maxDimension, height: this.config.maxDimension, fit: "inside", withoutEnlargement: true })
        .flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer();
      signal.throwIfAborted();
      if (normalized.length > this.config.maxBytes) throw new UserError("处理后的图片仍超过大小限制。");
      // Sharp strips EXIF and other metadata by default.
      return { type: "image", data: normalized.toString("base64"), mimeType: "image/jpeg" };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof UserError) throw error;
      throw new UserError("图片无法解码或像素数量超过限制。");
    } finally { input.destroy(); }
  }

  async load(attachments: NonNullable<QQBotInboundMessage["attachments"]>, parent: AbortSignal): Promise<ChatImage[]> {
    if (!this.config.enabled) throw new UserError("图片功能未启用，请联系机器人管理员或改用文字。");
    if (attachments.length > this.config.maxImages) throw new UserError(`单条消息最多支持 ${this.config.maxImages} 张图片。`);
    const result: ChatImage[] = [];
    for (const item of attachments) {
      if (!item.content_type.startsWith("image/")) throw new UserError("目前只支持文本和静态图片附件。");
      if ((item.size ?? 0) > this.config.maxBytes) throw new UserError("图片超过大小限制。");
      const url = imageUrl(item.url, this.config.allowedHosts);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), this.config.timeoutMs);
      const signal = AbortSignal.any([parent, timeout.signal]);
      try {
        result.push(await this.normalize(await this.download(url, this.config.maxBytes, signal), signal));
      } catch (error) {
        parent.throwIfAborted();
        if (error instanceof UserError) throw error;
        throw new UserError(timeout.signal.aborted ? "图片下载超时，请稍后重试。" : "图片下载失败，请重新发送图片。");
      } finally { clearTimeout(timer); }
    }
    return result;
  }
}
