/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { lookup, type LookupAddress } from "dns";
import { IpcMainInvokeEvent } from "electron";
import { get as httpsGet } from "https";
import { BlockList, isIP } from "net";

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const TIMEOUT_MS = 6000;
const MAX_HTML = 512 * 1024;
const MAX_ICON = 256 * 1024;
const MAX_REDIRECTS = 4;
const CACHE_TTL = 6 * 60 * 60 * 1000;

// Les domaines viennent de profils Discord : on refuse tout ce qui pointe vers le réseau local
const privateRanges = new BlockList();
for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
    ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]
] as const) privateRanges.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
    ["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) privateRanges.addSubnet(net, prefix, "ipv6");

function isPublic(address: string) {
    // ::ffff:a.b.c.d (IPv4 encapsulé) est vérifié comme de l'IPv4
    address = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
    const family = isIP(address);
    return family !== 0 && !privateRanges.check(address, family === 6 ? "ipv6" : "ipv4");
}

const safeLookup: typeof lookup = ((hostname: string, options: any, callback: any) => {
    lookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
        if (err) return callback(err);
        const allowed = addresses.filter(a => isPublic(a.address));
        if (!allowed.length) return callback(new Error(`${hostname} pointe vers une adresse privée`));
        if (options?.all) callback(null, allowed);
        else callback(null, allowed[0].address, allowed[0].family);
    });
}) as any;

interface Response {
    url: string;
    type: string;
    body: Buffer;
}

function request(url: string, maxBytes: number, redirects = 0): Promise<Response> {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        if (target.protocol !== "https:") return reject(new Error("HTTPS uniquement"));

        const req = httpsGet(target, {
            lookup: safeLookup,
            timeout: TIMEOUT_MS,
            headers: {
                "User-Agent": "Mozilla/5.0 (Vencord ConnectionFavicons)",
                "Accept": "text/html,image/*;q=0.9,*/*;q=0.5"
            }
        }, res => {
            const { statusCode = 0, headers } = res;
            if (statusCode >= 300 && statusCode < 400 && headers.location) {
                res.resume();
                if (redirects >= MAX_REDIRECTS) return reject(new Error("Trop de redirections"));
                return resolve(request(new URL(headers.location, target).href, maxBytes, redirects + 1));
            }
            if (statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${statusCode}`));
            }

            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > maxBytes) {
                    // pour le HTML on garde le début, le <head> suffit
                    chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
                    res.destroy();
                    return finish();
                }
                chunks.push(chunk);
            });
            res.on("end", finish);
            res.on("error", reject);

            let done = false;
            function finish() {
                if (done) return;
                done = true;
                resolve({ url: target.href, type: String(headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(), body: Buffer.concat(chunks) });
            }
        });
        req.on("timeout", () => req.destroy(new Error("Délai dépassé")));
        req.on("error", reject);
    });
}

function attr(tag: string, name: string) {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3]).trim() : null;
}

function decodeEntities(s: string) {
    return s.replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

interface Candidate {
    href: string;
    score: number;
}

// SVG d'abord (net à toutes les tailles), puis la plus grande image bitmap, apple-touch-icon en dernier recours
function findIconLinks(html: string, base: string): Candidate[] {
    const head = html.split(/<\/head>/i)[0];
    const baseHref = attr(/<base\s[^>]*>/i.exec(head)?.[0] ?? "", "href");
    const resolvedBase = baseHref ? new URL(decodeEntities(baseHref), base).href : base;

    const candidates: Candidate[] = [];
    for (const [tag] of head.matchAll(/<link\s[^>]*>/gi)) {
        const rel = attr(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
        const href = attr(tag, "href");
        if (!href || rel.includes("mask-icon")) continue;

        const isIcon = rel.includes("icon");
        const isApple = rel.some(r => r.startsWith("apple-touch-icon"));
        if (!isIcon && !isApple) continue;

        const type = attr(tag, "type")?.toLowerCase() ?? "";
        const sizes = attr(tag, "sizes")?.toLowerCase() ?? "";
        const maxSize = sizes === "any" ? 512 : Math.max(0, ...[...sizes.matchAll(/(\d+)x\d+/g)].map(m => +m[1]));

        let score = isApple ? 100 : 200;
        if (type.includes("svg") || /\.svg(?:[?#]|$)/i.test(href) || sizes === "any") score = 1000;
        else score += Math.min(maxSize, 256);

        try {
            const resolved = new URL(decodeEntities(href), resolvedBase);
            if (resolved.protocol === "https:" || resolved.protocol === "data:")
                candidates.push({ href: resolved.href, score });
        } catch { }
    }

    return candidates.sort((a, b) => b.score - a.score);
}

function sniffImageType(body: Buffer, declared: string) {
    const head = body.subarray(0, 512).toString("latin1").trimStart();
    if (body[0] === 0x89 && head.startsWith("\x89PNG")) return "image/png";
    if (body[0] === 0xFF && body[1] === 0xD8) return "image/jpeg";
    if (head.startsWith("GIF8")) return "image/gif";
    if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
    if (body.readUInt32LE(0) === 0x00010000) return "image/x-icon";
    if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
    if (declared === "image/avif") return declared;
    return null;
}

async function downloadIcon(href: string) {
    if (href.startsWith("data:")) {
        const m = /^data:(image\/[a-z0-9.+-]+)[;,]/i.exec(href);
        return m && href.length <= MAX_ICON * 1.4 ? href : null;
    }

    const res = await request(href, MAX_ICON + 1);
    if (res.body.length === 0 || res.body.length > MAX_ICON) return null;
    const type = sniffImageType(res.body, res.type);
    return type ? `data:${type};base64,${res.body.toString("base64")}` : null;
}

async function resolveFavicon(domain: string) {
    const candidates: Candidate[] = [];
    try {
        const page = await request(`https://${domain}/`, MAX_HTML);
        if (page.type.includes("html")) candidates.push(...findIconLinks(page.body.toString("utf8"), page.url));
    } catch { }
    candidates.push({ href: `https://${domain}/favicon.ico`, score: 0 });

    const tried = new Set<string>();
    for (const { href } of candidates) {
        if (tried.has(href)) continue;
        tried.add(href);
        try {
            const icon = await downloadIcon(href);
            if (icon) return icon;
        } catch { }
    }
    return null;
}

const cache = new Map<string, { at: number; value: Promise<string | null>; }>();

export function getFavicon(_: IpcMainInvokeEvent, domain: string): Promise<string | null> {
    domain = String(domain).toLowerCase();
    if (!DOMAIN_RE.test(domain)) return Promise.resolve(null);

    const cached = cache.get(domain);
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value;

    const value = resolveFavicon(domain).catch(() => null);
    cache.set(domain, { at: Date.now(), value });
    return value;
}

export function clearFaviconCache() {
    cache.clear();
}
