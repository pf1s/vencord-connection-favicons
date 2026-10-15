/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";

interface ConnectionPlatform {
    icon: Record<"lightSVG" | "darkSVG" | "whiteSVG" | "lightPNG" | "darkPNG" | "whitePNG", string>;
}

const platforms: { get(type: string): ConnectionPlatform | undefined; } = findByPropsLazy("isSupported", "getByUrl");
const logger = new Logger("ConnectionFavicons");
// absent sur la version web de Discord : on retombe alors sur DuckDuckGo (fichiers .ico uniquement)
const Native = VencordNative.pluginHelpers.ConnectionFavicons as PluginNative<typeof import("./native")> | undefined;

const ORIGINAL_SRC = "vcCfOriginalSrc";
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const settings = definePluginSettings({
    rounded: {
        type: OptionType.BOOLEAN,
        description: "Arrondir légèrement les favicons",
        default: true
    }
});

let observer: MutationObserver | null = null;
let domainIcons = new Set<string>();
const failedDomains = new Set<string>();

function toDomain(value: string | null | undefined) {
    if (!value) return null;
    let host = value.trim();
    try {
        if (/^https?:\/\//i.test(host)) host = new URL(host).hostname;
    } catch {
        return null;
    }
    host = host.replace(/\.$/, "").toLowerCase();
    return DOMAIN_RE.test(host) ? host : null;
}

// Discord n'expose pas le domaine sur l'icône : on le retrouve via le lien, l'aria-label ou le texte voisin
function findDomain(img: HTMLImageElement) {
    const link = img.closest<HTMLAnchorElement>("a[href]");
    const fromLink = toDomain(link?.href);
    if (fromLink) return fromLink;

    const fromLabel = toDomain(img.getAttribute("aria-label"));
    if (fromLabel) return fromLabel;

    let el: HTMLElement | null = img.parentElement;
    for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
        const label = toDomain(el.getAttribute("aria-label"));
        if (label) return label;
        for (const text of el.innerText?.split(/\s+/) ?? []) {
            const domain = toDomain(text);
            if (domain) return domain;
        }
    }
    return null;
}

const resolved = new Map<string, Promise<string | null>>();

function getFavicon(domain: string) {
    let value = resolved.get(domain);
    if (!value) {
        value = Native
            ? Native.getFavicon(domain).catch(e => (logger.error("Échec pour", domain, e), null))
            : Promise.resolve(`https://icons.duckduckgo.com/ip3/${domain}.ico`);
        resolved.set(domain, value);
    }
    return value;
}

async function patchImage(img: HTMLImageElement) {
    const src = img.getAttribute("src") ?? "";
    if (!domainIcons.has(src)) return;

    const domain = findDomain(img);
    if (!domain || failedDomains.has(domain)) return;

    const favicon = await getFavicon(domain);
    if (!favicon) {
        failedDomains.add(domain);
        return;
    }
    // l'image a pu être réutilisée ou remplacée pendant le téléchargement
    if (!observer || img.getAttribute("src") !== src || findDomain(img) !== domain) return;

    img.dataset[ORIGINAL_SRC] = src;
    img.classList.add("vc-cf-favicon");
    img.style.objectFit = "contain";
    if (settings.store.rounded) img.style.borderRadius = "4px";
    img.onerror = () => {
        failedDomains.add(domain);
        restoreImage(img);
    };
    img.src = favicon;
}

function restoreImage(img: HTMLImageElement) {
    const original = img.dataset[ORIGINAL_SRC];
    if (!original) return;
    img.onerror = null;
    img.src = original;
    img.style.borderRadius = "";
    img.style.objectFit = "";
    img.classList.remove("vc-cf-favicon");
    delete img.dataset[ORIGINAL_SRC];
}

function scan(root: ParentNode) {
    for (const src of domainIcons) {
        root.querySelectorAll<HTMLImageElement>(`img[src="${CSS.escape(src)}"]`).forEach(patchImage);
    }
}

export default definePlugin({
    name: "ConnectionFavicons",
    description: "Affiche le favicon du site (SVG, PNG, ICO, WebP…) à la place de l'icône générique des connexions « Domaine » sur les profils",
    authors: [{ name: "Clem", id: 1452229179625181207n }],
    settings,

    start() {
        const domain = platforms.get("domain");
        if (!domain) {
            logger.error("Plateforme « domain » introuvable, le plugin ne fera rien");
            return;
        }
        domainIcons = new Set(Object.values(domain.icon).filter(Boolean));

        scan(document);
        observer = new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.type === "attributes") {
                    if (m.target instanceof HTMLImageElement) patchImage(m.target);
                    continue;
                }
                for (const node of m.addedNodes) {
                    if (node instanceof HTMLImageElement) patchImage(node);
                    else if (node instanceof HTMLElement) scan(node);
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    },

    stop() {
        observer?.disconnect();
        observer = null;
        document.querySelectorAll<HTMLImageElement>("img.vc-cf-favicon").forEach(restoreImage);
        domainIcons.clear();
        failedDomains.clear();
        resolved.clear();
        Native?.clearFaviconCache();
    }
});
