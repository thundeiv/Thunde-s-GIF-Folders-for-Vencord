/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { DeleteIcon, FolderIcon, MainSettingsIcon, OpenExternalIcon, PlusIcon } from "@components/Icons";
import { IS_MAC } from "@utils/constants";
import { getCurrentChannel, insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import {
    ConfirmModal,
    ContextMenuApi,
    Forms,
    FluxDispatcher,
    Menu,
    Modal,
    openModal,
    React,
    RestAPI,
    showToast,
    Slider,
    TextInput,
    Toasts,
    useState
} from "@webpack/common";

const logger = new Logger("GifFolders");

// Tracks the "Replying to Username" state the chat bar shows after clicking a
// message's Reply button. Used so sending a GIF while that's active attaches it as
// a reply instead of a plain message, matching what typing-and-sending would do.
// Found by an expected method name rather than findStoreLazy's exact-store-name
// match, since that's more robust to Discord renaming the store itself internally.
const PendingReplyModule = findByPropsLazy("getPendingReply");

/**
 * findByPropsLazy returns an untyped module (it can't know in advance what it's
 * going to find), so PendingReplyModule.getPendingReply(...) itself is still `any` -
 * this only documents, and types, the specific shape read off its result below.
 */
interface PendingReplyState {
    shouldMention?: boolean;
    message?: {
        id?: string;
        channel_id?: string;
    };
}

// createPortal isn't re-exported by name from @webpack/common in this build,
// so it's found the same way PendingReplyModule is above - by a property
// every build is expected to have, rather than by module name (which is more
// likely to change between Discord/webpack versions).
const ReactDOM = findByPropsLazy("createPortal");

// ---------- Settings ----------

const settings = definePluginSettings({
    chatBarIcon: {
        type: OptionType.SELECT,
        description: "Which icon represents GIF Folders in the chat bar - purely cosmetic",
        options: [
            { label: "Gorilla 🦍 (banana 🍌 on hover)", value: "gorilla", default: true },
            { label: "Folder (classic)", value: "folder" },
            { label: "\"GIF\" text", value: "gif" }
        ]
    },
    enableCache: {
        type: OptionType.BOOLEAN,
        description: "Cache saved GIFs locally so they load instantly and keep working even if the original link expires or goes offline",
        default: true
    },
    instantSendModifier: {
        type: OptionType.SELECT,
        description: "Hold this key and click a GIF to send it instantly without closing GIF Folders, so you can send several in a row",
        options: [
            { label: IS_MAC ? "Cmd (⌘)" : "Ctrl", value: "ctrl", default: true },
            { label: "Shift", value: "shift" },
            { label: "Alt", value: "alt" }
        ]
    },
    gridColumns: {
        type: OptionType.SELECT,
        description: "How many GIFs fit in one row of the folder grid - the window widens to match. The window's right edge can also be dragged to resize it further.",
        options: [
            { label: "3 per row (default)", value: "3", default: true },
            { label: "4 per row", value: "4" },
            { label: "5 per row", value: "5" },
            { label: "6 per row", value: "6" }
        ]
    },
    freeResize: {
        type: OptionType.BOOLEAN,
        description: "Let the window's width - drag its edges to change it - decide how many GIFs fit per row, instead of a fixed number",
        default: false
    },
    freeResizeTileMin: {
        type: OptionType.SLIDER,
        description: "Free Resize only: the smallest a GIF is ever allowed to shrink to while dragging the window narrower",
        markers: [80, 100, 120, 140, 160, 180, 200],
        default: 80,
        stickToMarkers: false
    },
    maxCacheSize: {
        type: OptionType.SELECT,
        description: "Local cache budget across all folders combined. Past this, the least-recently-viewed GIFs stop being cached locally (they're never deleted from the folder - just re-fetched from their live link next time you view them). Higher costs more startup time and memory, not stability - see the chat investigation for why.",
        options: [
            { label: "500 MB", value: "500" },
            { label: "1 GB", value: "1024" },
            { label: "2 GB", value: "2048", default: true },
            { label: "4 GB", value: "4096" },
            { label: "Unlimited", value: "unlimited" }
        ]
    }
});

// ---------- Types ----------

interface GifEntry {
    id: string;
    /**
     * The canonical, publicly-shareable link for this GIF - exactly what was on the
     * message when it was saved (e.g. a tenor.com/view/... page, or a real Discord
     * attachment link). This is what gets copied and (re)sent into chat: posting this
     * exact link is what makes Discord show a clean embed (no visible raw-link text)
     * and, for Tenor/Giphy picks, keeps the native hover-to-favorite star working for
     * people who don't have this plugin.
     */
    shareSrc: string;
    /**
     * The actual playable media asset resolved from Discord's embed/attachment data
     * (falls back to shareSrc when there's nothing to resolve, e.g. plain attachments).
     * Used ONLY to render/cache the preview inside GIF Folders - never sent to chat,
     * since it's often an internal Discord proxy URL Discord won't treat as a "clean"
     * embeddable link on its own.
     */
    mediaSrc: string;
    name: string;
    addedAt: number;
}

type FolderMap = Record<string, GifEntry[]>;

interface MediaCacheEntry {
    dataUrl: string;
    cachedAt: number;
    size: number;
    /**
     * Whether the cached file's own metadata says it loops forever. `false` means the
     * file (a GIF or an animated WebP) is encoded to stop after a fixed number of
     * plays - very common for GIFs Discord/Tenor transcode from video, and for the
     * animated WebPs Discord's own CDN transcodes GIFs into - so we work around that
     * by periodically restarting it ourselves. An unreadable loop count is also
     * treated as `false` (safer to restart something that turns out static/infinite
     * than to leave a finite-loop file frozen forever). `undefined` means this isn't
     * a GIF/WebP at all, or is a video (which loops natively via the `loop` attribute
     * instead) - in those cases there's nothing to restart, so it's left alone.
     */
    loopsForever?: boolean;
}

const DATA_KEY = "GifFolders_data_v3";
const DATA_KEY_V2 = "GifFolders_data_v2";
const OLD_DATA_KEY = "GifFolders_data";
// Bumped from v1: earlier versions of this plugin could persist entries with the
// wrong bytes entirely (resolved from a URL missing Discord's display-time params,
// like `animated=true`, silently yielding a static single-frame rendition of a file
// that's actually animated) or a wrong loopsForever (an asymmetric bug that left it
// `undefined`/never-restart for files whose loop count couldn't be parsed). A cache
// hit short-circuits straight past all of that logic - `cacheGif` returns the
// existing entry immediately without re-resolving or re-analyzing anything - so a
// bad entry written by an old version would otherwise sit there being served forever.
// Renaming the storage key means everyone updating starts with a clean cache instead.
const MEDIA_CACHE_KEY = "GifFolders_media_cache_v2"; // legacy single-blob key - see the migration in init() below
// Each cached entry gets its own DataStore key under this prefix now, instead
// of the old scheme of one giant object living under MEDIA_CACHE_KEY. See the
// chat investigation this follows on from: a cache that had grown to ~600MB
// meant every single persistMediaCache() call - which used to fire on every
// single saved/cached GIF - re-serialized and rewrote the *entire* blob, in a
// shared IndexedDB store Vencord's own DataStore docs explicitly warn not to
// put multi-MB objects into. One newly cached GIF now costs one small write,
// not a rewrite of everything ever cached.
const MEDIA_CACHE_PREFIX = "GifFolders_media_cache_entry_v1:";
const REMEMBERED_WIDTH_KEY = "GifFolders_remembered_width_v1";
const REMEMBERED_HEIGHT_KEY = "GifFolders_remembered_height_v1";
const DEFAULT_FOLDERS = ["Favorites 1", "Favorites 2"];
const RESTART_INTERVAL_MS = 4000;
// Mirrors native.ts's own MAX_BYTES - kept as two separate constants since
// they run in different processes, but they should always agree.
const MAX_CACHED_BYTES = 20 * 1024 * 1024;
// Total cache budget across every entry combined - without this the cache has
// no ceiling at all and just keeps growing for as long as the plugin's in
// use, which is how it reached ~600MB in the first place. Oldest-cached
// entries are evicted first (see evictOldMediaCacheEntries) once a new entry
// would push the total over this. A saved GIF that gets evicted isn't lost -
// just its local copy is - it falls back to re-fetching from its live link
// next time it's viewed, exactly like any never-cached GIF already does.
// Fallback only - see the maxCacheSize setting and getMaxTotalCacheBytes() for
// the value actually used. Kept as a real cap (not Infinity) so a corrupted or
// pre-update settings value can't accidentally mean "unbounded" by default.
const DEFAULT_MAX_TOTAL_CACHE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// In-memory caches kept in sync with DataStore so context menus (which re-run their
// builder function every time they're opened) always read fresh data synchronously.
let cache: FolderMap = {};
let mediaCache: Record<string, MediaCacheEntry> = {};
// Tracks which entries have already had a touched cachedAt persisted this
// session, so re-viewing the same folder repeatedly doesn't write on every
// single hit - see touchMediaCacheEntry.
const touchedThisSession = new Set<string>();
// The modal's width/height as of the last manual resize or (for width only)
// setting-driven recompute (see ManagerModal's width/height effects) - null
// until the modal's been resized at least once along that axis. Read once
// when the modal opens; not itself reactive, since it's a starting point for
// that one moment, not something the modal should keep re-snapping to while
// already open.
let rememberedWidth: number | null = null;
let rememberedHeight: number | null = null;
let ready = false;
const listeners = new Set<() => void>();
const inFlightFetches = new Map<string, Promise<string | null>>();

// Some Discord clients' Content-Security-Policy allows loading media via <img>/
// <video> (img-src/media-src) but blocks fetch()/XHR to the same origins entirely
// (connect-src) - in that environment every single cacheGif() call fails at the
// network level (a plain TypeError, before any response, even for Discord's own CDN),
// no matter the URL. Retrying that per-file, forever, both spams the console for
// every saved GIF on every plugin start and wastes time on a request that cannot
// succeed. Once we've seen enough consecutive network-level failures to conclude
// this is a systemic block rather than a one-off/per-file issue, stop attempting
// further fetches for the rest of the session; GIFs still display and play fine via
// their live links either way, this only affects local caching.
const FETCH_FAILURE_THRESHOLD = 5;
let consecutiveFetchFailures = 0;
let fetchCircuitOpen = false;

function notify() {
    listeners.forEach(cb => cb());
}

// ---------- Small utilities ----------

function makeId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hashUrl(url: string): string {
    // Not cryptographic - just a stable, compact cache key.
    let h = 5381;
    for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
}

function defaultNameFromUrl(url: string): string {
    try {
        const u = new URL(url);
        const last = u.pathname.split("/").filter(Boolean).pop();
        if (!last) return "GIF";
        try {
            return decodeURIComponent(last);
        } catch {
            return last;
        }
    } catch {
        return "GIF";
    }
}

// Discord attachment IDs and opaque hash-like slugs make bad default names (e.g. a
// share link's resolved media filename is usually far more descriptive than the
// share link's own path). Reject those so we can prefer the more readable candidate.
function looksLikeGoodName(name: string): boolean {
    const withoutExt = name.replace(/\.[a-z0-9]+$/i, "");
    if (!withoutExt || /^\d+$/.test(withoutExt)) return false;
    if (withoutExt.length < 3) return false;
    return true;
}

function bestDefaultName(shareSrc: string, mediaSrc: string): string {
    const fromMedia = defaultNameFromUrl(mediaSrc);
    if (looksLikeGoodName(fromMedia)) return fromMedia;
    const fromShare = defaultNameFromUrl(shareSrc);
    if (looksLikeGoodName(fromShare)) return fromShare;
    return fromMedia || fromShare || "GIF";
}

// ---------- Persistence ----------

async function loadCache() {
    try {
        let stored = await DataStore.get<FolderMap>(DATA_KEY);

        if (!stored) {
            // Migrate from the v2 format (originalSrc/src did double duty as both the
            // share link and the preview media url - the source of the "posts the raw
            // proxy link" and "no favorite star" bugs). Treat both as the share link;
            // a fresh save will properly split them going forward.
            const v2 = await DataStore.get<Record<string, Array<{ id: string; src: string; originalSrc: string; name: string; addedAt: number; }>>>(DATA_KEY_V2);
            if (v2 && Object.keys(v2).length > 0) {
                const migrated: FolderMap = {};
                for (const [folder, entries] of Object.entries(v2)) {
                    migrated[folder] = entries.map(e => ({
                        id: e.id,
                        shareSrc: e.originalSrc,
                        mediaSrc: e.originalSrc,
                        name: e.name,
                        addedAt: e.addedAt
                    }));
                }
                stored = migrated;
                await DataStore.set(DATA_KEY, stored);
            } else {
                // Migrate from the oldest (string[]) format used by the very first version.
                const v1 = await DataStore.get<Record<string, string[]>>(OLD_DATA_KEY);
                if (v1 && Object.keys(v1).length > 0) {
                    const migrated: FolderMap = {};
                    for (const [folder, urls] of Object.entries(v1)) {
                        migrated[folder] = urls.map(src => ({
                            id: makeId(),
                            shareSrc: src,
                            mediaSrc: src,
                            name: defaultNameFromUrl(src),
                            addedAt: Date.now()
                        }));
                    }
                    stored = migrated;
                    await DataStore.set(DATA_KEY, stored);
                }
            }
        }

        if (stored && Object.keys(stored).length > 0) {
            cache = stored;
        } else {
            cache = {};
            for (const name of DEFAULT_FOLDERS) cache[name] = [];
            await DataStore.set(DATA_KEY, cache);
        }
    } catch (e) {
        logger.error("Failed to load GIF folders from DataStore", e);
        cache = {};
        for (const name of DEFAULT_FOLDERS) cache[name] = [];
    }

    try {
        const allKeys = await DataStore.keys<string>();
        const ownKeys = allKeys.filter((k): k is string => typeof k === "string" && k.startsWith(MEDIA_CACHE_PREFIX));

        if (ownKeys.length > 0) {
            const values = await DataStore.getMany<MediaCacheEntry>(ownKeys);
            mediaCache = {};
            ownKeys.forEach((k, i) => {
                const value = values[i];
                if (value) mediaCache[k.slice(MEDIA_CACHE_PREFIX.length)] = value;
            });
        } else {
            // Nothing under the new per-entry scheme yet - either a fresh
            // install, or a returning one that hasn't migrated off the old
            // single-blob key. One-time migration: adopt it if present, write
            // it out under the new scheme, then remove the old key so this
            // branch is never taken again after tonight.
            const legacyBlob = await DataStore.get<Record<string, MediaCacheEntry>>(MEDIA_CACHE_KEY);
            if (legacyBlob && Object.keys(legacyBlob).length > 0) {
                mediaCache = legacyBlob;
                await persistMediaCacheEntries(Object.keys(mediaCache));
                await DataStore.del(MEDIA_CACHE_KEY);
            } else {
                mediaCache = {};
            }
        }
    } catch (e) {
        logger.error("Failed to load GIF media cache from DataStore", e);
        mediaCache = {};
    }

    try {
        const stored = await DataStore.get<number>(REMEMBERED_WIDTH_KEY);
        rememberedWidth = typeof stored === "number" && stored > 0 ? stored : null;
    } catch (e) {
        logger.error("Failed to load GIF Folders remembered width from DataStore", e);
        rememberedWidth = null;
    }

    try {
        const storedHeight = await DataStore.get<number>(REMEMBERED_HEIGHT_KEY);
        rememberedHeight = typeof storedHeight === "number" && storedHeight > 0 ? storedHeight : null;
    } catch (e) {
        logger.error("Failed to load GIF Folders remembered height from DataStore", e);
        rememberedHeight = null;
    }

    ready = true;
    notify();
}

async function persist() {
    try {
        await DataStore.set(DATA_KEY, cache);
    } catch (e) {
        logger.error("Failed to save GIF folders to DataStore", e);
        showToast("Couldn't save GIF folders — see console for details", Toasts.Type.FAILURE);
    }
    notify();
}

function mediaCacheStoreKey(key: string): string {
    return MEDIA_CACHE_PREFIX + key;
}

async function persistMediaCacheEntries(keys: Iterable<string>) {
    const pairs: [string, MediaCacheEntry][] = [];
    for (const key of new Set(keys)) {
        const entry = mediaCache[key];
        if (entry) pairs.push([mediaCacheStoreKey(key), entry]);
    }
    if (pairs.length === 0) return;
    try {
        await DataStore.setMany(pairs);
    } catch (e) {
        logger.error("Failed to save GIF media cache entries to DataStore", e);
    }
}

async function deleteMediaCacheEntries(keys: Iterable<string>) {
    const storeKeys = Array.from(new Set(keys), mediaCacheStoreKey);
    if (storeKeys.length === 0) return;
    try {
        await DataStore.delMany(storeKeys);
    } catch (e) {
        logger.error("Failed to delete GIF media cache entries from DataStore", e);
    }
}

/** Parses the maxCacheSize setting into a byte count, defensively - a stale
 * localStorage value from before "Unlimited" existed, or any other
 * unrecognised string, falls back to a real number rather than silently
 * becoming unbounded. */
function getMaxTotalCacheBytes(): number {
    const raw = settings.store.maxCacheSize;
    if (raw === "unlimited") return Infinity;
    const mb = Number(raw);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_MAX_TOTAL_CACHE_BYTES;
}

/**
 * Evicts the least-recently-cached entries (oldest cachedAt first) until
 * adding incomingBytes more would fit under the current cache budget. Only
 * touches the in-memory cache and any live blob URL for each evicted entry -
 * returns the evicted keys so the caller can delete their DataStore rows too.
 * "Oldest" is meaningful here specifically because touchMediaCacheEntry below
 * keeps cachedAt current for anything actually still in use.
 */
function evictOldMediaCacheEntries(incomingBytes: number): string[] {
    const budget = getMaxTotalCacheBytes();
    let total = Object.values(mediaCache).reduce((sum, e) => sum + e.size, 0) + incomingBytes;
    if (total <= budget) return [];

    const byOldest = Object.keys(mediaCache).sort((a, b) => mediaCache[a].cachedAt - mediaCache[b].cachedAt);
    const evicted: string[] = [];
    for (const key of byOldest) {
        if (total <= budget) break;
        total -= mediaCache[key].size;
        releaseBlobUrl(key);
        delete mediaCache[key];
        evicted.push(key);
    }
    return evicted;
}

/**
 * Refreshes cachedAt on a cache *hit*, not just on first download. Without
 * this, cachedAt only ever meant "first downloaded", so eviction was
 * effectively FIFO by first-seen order, not LRU - a folder you opened once,
 * long ago, would always look "oldest" and get evicted to make room for
 * whatever folder you opened most recently, even if you'd just revisited that
 * old folder five seconds ago. That's what was causing the cache to visibly
 * oscillate when switching between folders: opening folder B would evict
 * folder A's entries (since they were literally cached earlier), then
 * re-opening A would re-cache and evict B's, forever. Only actually re-persists
 * at most once per entry per session - cheap enough in memory to update on
 * every hit, but not worth a DataStore write every single time a tile mounts.
 */
function touchMediaCacheEntry(key: string) {
    const entry = mediaCache[key];
    if (!entry) return;
    entry.cachedAt = Date.now();
    if (!touchedThisSession.has(key)) {
        touchedThisSession.add(key);
        void persistMediaCacheEntries([key]);
    }
}

async function persistRememberedWidth(width: number) {
    rememberedWidth = width;
    try {
        await DataStore.set(REMEMBERED_WIDTH_KEY, width);
    } catch (e) {
        logger.error("Failed to save GIF Folders remembered width to DataStore", e);
    }
}

async function persistRememberedHeight(height: number) {
    rememberedHeight = height;
    try {
        await DataStore.set(REMEMBERED_HEIGHT_KEY, height);
    } catch (e) {
        logger.error("Failed to save GIF Folders remembered height to DataStore", e);
    }
}

// ---------- Folder / GIF data operations ----------

function getFolderNames() {
    return Object.keys(cache);
}

function foldersContaining(shareSrc: string) {
    return getFolderNames().filter(name => cache[name].some(g => g.shareSrc === shareSrc));
}

function findEntry(folder: string, id: string): GifEntry | undefined {
    return cache[folder]?.find(g => g.id === id);
}

async function createFolder(name: string): Promise<boolean> {
    name = name.trim();
    if (!name || cache[name]) return false;
    cache[name] = [];
    await persist();
    return true;
}

async function renameFolder(oldName: string, newName: string): Promise<boolean> {
    newName = newName.trim();
    if (!newName || cache[newName] || !cache[oldName]) return false;
    cache[newName] = cache[oldName];
    delete cache[oldName];
    await persist();
    return true;
}

async function deleteFolder(name: string) {
    delete cache[name];
    await persist();
}

async function saveGifToFolder(folder: string, shareSrc: string, mediaSrc?: string) {
    if (!cache[folder]) cache[folder] = [];
    if (cache[folder].some(g => g.shareSrc === shareSrc)) {
        showToast(`Already in "${folder}"`, Toasts.Type.MESSAGE);
        return;
    }
    const resolvedMediaSrc = mediaSrc ?? shareSrc;
    const entry: GifEntry = {
        id: makeId(),
        shareSrc,
        mediaSrc: resolvedMediaSrc,
        name: bestDefaultName(shareSrc, resolvedMediaSrc),
        addedAt: Date.now()
    };
    cache[folder].unshift(entry);
    await persist();
    showToast(`Saved GIF to "${folder}"`, Toasts.Type.SUCCESS);
    // Warm the cache right away so it's instant next time the folder is opened.
    cacheGif(resolvedMediaSrc);
}

async function removeGifFromFolder(folder: string, id: string) {
    if (!cache[folder]) return;
    cache[folder] = cache[folder].filter(g => g.id !== id);
    await persist();
    showToast(`Removed GIF from "${folder}"`, Toasts.Type.MESSAGE);
}

async function renameGifEntry(folder: string, id: string, newName: string) {
    const entry = findEntry(folder, id);
    if (!entry) return;
    const trimmed = newName.trim();
    if (!trimmed) return;
    entry.name = trimmed;
    await persist();
}

/** Moves the dragged entry to take the dropped-on entry's position, shifting the rest. */
async function reorderGifInFolder(folder: string, draggedId: string, targetId: string) {
    const list = cache[folder];
    if (!list || draggedId === targetId) return;
    const fromIndex = list.findIndex(g => g.id === draggedId);
    const toIndex = list.findIndex(g => g.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await persist();
}

/**
 * Discord's own signed CDN links expire (they carry an ex=/is=/hm= signature with a
 * preset expiry), and once expired they 404 - even though the underlying attachment
 * is still there, since Discord's client transparently reissues a fresh signature
 * whenever it renders one of its own links itself. Our saved entries are a snapshot
 * of whatever URL was current the moment they were saved, so old ones eventually go
 * stale. When a fresh signature is obtained (see refreshAttachmentUrl below), swap it
 * into the stored entry so this doesn't need to happen again until the new one also
 * expires. oldUrl is checked before overwriting in case the entry already changed
 * (e.g. a concurrent refresh) between when the stale value was read and now.
 */
async function refreshEntryMediaUrl(folder: string, id: string, oldUrl: string, freshUrl: string) {
    const entry = findEntry(folder, id);
    if (!entry) return;
    let changed = false;
    if (entry.mediaSrc === oldUrl) { entry.mediaSrc = freshUrl; changed = true; }
    // shareSrc (used for "Copy Link" and re-sending into chat) is very often the
    // exact same link for plain attachments - see GifEntry's docs - so keep it in
    // sync too, otherwise those actions would keep handing out the dead old link.
    if (entry.shareSrc === oldUrl) { entry.shareSrc = freshUrl; changed = true; }
    if (changed) await persist();
}

async function moveGifToFront(folder: string, id: string) {
    const list = cache[folder];
    if (!list) return;
    const idx = list.findIndex(g => g.id === id);
    if (idx <= 0) return;
    const [item] = list.splice(idx, 1);
    list.unshift(item);
    await persist();
    showToast(`Moved to the front of "${folder}"`, Toasts.Type.SUCCESS);
}

async function moveGifToBack(folder: string, id: string) {
    const list = cache[folder];
    if (!list) return;
    const idx = list.findIndex(g => g.id === id);
    if (idx === -1 || idx === list.length - 1) return;
    const [item] = list.splice(idx, 1);
    list.push(item);
    await persist();
    showToast(`Moved to the back of "${folder}"`, Toasts.Type.SUCCESS);
}

/**
 * Relocates an existing entry from one folder to another, preserving its id,
 * custom name, and addedAt - unlike saveGifToFolder, which always mints a
 * fresh entry. Checked against the destination for a shareSrc duplicate
 * *before* splicing out of the source, so a blocked move leaves the entry
 * exactly where it was rather than deleting it out of fromFolder with
 * nowhere for it to land.
 */
async function moveGifToFolder(fromFolder: string, toFolder: string, id: string) {
    const list = cache[fromFolder];
    if (!list || fromFolder === toFolder) return;
    const idx = list.findIndex(g => g.id === id);
    if (idx === -1) return;

    if (!cache[toFolder]) cache[toFolder] = [];
    if (cache[toFolder].some(g => g.shareSrc === list[idx].shareSrc)) {
        showToast(`Already in "${toFolder}"`, Toasts.Type.MESSAGE);
        return;
    }

    const [item] = list.splice(idx, 1);
    cache[toFolder].unshift(item);
    await persist();
    showToast(`Moved to "${toFolder}"`, Toasts.Type.SUCCESS);
}

function searchAllFolders(query: string): Array<{ folder: string; entry: GifEntry; }> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: Array<{ folder: string; entry: GifEntry; }> = [];
    for (const folder of getFolderNames()) {
        for (const entry of cache[folder]) {
            if (entry.name.toLowerCase().includes(q)) results.push({ folder, entry });
        }
    }
    return results;
}

// ---------- GIF URL detection & resolution ----------
//
// Three distinct problems live in this section:
//
// 1. Some "GIF" links right-clicked in chat are actually share/page URLs, not media
//    (e.g. tenor.com/view/... is an HTML page, not an image). Rendering that as
//    <img src="..."> produces the empty-square/broken-image icon.
// 2. Some GIF embeds are actually served to the client as a video - mp4, webm, or
//    increasingly mov/m4v/mkv from phone recordings (Discord transcodes many Tenor/
//    Giphy "gifs" to video for bandwidth too) - putting a video URL into an <img>
//    tag will never render, for the same broken-image reason.
// 3. The resolved, actual, playable media URL (from #1/#2's fix) is very often an
//    internal Discord proxy link. It's exactly what we need for OUR OWN preview, but
//    posting that same link back into chat is a regression: Discord doesn't recognise
//    it as a "clean" embeddable link (so the raw link text shows above the embed) and
//    it breaks the native Tenor/Giphy hover-to-favorite star for people without this
//    plugin. The fix is to never conflate "what to preview" with "what to (re)share" -
//    see the shareSrc / mediaSrc split on GifEntry above.

const MediaExtRegex = /\.(gif|webp|png|jpe?g|mp4|webm|mov|m4v|avi|mkv)(?:$|\?)/i;
const GifExtRegex = /\.gif(?:$|\?)/i;
const WebpExtRegex = /\.webp(?:$|\?)/i;
// Kept in sync with the video half of MediaExtRegex above - anything added there
// for a new video container belongs here too, and vice versa.
const VideoExtRegex = /\.(mp4|webm|mov|m4v|avi|mkv)(?:$|\?)/i;
// Only the containers/codecs worth distinguishing by exact mimeType when picking an
// export extension (see deriveExportFilename) - anything else falls back to the
// URL-pattern guess via VideoExtRegex instead.
const VIDEO_MIME_TO_EXT: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "video/x-m4v": ".m4v",
    "video/x-msvideo": ".avi",
    "video/x-matroska": ".mkv"
};
const GifHostRegex = /^(.+?\.)?(tenor|giphy|imgur)\.com$/i;

const DIRECT_MEDIA_HOSTS = [
    /(^|\.)media\.discordapp\.net$/i,
    /(^|\.)cdn\.discordapp\.com$/i,
    /(^|\.)discordapp\.net$/i,
    /(^|\.)tenor\.com$/i,
    /(^|\.)giphy\.com$/i,
    /(^|\.)imgur\.com$/i
];

function isKnownPageUrl(u: URL): boolean {
    const host = u.hostname.toLowerCase();
    // tenor.com/view/... and giphy.com/gifs/... are share pages (HTML), not media.
    if (host === "tenor.com" && u.pathname.startsWith("/view/")) return true;
    if (host === "giphy.com" && u.pathname.startsWith("/gifs/")) return true;
    // imgur.com/xyz (no file extension) is a page; i.imgur.com/xyz.gif is direct media.
    if (host === "imgur.com" && !MediaExtRegex.test(u.pathname)) return true;
    return false;
}

function isDirectMediaUrl(url?: string | null): boolean {
    if (!url) return false;
    try {
        const u = new URL(url);
        if (isKnownPageUrl(u)) return false;
        if (MediaExtRegex.test(u.pathname)) return true;
        if (u.searchParams.get("format") === "gif") return true;
        if (DIRECT_MEDIA_HOSTS.some(r => r.test(u.hostname)) && u.pathname.includes("/attachments/")) return true;
        return false;
    } catch {
        return MediaExtRegex.test(url);
    }
}

function isDiscordCdnUrl(url: string): boolean {
    try {
        return /(^|\.)discordapp\.(?:com|net)$/i.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

/**
 * True for a genuine Discord message-attachment link (as opposed to a third-party
 * GIF provider like Tenor/Giphy/Klipy, or other Discord-hosted content like an
 * emoji). Discord only shows the favorite star and hides the raw link text for
 * content it recognizes as coming from a GIF provider - a plain attachment link
 * gets neither, no matter how it's sent. That part can't be changed client-side,
 * but re-uploading the bytes as a brand new attachment (see sendAsFreshAttachment)
 * at least avoids the visible "📎 filename" reference text a *link* to an
 * attachment shows, since a freshly attached file shows no text above it at all.
 */
function isDiscordAttachmentUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return /(^|\.)discordapp\.(?:com|net)$/i.test(u.hostname) && u.pathname.includes("/attachments/");
    } catch {
        return false;
    }
}

// Discord's own client transparently reissues a fresh signature whenever it renders
// one of its own (expired) CDN links itself, via this same endpoint - see
// https://docs.discord.food/reference#refresh-attachment-urls. Batches concurrent
// calls into as few actual requests as possible, since opening a folder full of
// long-stale links can mean dozens of tiles asking to refresh within the same
// instant.
const REFRESH_BATCH_DELAY_MS = 250;
const REFRESH_BATCH_MAX = 25; // chunk defensively rather than sending everything in one request
let pendingRefreshes: Array<{ url: string; resolve: (fresh: string | null) => void; }> = [];
let refreshFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushRefreshBatch() {
    refreshFlushTimer = null;
    const batch = pendingRefreshes;
    pendingRefreshes = [];
    if (batch.length === 0) return;

    for (let i = 0; i < batch.length; i += REFRESH_BATCH_MAX) {
        const chunk = batch.slice(i, i + REFRESH_BATCH_MAX);
        try {
            const res = await RestAPI.post({
                url: "/attachments/refresh-urls",
                body: { attachment_urls: chunk.map(c => c.url) }
            });
            const refreshed: Array<{ original: string; refreshed: string; }> = res?.body?.refreshed_urls ?? [];
            const byOriginal = new Map(refreshed.map(r => [r.original, r.refreshed]));
            for (const { url, resolve } of chunk) resolve(byOriginal.get(url) ?? null);
        } catch (e) {
            logger.warn("Couldn't refresh expired Discord attachment URLs", e);
            for (const { resolve } of chunk) resolve(null);
        }
    }
}

/**
 * Asks Discord to reissue a fresh signed URL for a link that's failed to load.
 * Resolves to null (rather than throwing) for anything not worth trying - a non-
 * Discord-CDN URL, or a refresh attempt that itself fails, most likely because the
 * underlying attachment or message is actually gone rather than just the signature
 * being expired.
 */
function refreshAttachmentUrl(url: string): Promise<string | null> {
    if (!isDiscordCdnUrl(url)) return Promise.resolve(null);
    return new Promise(resolve => {
        pendingRefreshes.push({ url, resolve });
        if (!refreshFlushTimer) refreshFlushTimer = setTimeout(flushRefreshBatch, REFRESH_BATCH_DELAY_MS);
    });
}

/**
 * Re-uploads a Discord-attachment-sourced GIF's bytes as a brand new attachment on
 * the outgoing message, instead of sending a link to the original one. A link to an
 * existing attachment renders with a visible "📎 filename" reference above it; a
 * freshly attached file on the message itself renders with nothing above it at all.
 * Uses a direct multipart/form-data POST (payload_json + files[0]) per Discord's
 * public API docs, rather than the internal CloudUpload flow Discord's own chat bar
 * uses - that's undocumented and has broken other Vencord plugins before when
 * Discord changed it internally, whereas this shape is the same one bots/webhooks
 * use and isn't going anywhere. Resolves false (never rejects) if anything about
 * this doesn't work out, so the caller can cleanly fall back to a normal link send.
 */
async function sendAsFreshAttachment(
    channelId: string,
    entry: GifEntry,
    replyReference: { message_id: string; channel_id: string; guild_id: string | undefined; } | null,
    allowedMentions: { parse: string[]; replied_user: boolean; }
): Promise<boolean> {
    try {
        let cached = getCacheEntry(entry.mediaSrc);
        if (!cached) {
            await cacheGif(entry.mediaSrc, true);
            cached = getCacheEntry(entry.mediaSrc);
        }
        if (!cached) return false;

        const blob = dataUrlToBlob(cached.dataUrl);
        if (!blob) return false;

        const genericVideoExt = videoUrlExt(entry.mediaSrc);
        let filename = "gif" + (WebpExtRegex.test(entry.mediaSrc) ? ".webp" : GifExtRegex.test(entry.mediaSrc) ? ".gif" : genericVideoExt ? `.${genericVideoExt}` : ".mp4");
        try {
            const lastSegment = new URL(entry.mediaSrc).pathname.split("/").pop();
            if (lastSegment) filename = decodeURIComponent(lastSegment);
        } catch { /* keep the generic fallback name */ }

        const payload: Record<string, unknown> = {
            content: "",
            attachments: [{ id: "0", filename }]
        };
        if (replyReference) {
            payload.message_reference = replyReference;
            payload.allowed_mentions = allowedMentions;
        }

        const formData = new FormData();
        formData.append("payload_json", JSON.stringify(payload));
        formData.append("files[0]", blob, filename);

        await RestAPI.post({ url: `/channels/${channelId}/messages`, body: formData });
        return true;
    } catch (e) {
        logger.warn("Couldn't send as a fresh attachment, falling back to a link", e);
        return false;
    }
}

function isGifUrl(url?: string | null): boolean {
    if (!url) return false;
    try {
        const u = new URL(url);
        if (GifExtRegex.test(u.pathname)) return true;
        if (GifHostRegex.test(u.hostname)) return true;
        if (u.searchParams.get("format") === "gif") return true;
        return false;
    } catch {
        return GifExtRegex.test(url);
    }
}

/** The matched video extension (lowercase, no dot) for a URL recognised by
 * VideoExtRegex, or null if it isn't one - used wherever the *specific* format
 * matters (e.g. picking an export extension), not just "is this a video". */
function videoUrlExt(url?: string | null): string | null {
    if (!url) return null;
    let path = url;
    try { path = new URL(url).pathname; } catch { /* fall back to the raw url as-is */ }
    return VideoExtRegex.exec(path)?.[1]?.toLowerCase() ?? null;
}

function isVideoUrl(url?: string | null): boolean {
    return videoUrlExt(url) !== null;
}

// Discord's own renderer appends necessary display-time query params - size, and
// crucially for attachments Discord has transcoded to WebP, `animated=true` - when
// it sets the actual DOM <img>'s src. The bare url/proxy_url fields on the
// message's attachment/embed objects don't carry those params: they're computed by
// Discord's rendering layer for this specific display, not stored on the message
// data itself. Fetching the bare link can silently return a static single-frame
// rendition of a file that's actually animated - the "shows one frame, never
// animates" bug - so whenever the DOM src is clearly just a richer (same
// origin+path, with extra query params) version of the same resource, prefer it.
function preferDomVariant(domSrc: string | undefined, baseUrl: string | null | undefined): string | null {
    if (!domSrc || !baseUrl) return null;
    try {
        const domUrl = new URL(domSrc);
        const base = new URL(baseUrl);
        if (domUrl.origin === base.origin && domUrl.pathname === base.pathname && isDirectMediaUrl(domSrc)) {
            return domSrc;
        }
    } catch { /* not a valid absolute URL - fall through to the base url */ }
    return null;
}

/**
 * The subset of a context-menu callback's `props` this plugin actually reads, across
 * the message/image/video right-click menus it patches (isAnyGifLike and the three
 * patches below). Not an official Discord type - the object varies by which menu it
 * came from, and Discord's own message/embed/attachment shapes aren't covered by
 * @vencord/discord-types for this internal, per-menu "extra props" object, which is
 * why NavContextMenuPatchCallback's own `props` parameter is loosely typed to begin
 * with. This just documents, and gets autocomplete/typo-checking on, the handful of
 * fields actually read here - every field stays optional/string rather than claiming
 * precision this can't verify.
 */
interface GifSourceMedia {
    url?: string;
    proxyURL?: string;
}
interface GifSourceEmbed {
    type?: string;
    url?: string;
    video?: GifSourceMedia;
    image?: GifSourceMedia;
    thumbnail?: GifSourceMedia;
}
interface GifSourceAttachment {
    url?: string;
    proxy_url?: string;
    content_type?: string;
}
interface GifSourceMessage {
    attachments?: GifSourceAttachment[];
    embeds?: GifSourceEmbed[];
}
interface GifContextMenuProps {
    itemSrc?: string;
    itemHref?: string;
    itemOriginal?: string;
    original?: string;
    src?: string;
    href?: string;
    message?: GifSourceMessage;
}

// The one place the real, direct, playable media URL reliably lives (for a pasted
// share link) is the message's own embed/attachment data, which the context menu
// hands us via props.message. `hint` is the share link we already resolved, used to
// find the matching embed/attachment when a message has more than one.
function resolveFromMessageEmbeds(props: GifContextMenuProps, hint: string | null): string | null {
    const message = props?.message;
    if (!message) return null;

    const domSrc: string | undefined = props?.itemSrc ?? props?.src;

    const attachments = message.attachments ?? [];
    const attachment =
        attachments.find(a => [a.url, a.proxy_url].includes(domSrc) || (hint && [a.url, a.proxy_url].includes(hint)))
        ?? (attachments.length === 1 ? attachments[0] : undefined);
    if (attachment) {
        // Pulled into a local var (rather than re-reading attachment.url below) so
        // it's unambiguously `string | null` everywhere it's used, matching this
        // function's own return type exactly.
        const attachmentUrl = attachment.url ?? null;
        const richer = preferDomVariant(domSrc, attachmentUrl);
        if (richer) return richer;
        if (isDirectMediaUrl(attachmentUrl)) return attachmentUrl;
    }

    // embed.url is the share PAGE (e.g. the tenor.com/view/... link); the actual
    // playable resource lives on embed.video / embed.image / embed.thumbnail instead.
    const embeds = message.embeds ?? [];
    let embed = embeds.find(e =>
        e.url === hint || e.url === domSrc ||
        [e.video, e.image, e.thumbnail].some(m => m && [m.url, m.proxyURL].some(u => u === domSrc || u === hint))
    );
    if (!embed) embed = embeds.find(e => e.type === "gifv" || e.type === "image") ?? (embeds.length === 1 ? embeds[0] : undefined);

    const media = embed?.video ?? embed?.image ?? embed?.thumbnail;
    const mediaUrl = media?.proxyURL ?? media?.url ?? null;
    return preferDomVariant(domSrc, mediaUrl) ?? mediaUrl;
}

// The canonical, publicly-shareable link - always prefer an actual href/link prop,
// since that's what preserves Discord's native embed treatment when reposted. Only
// fall back to the rendered resource's own src when no separate link exists at all
// (e.g. plain attachments, where the "link" and the "media" are the same thing).
function resolveShareUrl(props: GifContextMenuProps): string | null {
    const linkCandidates = [props?.itemHref, props?.href]
        .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (linkCandidates.length > 0) return linkCandidates[0];

    const embeds = props?.message?.embeds ?? [];
    // Pulled into a local var first rather than narrowing through embeds[0]?.url
    // directly, so the typeof check below is unambiguous.
    const firstEmbedUrl = embeds.length === 1 ? embeds[0]?.url : undefined;
    if (typeof firstEmbedUrl === "string" && firstEmbedUrl) return firstEmbedUrl;

    const srcCandidates = [props?.itemSrc, props?.src]
        .filter((v): v is string => typeof v === "string" && v.length > 0);
    return srcCandidates[0] ?? null;
}

// The actual playable asset, for OUR OWN preview/caching only - see the big comment
// block above. Never used for chat insertion/sending.
function resolveMediaUrl(props: GifContextMenuProps, shareUrl: string | null): string | null {
    const fromEmbed = resolveFromMessageEmbeds(props, shareUrl);
    if (fromEmbed) return fromEmbed;

    const candidates = [props?.itemSrc, props?.itemOriginal, props?.original, props?.itemHref, props?.src, props?.href]
        .filter((v): v is string => typeof v === "string" && v.length > 0);
    const seen = new Set<string>();
    const unique = candidates.filter(c => (seen.has(c) ? false : (seen.add(c), true)));

    return unique.find(isDirectMediaUrl) ?? shareUrl ?? unique[0] ?? null;
}

// ---------- Local media cache (instant loads + resilience to expired/dead links) ----------

function getCachedSrc(mediaSrc: string): string | null {
    const entry = mediaCache[hashUrl(mediaSrc)];
    return entry ? entry.dataUrl : null;
}

function getCacheEntry(mediaSrc: string): MediaCacheEntry | null {
    return mediaCache[hashUrl(mediaSrc)] ?? null;
}

// In-memory only, never persisted: blob: URLs derived on demand from the durably
// stored base64 data. We deliberately don't feed the data: URI straight into <img>/
// <video> - Chromium's animated-image decoder does not reliably animate certain
// formats (notably animated WebP, which Discord attachments use a lot) when the
// resource is a data: URI, even though the exact same bytes animate perfectly fine
// from a blob: URL or a normal network fetch. Blob URLs behave exactly like a normal
// fetched resource for every purpose, including animation - they just don't survive
// a full client restart, which is fine since we regenerate them from the persisted
// base64 data every time the plugin loads.
//
// Each entry also remembers which "restart tick" (see GifTile) it was minted for.
// createObjectURL() always returns a brand new opaque URL, even for byte-identical
// content, and a genuinely new URL is exactly what's needed to force Chromium to
// treat a restart as a fresh, independently-decoded resource rather than reattaching
// to whatever frame an animation that already finished its native loop count was
// left on - reusing the same blob: URL string (as before) doesn't reliably do that.
const blobUrlCache = new Map<string, { tick: number; url: string; }>();

function dataUrlToBlob(dataUrl: string): Blob | null {
    try {
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx === -1) return null;
        const header = dataUrl.slice(0, commaIdx);
        const base64 = dataUrl.slice(commaIdx + 1);
        const mimeMatch = /^data:(.*?);base64$/.exec(header);
        const mime = mimeMatch?.[1] || "application/octet-stream";

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    } catch {
        return null;
    }
}

function releaseBlobUrl(key: string) {
    const existing = blobUrlCache.get(key);
    if (existing) {
        URL.revokeObjectURL(existing.url);
        blobUrlCache.delete(key);
    }
}

/**
 * The URL GifTile should actually put in `src`. Returns null if nothing is cached yet.
 * `tick` is GifTile's restart counter - passing an incremented tick always mints a
 * fresh blob: URL; passing the same tick as last time reuses the existing one rather
 * than pointlessly recreating it on every unrelated re-render.
 */
function getPlayableSrc(mediaSrc: string, tick: number): string | null {
    const key = hashUrl(mediaSrc);
    const cached = mediaCache[key];
    if (!cached) return null;

    const existing = blobUrlCache.get(key);
    if (existing && existing.tick === tick) return existing.url;

    const blob = dataUrlToBlob(cached.dataUrl);
    if (!blob) return cached.dataUrl; // conversion failed - data: URI is still better than nothing

    if (existing) URL.revokeObjectURL(existing.url);
    const blobUrl = URL.createObjectURL(blob);
    blobUrlCache.set(key, { tick, url: blobUrl });
    return blobUrl;
}

// Reads just enough of a GIF's header to find its NETSCAPE2.0 loop-count extension,
// without needing a full GIF decoder. Per the GIF89a spec this extension (if present)
// always appears before the first image frame, so we only need to scan the file's
// preamble, not decode any actual frame data.
// Returns 0 for "loops forever", a positive number for "loops N times then stops",
// or null if it can't be determined (the caller treats that the same as "stops").
function getGifLoopCount(buffer: ArrayBufferLike): number | null {
    try {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) return null; // "GIF"

        let i = 6;
        const packed = bytes[i + 4];
        const gctFlag = (packed & 0x80) !== 0;
        const gctSize = gctFlag ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
        i += 7 + gctSize;

        const scanLimit = Math.min(bytes.length, i + 2000);
        while (i < scanLimit) {
            if (bytes[i] !== 0x21) break; // hit an image frame (or the end) - no loop extension appears after this

            const label = bytes[i + 1];
            if (label === 0xFF) {
                const size = bytes[i + 2];
                if (size === 11) {
                    let id = "";
                    for (let k = 0; k < 11; k++) id += String.fromCharCode(bytes[i + 3 + k]);
                    if (id === "NETSCAPE2.0") {
                        const sub = i + 3 + 11;
                        if (bytes[sub] === 3 && bytes[sub + 1] === 1) {
                            return bytes[sub + 2] | (bytes[sub + 3] << 8);
                        }
                    }
                }
                i += 3 + size;
                while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i];
                i += 1;
            } else if (label === 0xF9) {
                const size = bytes[i + 2];
                i += 3 + size + 1;
            } else {
                i += 2;
                while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i];
                i += 1;
            }
        }
        return null;
    } catch {
        return null;
    }
}

// Same idea as getGifLoopCount above, but for animated WebP's RIFF/ANIM container
// instead of GIF89a's NETSCAPE2.0 extension - Discord's CDN transcodes a lot of GIFs
// to animated WebP, and those inherit the exact same "stops after N loops, freezes
// on the last frame" behavior via the ANIM chunk's own loop-count field. Per the
// WebP spec ANIM must appear before any actual frame (ANMF) data, so this never
// needs to touch pixel data - just the leading chunk headers.
// Returns null when there's no ANIM chunk at all (a static WebP, or something
// malformed) - deliberately distinct from 0, which means "animated, loops forever".
function getWebpLoopCount(buffer: ArrayBufferLike): number | null {
    try {
        const bytes = new Uint8Array(buffer);
        if (bytes.length < 12) return null;
        const tag4 = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
        if (tag4(0) !== "RIFF" || tag4(8) !== "WEBP") return null;

        let i = 12;
        // ANIM always comes before any actual frame data, but it can still be preceded
        // by sizeable metadata chunks (e.g. an embedded ICC color profile can be several
        // KB), so scan generously rather than assuming ANIM lands in the first 4KB.
        const scanLimit = Math.min(bytes.length, 262144);
        while (i + 8 <= scanLimit) {
            const tag = tag4(i);
            const size = (bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)) >>> 0;
            const dataStart = i + 8;

            if (tag === "ANIM") {
                if (dataStart + 6 > bytes.length) return null;
                // 4 bytes background color, then a 2-byte loop count (LE); 0 = forever.
                return bytes[dataStart + 4] | (bytes[dataStart + 5] << 8);
            }

            i = dataStart + size + (size % 2); // chunks are padded to an even length
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * native.ts's exports are only reachable from here via Vencord's own IPC bridge, at
 * VencordNative.pluginHelpers.GifFolders - a dynamic, per-plugin key Vencord's
 * ambient types have no way to know about in advance, hence the one remaining `any`
 * in getNativeApi() below. The bridge also strips the (event) parameter every
 * native.ts export takes, since that's supplied by the bridge itself, never by
 * callers here - this interface reflects the shape actually callable from this
 * side, not native.ts's own function signatures. Every field is optional since the
 * whole object is undefined outright in the web/browser build (no main process for
 * native.ts to run in at all), and callers already check for that.
 */
interface NativeApi {
    downloadMedia(url: string): Promise<{ base64: string; mimeType: string; } | null>;
    pickExportFolder(): Promise<string | null>;
    exportGifFileBatch(basePath: string, items: Array<{ dirName: string; filename: string; base64: string; }>): Promise<{ written: number; skipped: number; }>;
}

/** Typed once, here, instead of an untyped cast at each call site. */
function getNativeApi(): Partial<NativeApi> | undefined {
    return (VencordNative as any)?.pluginHelpers?.GifFolders;
}

/**
 * Gets the raw bytes for a URL, preferring the native (Node.js main-process) helper
 * - see native.ts for why: it runs entirely outside the renderer's CSP, which is
 * what's actually blocking plain fetch() in some Discord clients. Falls back to the
 * renderer's own fetch() only when the native helper isn't available in this
 * environment at all (the web/browser build has no main process, so VencordNative's
 * plugin helpers for native.ts functions don't exist there) - deliberately NOT when
 * native is available but a specific download fails, since that's almost always a
 * real answer (dead link, timeout) rather than a reason to also try fetch(), which
 * would just throw on the same CSP native.ts exists to route around and needlessly
 * count toward the circuit breaker below for reasons that have nothing to do with
 * fetch() actually being blocked.
 */
async function downloadBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string; } | null> {
    const { downloadMedia } = getNativeApi() ?? {};
    if (downloadMedia) {
        try {
            const result = await downloadMedia(url);
            if (!result) return null;
            const binary = atob(result.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return { bytes, mimeType: result.mimeType };
        } catch (e) {
            logger.warn("Native download failed", url, e);
            return null;
        }
    }

    const res = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type };
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
    let binary = "";
    // Build the binary string in chunks - String.fromCharCode(...bytes) on a large
    // typed array can blow the call stack (each byte becomes a separate argument).
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
}

async function cacheGif(url: string, bypassCircuit = false): Promise<string | null> {
    if (!settings.store.enableCache) return null;
    if (fetchCircuitOpen && !bypassCircuit) return null;

    try {
        const u = new URL(url);
        if (isKnownPageUrl(u)) return null;
    } catch { /* relative/odd URL, let fetch decide */ }

    const key = hashUrl(url);
    if (mediaCache[key]) {
        touchMediaCacheEntry(key);
        return mediaCache[key].dataUrl;
    }

    const existing = inFlightFetches.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<string | null> => {
        try {
            let downloaded = await downloadBytes(url);
            if (!downloaded && isDiscordCdnUrl(url)) {
                // A download failure on a Discord CDN link could just as easily mean
                // an expired signature (see refreshAttachmentUrl) as a genuinely dead
                // attachment - a 404 looks the same either way, so it's always worth
                // one refresh-and-retry before giving up. This is what lets the
                // background warm-cache pass pick up long-stale entries on its own,
                // rather than only fixing them reactively once a tile is actually
                // viewed and errors.
                const fresh = await refreshAttachmentUrl(url);
                if (fresh) downloaded = await downloadBytes(fresh);
            }
            if (!downloaded) return null;
            const { bytes, mimeType } = downloaded;
            if (bytes.length === 0 || bytes.length > MAX_CACHED_BYTES) return null; // sanity guard

            const dataUrl = bytesToDataUrl(bytes, mimeType);

            // GIFs (as opposed to Discord's video-transcoded "gifs") can be encoded to
            // stop after a fixed number of loops, which is exactly the "plays once
            // then freezes on the last frame" bug - detect it once here so the tile
            // knows whether it needs to restart playback itself. Animated WebP (which
            // Discord's own CDN often transcodes GIFs into) has the exact same failure
            // mode via its own ANIM chunk's loop count, so it gets the same treatment.
            let loopsForever: boolean | undefined;
            if (mimeType === "image/gif" || GifExtRegex.test(url)) {
                try {
                    const loopCount = getGifLoopCount(bytes.buffer);
                    loopsForever = loopCount === 0;
                } catch {
                    loopsForever = undefined;
                }
            } else if (mimeType === "image/webp" || WebpExtRegex.test(url)) {
                try {
                    const loopCount = getWebpLoopCount(bytes.buffer);
                    // Only a confirmed loop count of 0 (infinite) counts as "safe to
                    // leave alone". Anything else - a positive count, or null because
                    // the ANIM chunk couldn't be found/parsed - is treated the same as
                    // the GIF branch above: assume it might stop and needs periodic
                    // restarts. Restarting a file that was actually static or already
                    // looping forever is harmless (a static image just re-renders
                    // identically), but skipping the restart on a finite-loop animated
                    // WebP leaves it frozen forever once its native loop count elapses -
                    // which is exactly the "looks like a static image" bug this guards
                    // against.
                    loopsForever = loopCount === 0;
                } catch {
                    loopsForever = false;
                }
            }

            releaseBlobUrl(key); // in case this is a re-cache (e.g. the user hit "retry"), don't keep serving stale bytes
            const evicted = evictOldMediaCacheEntries(bytes.length);
            mediaCache[key] = { dataUrl, cachedAt: Date.now(), size: bytes.length, loopsForever };
            consecutiveFetchFailures = 0;
            notify();
            void persistMediaCacheEntries([key]);
            if (evicted.length > 0) void deleteMediaCacheEntries(evicted);
            return dataUrl;
        } catch (e) {
            consecutiveFetchFailures++;
            if (!fetchCircuitOpen && consecutiveFetchFailures >= FETCH_FAILURE_THRESHOLD) {
                fetchCircuitOpen = true;
                logger.warn(
                    `Local caching looks unavailable in this Discord client (${FETCH_FAILURE_THRESHOLD} downloads in a row failed, across different domains). ` +
                    "GIFs will still display and play from their live links; pausing further cache attempts for the rest of this session to stop spamming the console. " +
                    "Tap a tile's \"Couldn't load - tap to retry\" (if any appear) to force a single fresh attempt.",
                );
            } else if (!fetchCircuitOpen) {
                logger.warn("Couldn't cache GIF (this is often just a CORS restriction - the GIF will still display, just won't be cached locally)", url, e);
            }
            return null;
        } finally {
            inFlightFetches.delete(key);
        }
    })();

    inFlightFetches.set(key, promise);
    return promise;
}

// One-time migration for entries that were cached before this file's loop-count
// detection existed, or before it covered WebP - both cases persisted as
// loopsForever: undefined regardless of whether the underlying file actually needed
// the restart workaround. The bytes are already sitting in the local cache, so this
// re-checks them for free (no network involved) rather than leaving already-saved
// GIFs/WebPs stuck on their last frame until someone notices and clears the cache.
async function migrateLoopDetection() {
    const changedKeys: string[] = [];

    for (const key of Object.keys(mediaCache)) {
        const entry = mediaCache[key];
        if (entry.loopsForever !== undefined) continue;

        const mime = /^data:(.*?);base64,/.exec(entry.dataUrl)?.[1] ?? "";
        if (mime !== "image/gif" && mime !== "image/webp") continue;

        const blob = dataUrlToBlob(entry.dataUrl);
        if (!blob) continue;

        try {
            const buffer = await blob.arrayBuffer();
            if (mime === "image/gif") {
                entry.loopsForever = getGifLoopCount(buffer) === 0;
                changedKeys.push(key);
            } else {
                const loopCount = getWebpLoopCount(buffer);
                // Same reasoning as the live cacheGif path: only a confirmed loop
                // count of 0 counts as "safe to leave alone". Anything else,
                // including an unreadable/absent ANIM chunk, is assumed to possibly
                // stop - restarting something that was actually fine is harmless,
                // never restarting something that's actually stuck is the bug.
                entry.loopsForever = loopCount === 0;
                changedKeys.push(key);
            }
        } catch { /* leave this one entry undecided rather than fail the whole pass */ }
    }

    if (changedKeys.length > 0) {
        notify();
        void persistMediaCacheEntries(changedKeys);
    }
}

async function ensureCached(entries: GifEntry[], concurrency = 4) {
    if (!settings.store.enableCache || entries.length === 0) return;
    const queue = entries.filter(e => !mediaCache[hashUrl(e.mediaSrc)]);
    if (queue.length === 0) return;

    let idx = 0;
    async function worker() {
        while (idx < queue.length) {
            const entry = queue[idx++];
            await cacheGif(entry.mediaSrc);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
}

async function clearMediaCache() {
    for (const key of blobUrlCache.keys()) releaseBlobUrl(key);
    const keys = Object.keys(mediaCache);
    mediaCache = {};
    await deleteMediaCacheEntries(keys);
    notify();
    showToast("Cleared local GIF cache", Toasts.Type.MESSAGE);
}

function getMediaCacheSizeLabel(): string {
    const bytes = Object.values(mediaCache).reduce((sum, e) => sum + e.size, 0);
    const budget = getMaxTotalCacheBytes();
    const mb = bytes / (1024 * 1024);
    const usedLabel = bytes === 0 ? "empty" : mb < 0.1 ? "<0.1 MB" : `${mb.toFixed(1)} MB`;
    if (!Number.isFinite(budget)) return `${usedLabel} / unlimited`;
    return `${usedLabel} / ${(budget / (1024 * 1024)).toFixed(0)} MB`;
}

// ---------- Export / Import (the practical way to "send a GIF cache to a friend") ----------

function serializeFolder(name: string, includeCache = true) {
    const entries = (cache[name] ?? []).map(e => {
        const out: Record<string, unknown> = { name: e.name, shareSrc: e.shareSrc, mediaSrc: e.mediaSrc, addedAt: e.addedAt };
        if (includeCache) {
            const cached = getCachedSrc(e.mediaSrc);
            if (cached) out.dataUrl = cached;
        }
        return out;
    });
    return JSON.stringify({ type: "GifFoldersExport", version: 2, exportedAt: Date.now(), folders: { [name]: entries } }, null, 2);
}

function downloadText(filename: string, text: string) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A reasonable filename for a saved entry when exporting it as a real file -
 * prefers the entry's own name, falling back to something generic, and always
 * makes sure it actually ends in the right extension for its media type.
 * Prefers the actual cached MIME type (known for certain - it's how we decoded
 * the bytes ourselves) over guessing from the URL: Discord serves plenty of GIFs
 * transcoded to WebP over a URL whose path still says ".gif" (see Bug 3), so a
 * URL-only guess can label the exported file with the wrong extension. Falls
 * back to the old URL-pattern guess only when no mime type is available. */
function deriveExportFilename(entry: GifEntry, mimeType?: string | null): string {
    const urlVideoExt = videoUrlExt(entry.mediaSrc);
    const ext = mimeType === "image/webp" ? ".webp"
        : mimeType === "image/gif" ? ".gif"
            : mimeType && VIDEO_MIME_TO_EXT[mimeType] ? VIDEO_MIME_TO_EXT[mimeType]
                : WebpExtRegex.test(entry.mediaSrc) ? ".webp"
                    : urlVideoExt ? `.${urlVideoExt}`
                        : ".gif";
    const base = entry.name?.trim() || "gif";
    return new RegExp(`\\${ext}$`, "i").test(base) ? base : base + ext;
}

/**
 * Gathers every saved GIF's actual bytes (downloading anything not already
 * cached, same as the background warm-cache pass) grouped by folder, ready to
 * hand off to native.ts for writing to disk. Entries that can't be downloaded at
 * all (dead link, etc.) are silently omitted rather than failing the whole export.
 * onProgress, if given, is called after each entry finishes (successfully or not)
 * with (doneSoFar, totalJobs), so a caller can show live progress instead of one
 * static "gathering" message for what can be a long operation on a large library.
 */
/** Mirrors native.ts's own sanitizeName/dedupeName exactly - duplicated rather
 * than shared, since renderer and main-process code can't import from each
 * other (same reasoning as MAX_CACHED_BYTES above). Used to resolve every
 * exported file's final on-disk name here, up front - only the renderer ever
 * sees every file in a folder at once; native.ts now only ever sees one small
 * batch, so it can no longer safely be the one deduplicating. See
 * exportGifFileBatch's own comment in native.ts for why. */
function sanitizeExportName(name: string): string {
    const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : "unnamed";
}

function dedupeExportName(name: string, used: Set<string>): string {
    if (!used.has(name)) return name;
    const dotIdx = name.lastIndexOf(".");
    const base = dotIdx > 0 ? name.slice(0, dotIdx) : name;
    const ext = dotIdx > 0 ? name.slice(dotIdx) : "";
    let i = 2;
    let candidate = `${base} (${i})${ext}`;
    while (used.has(candidate)) {
        i++;
        candidate = `${base} (${i})${ext}`;
    }
    return candidate;
}

// Small enough that one batch's worth of base64 - a handful of files, worst
// case maybe 8x MAX_CACHED_BYTES - is never a meaningful memory or IPC-message
// spike, even back to back. Large enough not to be needlessly chatty over IPC.
const EXPORT_BATCH_SIZE = 8;

/**
 * Downloads (if needed), encodes, and hands off every saved GIF to native.ts's
 * exportGifFileBatch - in small batches, sequentially - instead of gathering
 * an entire export into one structure and sending it in a single IPC call.
 * See the chat investigation this follows on from: the old version built a
 * second, near-complete copy of the cache in memory (on top of mediaCache,
 * already resident) before ever writing a single file to disk - which is what
 * actually crashed a large export partway through gathering, well before the
 * old single giant IPC call would even have run.
 *
 * Folder/file names are resolved to their final, globally-unique on-disk form
 * incrementally, as each batch is gathered, using usedFolderNames/
 * usedFileNamesPerFolder below - both persist for this whole call, unlike
 * native.ts's per-batch view, which is exactly why the deduplication has to
 * happen here and not there.
 */
async function exportAllFoldersToDisk(
    basePath: string,
    onProgress?: (done: number, total: number) => void
): Promise<{ written: number; skipped: number; }> {
    const { exportGifFileBatch } = getNativeApi() ?? {};
    if (!exportGifFileBatch) return { written: 0, skipped: 0 };

    const folderNames = getFolderNames();
    const jobs: Array<{ folder: string; entry: GifEntry; }> = [];
    for (const name of folderNames) {
        for (const entry of cache[name] ?? []) jobs.push({ folder: name, entry });
    }

    const usedFolderNames = new Set<string>();
    const dirNameFor: Record<string, string> = {};
    for (const name of folderNames) {
        dirNameFor[name] = dedupeExportName(sanitizeExportName(name), usedFolderNames);
        usedFolderNames.add(dirNameFor[name]);
    }
    const usedFileNamesPerFolder: Record<string, Set<string>> = {};
    for (const name of folderNames) usedFileNamesPerFolder[name] = new Set();

    let written = 0, skipped = 0, done = 0, index = 0;

    while (index < jobs.length) {
        const slice = jobs.slice(index, index + EXPORT_BATCH_SIZE);
        index += slice.length;

        const gathered = await Promise.all(slice.map(async ({ folder, entry }) => {
            try {
                let cachedEntry = getCacheEntry(entry.mediaSrc);
                if (!cachedEntry) {
                    await cacheGif(entry.mediaSrc, true);
                    cachedEntry = getCacheEntry(entry.mediaSrc);
                }
                if (!cachedEntry) return null; // dead link or similar - just skip it
                const commaIdx = cachedEntry.dataUrl.indexOf(",");
                const base64 = commaIdx === -1 ? "" : cachedEntry.dataUrl.slice(commaIdx + 1);
                if (!base64) return null;
                // The mime type is already known for certain here - it's how this
                // very entry got decoded and cached - so pass it through instead of
                // making deriveExportFilename guess from the URL.
                const mimeType = /^data:([^;]+);base64,/.exec(cachedEntry.dataUrl)?.[1] ?? null;
                return { folder, filename: deriveExportFilename(entry, mimeType), base64 };
            } catch {
                return null;
            } finally {
                done++;
                onProgress?.(done, jobs.length);
            }
        }));

        const batch: Array<{ dirName: string; filename: string; base64: string; }> = [];
        for (const g of gathered) {
            if (!g) { skipped++; continue; }
            const finalName = dedupeExportName(sanitizeExportName(g.filename), usedFileNamesPerFolder[g.folder]);
            usedFileNamesPerFolder[g.folder].add(finalName);
            batch.push({ dirName: dirNameFor[g.folder], filename: finalName, base64: g.base64 });
        }
        if (batch.length === 0) continue;

        // Sent (and awaited) one batch at a time, on purpose - this is what
        // guarantees only one batch's worth of base64 is ever alive at once,
        // rather than firing all batches concurrently and defeating the point.
        const result = await exportGifFileBatch(basePath, batch);
        written += result.written;
        skipped += result.skipped;
    }

    return { written, skipped };
}

/**
 * The subset of fields read off each raw imported entry - not a strict schema, since
 * this has to tolerate arbitrary/malformed JSON from outside the plugin (a hand-
 * edited file, a future export-format change, an older export, etc). Every field
 * stays `unknown` and gets its own typeof check at the point of use, exactly like the
 * plain `any` this replaces - the only thing this adds is catching a typo'd field
 * name (e.g. raw.nam) at compile time instead of it silently reading undefined.
 */
interface RawImportedGif {
    shareSrc?: unknown;
    originalSrc?: unknown;
    src?: unknown;
    mediaSrc?: unknown;
    name?: unknown;
    dataUrl?: unknown;
}

async function importFromJson(text: string) {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        showToast("That file isn't a valid GIF Folders export", Toasts.Type.FAILURE);
        return;
    }

    if (typeof parsed !== "object" || parsed === null) {
        showToast("That file isn't a valid GIF Folders export", Toasts.Type.FAILURE);
        return;
    }
    const folders = (parsed as Record<string, unknown>).folders;
    if (!folders || typeof folders !== "object") {
        showToast("That file isn't a valid GIF Folders export", Toasts.Type.FAILURE);
        return;
    }

    let importedGifs = 0;
    let touchedFolders = 0;
    let cachedFromPack = 0;
    const cachedFromPackKeys: string[] = [];

    for (const [name, rawEntries] of Object.entries(folders as Record<string, unknown>)) {
        if (!Array.isArray(rawEntries)) continue;
        // Array.isArray's own type predicate widens to any[] regardless of the input
        // type - re-annotating keeps every entry genuinely unknown below.
        const entries: unknown[] = rawEntries;
        if (!cache[name]) cache[name] = [];
        touchedFolders++;

        for (const rawItem of entries) {
            const raw = rawItem as RawImportedGif | null | undefined;
            // Support both the current export format and the older one where
            // originalSrc/src did double duty as both the share link and preview url.
            const shareSrc = typeof raw?.shareSrc === "string" ? raw.shareSrc
                : typeof raw?.originalSrc === "string" ? raw.originalSrc
                : raw?.src;
            if (typeof shareSrc !== "string" || !shareSrc) continue;
            const mediaSrc = typeof raw?.mediaSrc === "string" ? raw.mediaSrc : shareSrc;

            if (cache[name].some(g => g.shareSrc === shareSrc)) continue;

            cache[name].push({
                id: makeId(),
                shareSrc,
                mediaSrc,
                name: typeof raw?.name === "string" && raw.name ? raw.name : bestDefaultName(shareSrc, mediaSrc),
                addedAt: Date.now()
            });
            importedGifs++;

            if (typeof raw?.dataUrl === "string" && raw.dataUrl.startsWith("data:")) {
                const key = hashUrl(mediaSrc);
                if (!mediaCache[key]) {
                    mediaCache[key] = { dataUrl: raw.dataUrl, cachedAt: Date.now(), size: raw.dataUrl.length };
                    cachedFromPack++;
                    cachedFromPackKeys.push(key);
                }
            }
        }
    }

    await persist();
    if (cachedFromPackKeys.length > 0) await persistMediaCacheEntries(cachedFromPackKeys);

    showToast(`Imported ${importedGifs} GIF(s) into ${touchedFolders} folder(s)`, Toasts.Type.SUCCESS);
}

// ---------- Confirmation modals ----------

function confirmDeleteGifEntry(folder: string, entry: GifEntry) {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Remove GIF?"
            subtitle={`Remove "${entry.name}" from "${folder}"? This can't be undone.`}
            confirmText="Remove"
            cancelText="Cancel"
            onConfirm={() => { removeGifFromFolder(folder, entry.id); }}
        />
    ));
}

function confirmDeleteGifByShareSrc(folder: string, shareSrc: string) {
    const entry = cache[folder]?.find(g => g.shareSrc === shareSrc);
    const label = entry?.name ?? "this GIF";
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Remove GIF?"
            subtitle={`Remove "${label}" from "${folder}"? This can't be undone.`}
            confirmText="Remove"
            cancelText="Cancel"
            onConfirm={() => { if (entry) removeGifFromFolder(folder, entry.id); }}
        />
    ));
}

function confirmDeleteFolder(folder: string, onDeleted?: () => void) {
    const count = cache[folder]?.length ?? 0;
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Delete Folder?"
            subtitle={`Delete "${folder}" and all ${count} GIF(s) inside it? This can't be undone.`}
            confirmText="Delete"
            cancelText="Cancel"
            onConfirm={() => { deleteFolder(folder).then(onDeleted); }}
        />
    ));
}

// ---------- Generic text-prompt modal (new/rename folder, rename gif) ----------

function TextPromptModal({ modalProps, title, initial, placeholder, submitLabel, onSubmit }: {
    modalProps: RenderModalProps;
    title: string;
    initial?: string;
    placeholder?: string;
    submitLabel?: string;
    onSubmit: (value: string) => Promise<boolean> | boolean;
}) {
    const [value, setValue] = useState(initial ?? "");
    const [error, setError] = useState("");

    async function submit() {
        const trimmed = value.trim();
        if (!trimmed) { setError("This can't be empty."); return; }
        const ok = await onSubmit(trimmed);
        if (!ok) { setError("That name is already taken."); return; }
        modalProps.onClose();
    }

    return (
        <Modal
            {...modalProps}
            title={title}
            size="sm"
            actions={[
                { text: "Cancel", variant: "secondary", onClick: () => modalProps.onClose() },
                { text: submitLabel ?? "Save", variant: "primary", onClick: submit }
            ]}
        >
            <div>
                <Forms.FormTitle tag="h5">{title}</Forms.FormTitle>
                <TextInput
                    value={value}
                    onChange={(v: string) => { setValue(v); setError(""); }}
                    placeholder={placeholder}
                    autoFocus
                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") submit(); }}
                />
                {error && (
                    <Forms.FormText style={{ color: "var(--text-danger)", marginTop: 8 }}>{error}</Forms.FormText>
                )}
            </div>
        </Modal>
    );
}

function openNewFolderPrompt(onCreated?: (name: string) => void) {
    openModal(modalProps => (
        <TextPromptModal
            modalProps={modalProps}
            title="New Folder"
            placeholder="e.g. Reaction Gifs"
            submitLabel="Create"
            onSubmit={async name => {
                const ok = await createFolder(name);
                if (ok) onCreated?.(name);
                return ok;
            }}
        />
    ));
}

function openRenamePrompt(folder: string) {
    openModal(modalProps => (
        <TextPromptModal
            modalProps={modalProps}
            title={`Rename "${folder}"`}
            initial={folder}
            submitLabel="Rename"
            onSubmit={name => renameFolder(folder, name)}
        />
    ));
}

function openGifRenamePrompt(folder: string, entry: GifEntry) {
    openModal(modalProps => (
        <TextPromptModal
            modalProps={modalProps}
            title="Rename GIF"
            initial={entry.name}
            placeholder="e.g. happy dog.gif"
            submitLabel="Rename"
            onSubmit={async name => { await renameGifEntry(folder, entry.id, name); return true; }}
        />
    ));
}

// ---------- Chat right-click context menu (save to folder) ----------

function buildGifMenuGroup(shareSrc: string, mediaSrc: string) {
    const folderNames = getFolderNames();
    const savedIn = foldersContaining(shareSrc);

    return (
        <React.Fragment key="gif-folders-group">
            <Menu.MenuItem
                id="gif-folders-save"
                label="Save GIF to"
                icon={FolderIcon}
            >
                {folderNames.length === 0 && (
                    <Menu.MenuItem id="gif-folders-no-folders" label="No folders yet" disabled />
                )}
                {folderNames.map(name => (
                    <Menu.MenuItem
                        key={name}
                        id={`gif-folders-save-${name}`}
                        label={savedIn.includes(name) ? `✓ ${name}` : name}
                        action={() => saveGifToFolder(name, shareSrc, mediaSrc)}
                    />
                ))}
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="gif-folders-new"
                    label="New Folder…"
                    icon={PlusIcon}
                    action={() => openNewFolderPrompt(name => saveGifToFolder(name, shareSrc, mediaSrc))}
                />
            </Menu.MenuItem>

            {savedIn.length > 0 && (
                savedIn.length === 1 ? (
                    <Menu.MenuItem
                        id="gif-folders-delete"
                        label={`Delete this GIF from ${savedIn[0]}`}
                        color="danger"
                        icon={DeleteIcon}
                        action={() => confirmDeleteGifByShareSrc(savedIn[0], shareSrc)}
                    />
                ) : (
                    <Menu.MenuItem
                        id="gif-folders-delete"
                        label="Delete this GIF from…"
                        color="danger"
                        icon={DeleteIcon}
                    >
                        {savedIn.map(name => (
                            <Menu.MenuItem
                                key={name}
                                id={`gif-folders-delete-${name}`}
                                label={name}
                                color="danger"
                                action={() => confirmDeleteGifByShareSrc(name, shareSrc)}
                            />
                        ))}
                    </Menu.MenuItem>
                )
            )}
        </React.Fragment>
    );
}

function isAnyGifLike(props: GifContextMenuProps): boolean {
    const domCandidates = [props?.itemSrc, props?.itemHref, props?.src, props?.href]
        .filter((v): v is string => typeof v === "string" && v.length > 0);

    // Fast path: it's already obviously real, playable media (covers direct gif/webp/
    // png/mp4/webm/mov/etc links and Discord's own CDN attachment/media-proxy urls),
    // or at least gif-flavored (tenor/giphy/imgur domain, or a literal .gif extension).
    if (domCandidates.some(isDirectMediaUrl) || domCandidates.some(isGifUrl)) return true;

    // Host-agnostic fallback: *any* gif/animation-sharing site (Tenor, Giphy, Klipy,
    // Redgifs, ...) makes Discord attach real embed data when the link is posted -
    // we don't need to know every such domain by name, just recognise the shape of
    // what Discord already resolved it to. "gifv" is Discord's own type for "this is
    // an animation, play it like a gif" - regardless of which site it came from.
    const message = props?.message;
    if (!message) return false;

    const attachments = message.attachments ?? [];
    if (attachments.some(a => /^(image|video)\//i.test(a.content_type ?? ""))) return true;

    const embeds = message.embeds ?? [];
    if (embeds.some(e => e.type === "gifv" || e.type === "image")) return true;

    return false;
}

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!ready) return;
    if (!isAnyGifLike(props)) return;
    const shareSrc = resolveShareUrl(props);
    if (!shareSrc) return;
    const mediaSrc = resolveMediaUrl(props, shareSrc);

    const group = findGroupChildrenByChildId("copy-link", children) ?? children;
    group.push(buildGifMenuGroup(shareSrc, mediaSrc ?? shareSrc));
};

const imageContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!ready) return;
    if (!isAnyGifLike(props)) return;
    const shareSrc = resolveShareUrl(props);
    if (!shareSrc) return;
    const mediaSrc = resolveMediaUrl(props, shareSrc);

    const group = findGroupChildrenByChildId("copy-native-link", children) ?? children;
    group.push(buildGifMenuGroup(shareSrc, mediaSrc ?? shareSrc));
};

const videoContextMenuPatch: NavContextMenuPatchCallback = (children, props) => {
    if (!ready) return;
    if (!isAnyGifLike(props)) return;
    const shareSrc = resolveShareUrl(props);
    if (!shareSrc) return;
    const mediaSrc = resolveMediaUrl(props, shareSrc);

    const group = findGroupChildrenByChildId("copy-native-link", children) ?? findGroupChildrenByChildId("copy-link", children) ?? children;
    group.push(buildGifMenuGroup(shareSrc, mediaSrc ?? shareSrc));
};

// ---------- Instant send (modifier-click) ----------
//
// Holding a modifier key while clicking a tile sends that GIF immediately without
// closing the manager, so several GIFs can be fired off in quick succession. Which
// modifier triggers this is user-configurable (both here via the in-modal cog menu,
// and from the normal Vencord plugin settings panel, since they share the same
// underlying setting) - "ctrl" maps to Cmd on macOS, matching Vencord's convention
// for Ctrl-equivalent shortcuts elsewhere (e.g. quickReply, revealAllSpoilers).

type InstantSendModifier = "ctrl" | "shift" | "alt";

const INSTANT_SEND_MODIFIER_LABELS: Record<InstantSendModifier, string> = {
    ctrl: IS_MAC ? "Cmd (⌘)" : "Ctrl",
    shift: "Shift",
    alt: "Alt"
};

type GridColumnsOption = "3" | "4" | "5" | "6";
const GRID_COLUMNS_OPTIONS: GridColumnsOption[] = ["3", "4", "5", "6"];

type MaxCacheSizeOption = "500" | "1024" | "2048" | "4096" | "unlimited";
const MAX_CACHE_SIZE_OPTIONS: MaxCacheSizeOption[] = ["500", "1024", "2048", "4096", "unlimited"];
const MAX_CACHE_SIZE_LABELS: Record<MaxCacheSizeOption, string> = {
    "500": "500 MB",
    "1024": "1 GB",
    "2048": "2 GB",
    "4096": "4 GB",
    unlimited: "Unlimited"
};

// ---------- Chat bar icon ----------
//
// Which icon represents the GIF Folders button in the chat bar - purely
// cosmetic, doesn't affect anything else. "gorilla" is the default this
// plugin ships with (Discord's own :gorilla: Twemoji artwork, swapping to
// :banana: on hover - see GifFoldersIcon/GifFoldersBananaIcon below); "folder"
// falls back to Vencord's plain built-in folder icon; "gif" is a plain "GIF"
// wordmark in the spirit of Discord's own native GIF-picker button. There's no
// standard Unicode "GIF" emoji to source real artwork from the way there was
// for the gorilla/banana, so that option is styled text rather than embedded
// artwork.

type ChatBarIconOption = "gorilla" | "folder" | "gif";

const CHAT_BAR_ICON_LABELS: Record<ChatBarIconOption, string> = {
    gorilla: "Gorilla (banana on hover)",
    folder: "Folder (classic)",
    gif: "\"GIF\" text"
};


/** Coerces the stored setting to a safe column count, defaulting to 3 for
 * anything unexpected (missing, corrupted, or pre-this-feature stored data). */
function getGridColumns(raw: unknown): number {
    const n = Number(raw);
    return n >= 3 && n <= 6 ? n : 3;
}

/**
 * Walks up from this plugin's own search-row div (always present once the
 * modal is open - it's this plugin's own markup, not Modal's) to find the
 * actual visible modal box.
 *
 * Primary approach: look for a class starting with "size-lg" - confirmed via
 * a real diagnostic dump (see INVESTIGATION.md Part 7) to be Discord's own
 * modal-size class, applied directly to the real, visible, correctly-sized
 * box (e.g. "size-lg__8a031"). The hash suffix will change between Discord
 * builds, but the semantic "size-lg" prefix is tied directly to size="lg"
 * passed to <Modal> and much more likely to stay stable, so this only matches
 * the stable part.
 *
 * role="dialog" was tried first and turned out to resolve to a much bigger
 * element several levels further out - almost certainly a position:fixed,
 * viewport-sized overlay/backdrop (the click-outside-to-close layer), not the
 * box actually visible on screen. Kept as a fallback below in case a future
 * Discord version renames the size class, along with the className this
 * plugin itself passes to <Modal> - neither is known to be correct on the
 * build actually tested against, but cost nothing to keep as a last resort.
 */
function findModalDialogElement(): HTMLElement | null {
    const anchor = document.querySelector<HTMLElement>(".vc-gif-folders-search-row");
    if (!anchor) return null;

    let el: HTMLElement | null = anchor;
    for (let i = 0; i < 10 && el; i++) {
        if (typeof el.className === "string" && el.className.split(/\s+/).some(c => c.startsWith("size-lg"))) {
            return el;
        }
        el = el.parentElement;
    }

    return anchor.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]')
        ?? document.querySelector<HTMLElement>(".vc-gif-folders-modal-root");
}

/**
 * The narrowest the modal can be for a given fixed column count before the
 * grid can no longer fit that many minmax(TILE_MIN_PX, 1fr) tiles and starts
 * overflowing (visible as clipping / a horizontal scrollbar) instead of
 * shrinking further. The grid's own minimum content width for N columns is
 * N*TILE_MIN_PX + (N-1)*10 (gaps) + 32 (the grid's own left/right padding);
 * CHROME_OVERHEAD_PX accounts for whatever sits between the grid's content
 * box and the modal's own outer edge (header area, the modal's own padding,
 * etc.) that isn't this plugin's own markup to measure directly. Calibrated
 * against one confirmed real measurement (1022px was the narrowest that
 * looked right at 5 columns, back when tiles had a 120px floor) rather than
 * derived structurally - see INVESTIGATION.md Part 11. That calibration is
 * intentionally left in terms of the original 120px figure below, not
 * TILE_MIN_PX - it's a fixed historical data point describing the chrome
 * alone, which doesn't change just because the tile floor since has. Only
 * meaningful for a fixed column count - Free Resize's auto-fill layout has no
 * fixed N to protect, since auto-fill itself reduces the visible column count
 * as space shrinks instead of demanding a specific number regardless of
 * available width.
 */
const CHROME_OVERHEAD_PX = 1022 - (5 * 120 + 4 * 10 + 32); // = 350, from the one confirmed data point

// The smallest a tile is ever allowed to render at in fixed-column mode -
// mirrors the minmax() floor in styles.css's fixed-column .vc-gif-folders-grid
// rule. Keep these two numbers in sync if this ever changes again. Free
// Resize has its own separate, user-configurable floor instead (the
// freeResizeTileMin setting) - see minWidthForColumns's tileSizePx param and
// GifFoldersSettingsMenu's slider below.
const TILE_MIN_PX = 80;

// n=1 with tileSizePx set to freeResizeTileMin is also how Free Resize's own
// floor gets computed (see the drag handles and the width-on-open effect
// below) - same formula, just for "one tile" instead of a fixed column count.
function minWidthForColumns(n: number, tileSizePx: number = TILE_MIN_PX): number {
    return n * tileSizePx + (n - 1) * 10 + 32 + CHROME_OVERHEAD_PX;
}

const DIALOG_WIDTH_STYLE_ID = "vc-gif-folders-dialog-width-override";
const ANCESTOR_MAXWIDTH_STYLE_ID = "vc-gif-folders-ancestor-maxwidth-override";

/* ---- Height resize (mirrors the width machinery immediately above) ---- */

// The dialog box's own height override - same technique as
// DIALOG_WIDTH_STYLE_ID (see setDialogWidth's own comment for why this has
// to be a stylesheet rule and not a direct inline style write).
const DIALOG_HEIGHT_STYLE_ID = "vc-gif-folders-dialog-height-override";
// .vc-gif-folders-grid's own max-height override. The grid's CSS default
// (420px, see styles.css) is fixed independent of the dialog's own height -
// without this, dragging the dialog taller would just add blank space below
// a grid still capped at its old height, instead of actually showing more
// rows. Kept as its own separate style tag (rather than folded into the
// dialog's own override rule) since it targets a different, always-present,
// plugin-owned class rather than whatever element findModalDialogElement()
// happened to find - no need for buildElementSelector's dynamic-selector
// approach here.
const GRID_MAXHEIGHT_STYLE_ID = "vc-gif-folders-grid-maxheight-override";
// Mirrors styles.css's own default max-height/min-height for
// .vc-gif-folders-grid - the "un-resized" starting point the delta-based
// resize math below (both the initial-apply effect and the live drag
// handles) measures every height change relative to.
const GRID_DEFAULT_MAX_HEIGHT_PX = 420;
const GRID_MIN_MAX_HEIGHT_PX = 170;
// Roughly the header/search-row/tabs/toolbar chrome above the grid, plus the
// grid's own min-height - below this the dialog itself starts clipping its
// own content rather than shrinking further. Not calibrated against a real
// measurement the way CHROME_OVERHEAD_PX above was (see that constant's own
// comment) - a reasonable estimate rather than a confirmed one.
const MIN_MODAL_HEIGHT_PX = 300;

/** Builds a CSS selector matching exactly this element's current classes (all
 * of them, combined, for specificity against anything matching only one), or
 * null if it has none to build one from. Shared by setDialogWidth and
 * clearAncestorMaxWidths below. */
function buildElementSelector(el: HTMLElement): string | null {
    const classSelector = Array.from(el.classList).map(c => CSS.escape(c)).join(".");
    return classSelector ? `.${classSelector}` : null;
}

/**
 * Sets an element's width via an injected stylesheet rule instead of writing
 * to its inline style directly. A plain `el.style.width = ...` write doesn't
 * reliably persist here: `el` is a node Discord's own React tree owns and
 * re-renders on its own schedule, for reasons that can have nothing to do
 * with this plugin (confirmed via a real diagnostic dump - see
 * INVESTIGATION.md Part 9 - where the target element measured back at its
 * untouched default width after a width change had definitely been applied).
 * React's reconciliation resets the DOM `style` attribute to match whatever
 * it believes it should be on every re-render of that node, discarding any
 * outside write to the same attribute. A rule in an actual stylesheet isn't
 * something React's reconciliation of the `style` *attribute* touches at
 * all, so it survives those re-renders instead of losing to them.
 *
 * Also clears max-width alongside width itself. max-width is a separate
 * constraint the browser clamps the *rendered* width to, independent of
 * which declaration wins the cascade for width alone - overriding width
 * doesn't touch it, so a width override can win completely and the element
 * still won't visibly grow past whatever max-width already says (confirmed
 * via a real, reproducible ceiling - see INVESTIGATION.md Part 10).
 *
 * The selector is built from whatever classes the element actually has right
 * now rather than a hardcoded class name, so this still doesn't depend on
 * knowing Discord's exact class names in advance - only on findModalDialog
 * Element() having found the right element to read classes from.
 */
function setDialogWidth(el: HTMLElement, widthPx: number) {
    const selector = buildElementSelector(el);
    if (!selector) {
        // Nothing to build a selector from - best-effort fallback, subject to
        // the same reset-on-re-render risk this function otherwise avoids.
        el.style.width = `${widthPx}px`;
        el.style.maxWidth = "none";
        return;
    }

    let styleTag = document.getElementById(DIALOG_WIDTH_STYLE_ID) as HTMLStyleElement | null;
    if (!styleTag) {
        styleTag = document.createElement("style");
        styleTag.id = DIALOG_WIDTH_STYLE_ID;
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = `${selector} { width: ${widthPx}px !important; max-width: none !important; }`;
}

/**
 * Same technique as setDialogWidth, for height instead of width - see that
 * function's own comment for why a stylesheet rule is used instead of a
 * direct inline style write.
 */
function setDialogHeight(el: HTMLElement, heightPx: number) {
    const selector = buildElementSelector(el);
    if (!selector) {
        el.style.height = `${heightPx}px`;
        el.style.maxHeight = "none";
        return;
    }

    let styleTag = document.getElementById(DIALOG_HEIGHT_STYLE_ID) as HTMLStyleElement | null;
    if (!styleTag) {
        styleTag = document.createElement("style");
        styleTag.id = DIALOG_HEIGHT_STYLE_ID;
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = `${selector} { height: ${heightPx}px !important; max-height: none !important; }`;
}

/**
 * Overrides .vc-gif-folders-grid's own max-height (see GRID_MAXHEIGHT_STYLE_ID's
 * comment for why this needs to happen alongside the dialog's own height, and
 * why it can target this class directly rather than needing
 * buildElementSelector). Clamped to GRID_MIN_MAX_HEIGHT_PX so a fast drag or a
 * stale persisted value can never collapse the grid to something unusable.
 */
function setGridMaxHeight(maxHeightPx: number) {
    const clamped = Math.max(GRID_MIN_MAX_HEIGHT_PX, Math.round(maxHeightPx));
    let styleTag = document.getElementById(GRID_MAXHEIGHT_STYLE_ID) as HTMLStyleElement | null;
    if (!styleTag) {
        styleTag = document.createElement("style");
        styleTag.id = GRID_MAXHEIGHT_STYLE_ID;
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = `.vc-gif-folders-grid { max-height: ${clamped}px !important; }`;
}

/**
 * Tightens Discord's own modal chrome around this plugin's content - the
 * header row (title + Discord's own Close "X" button, plus this plugin's own
 * portalled Settings button) is shrunk and its two icon buttons enlarged; the
 * footer row (which used to hold Close / + New Folder, both now moved into
 * the toolbar instead - see actions={[]} on the Modal call below) is hidden
 * outright, having nothing left inside it; and the content wrapper between
 * them has its own default scrolling disabled, since it was growing a second,
 * redundant scrollbar alongside the grid's own (see styles.css's own themed
 * scrollbar rule on .vc-gif-folders-grid, now the only one left). None of
 * header, footer, or the content wrapper is this plugin's own markup; all
 * three come from the generic Modal helper in @webpack/common.
 *
 * A CSS rule scoped under .vc-gif-folders-modal-root was tried first and had
 * no effect - that class, despite being passed as this plugin's own
 * className prop to Modal, never actually lands on anything in the live DOM
 * (confirmed live: document.querySelectorAll('.vc-gif-folders-modal-root')
 * returns zero elements while the modal is open). This takes real element
 * references directly from `dialog` instead (the same element
 * setDialogWidth/setDialogHeight above already know how to find) and sets
 * styles inline - no CSS selector or specificity fight involved.
 *
 * The header padding/button numbers below are calibrated against real,
 * confirmed measurements along the way (not guessed the way the first
 * attempt at any of this was) - e.g. a button's true height turned out to
 * come from an inner wrapper div's own padding and a hard min-height, not
 * the outer <button> element's own padding the way that'd naively be
 * assumed. Matched by a "buttonChildren" substring rather than the exact
 * hashed class, in case a future Discord build renames the suffix.
 */
function tightenModalChrome(dialog: HTMLElement) {
    const header = dialog.querySelector<HTMLElement>("header");
    if (header) {
        // Already confirmed live this padding is the real driver here (the
        // first pass at 8px measurably worked) - pushed further now that
        // that's established, the same way footer's numbers below are.
        header.style.setProperty("padding-top", "2px", "important");
        header.style.setProperty("padding-bottom", "2px", "important");
        header.style.setProperty("min-height", "0", "important");
        // Not confirmed live the way the padding above is - h1 elements
        // default to a nonzero browser margin unless a page's own CSS already
        // resets it, and that wasn't checked. Harmless either way: zeroing an
        // already-zero margin changes nothing, so this only ever helps.
        const title = header.querySelector<HTMLElement>("h1");
        if (title) title.style.setProperty("margin", "0", "important");

        // Discord's own native Close ("X") button, enlarged ~40% (20px icon
        // to 28px) at the person's request. Learned from the footer buttons
        // above not to assume the outer <button>'s own box is what actually
        // constrains size - relaxing width/height/min-width/min-height at
        // every layer (button, its wrapper divs, and the icon itself) rather
        // than guessing which one is the real driver this time.
        const closeButton = header.querySelector<HTMLElement>('button[aria-label="Close"]');
        if (closeButton) {
            const relax = (el: HTMLElement) => {
                el.style.setProperty("width", "auto", "important");
                el.style.setProperty("height", "auto", "important");
                el.style.setProperty("min-width", "0", "important");
                el.style.setProperty("min-height", "0", "important");
            };
            relax(closeButton);
            closeButton.querySelectorAll<HTMLElement>('[class*="buttonChildren"]').forEach(relax);
            const icon = closeButton.querySelector<SVGElement>("svg");
            if (icon) {
                icon.style.setProperty("width", "28px", "important");
                icon.style.setProperty("height", "28px", "important");
            }
            // Empirical, from direct visual feedback, same as the settings
            // button's own margin-top in styles.css - this button's position
            // was never touched before now, only its icon size above.
            // 18px was 5px too much per direct feedback - down to 13px.
            closeButton.style.setProperty("margin-top", "13px", "important");
        }
    }

    const footer = dialog.querySelector<HTMLElement>("footer");
    if (footer) {
        // Close and + New Folder both moved into the toolbar (see the
        // actions={[]} on the Modal call, and the toolbar's own + New Folder
        // button) - this footer has nothing left inside it to shrink, so
        // it's hidden outright rather than just padded down further. Padding
        // alone left a visible empty gap even at a tiny value, which points
        // to some interior wrapper div's own min-height still reserving
        // space regardless of the footer's own padding - display:none
        // sidesteps that entirely rather than chasing it through another
        // layer the way the button height issue above needed.
        footer.style.setProperty("display", "none", "important");
    }

    // Discord's own modal content wrapper - between header and footer,
    // holding all of this plugin's own markup (search row, tabs, toolbar,
    // grid) - has its own default overflow-y: auto, so if that content is
    // even a few pixels taller than the space available it grows a second,
    // plain-default-styled scrollbar of its own, redundant with (and visually
    // right next to) the grid's own already-themed one below. Found
    // structurally - "whichever direct child of `dialog` contains this
    // plugin's own search row" - rather than by guessing at Discord's own
    // hashed class name for it, since unlike header/footer this wrapper has
    // no distinguishing tag name to look up directly.
    const searchRow = dialog.querySelector<HTMLElement>(".vc-gif-folders-search-row");
    let contentWrapper = searchRow;
    while (contentWrapper && contentWrapper.parentElement && contentWrapper.parentElement !== dialog) {
        contentWrapper = contentWrapper.parentElement;
    }
    if (contentWrapper && contentWrapper.parentElement === dialog) {
        contentWrapper.style.setProperty("overflow", "hidden", "important");
    }
}

/**
 * Clears max-width on a set of ancestor elements (see the ancestor-max-width
 * effect in ManagerModal) via one injected stylesheet rule covering all of
 * them at once, for the same reason setDialogWidth uses one instead of
 * direct style writes - these are React-owned nodes too, and an inline style
 * on any of them is just as exposed to being silently reset on an unrelated
 * re-render as the dialog box itself was.
 */
function clearAncestorMaxWidths(elements: HTMLElement[]) {
    const selectors = elements.map(buildElementSelector).filter((s): s is string => s !== null);
    if (selectors.length === 0) return;

    let styleTag = document.getElementById(ANCESTOR_MAXWIDTH_STYLE_ID) as HTMLStyleElement | null;
    if (!styleTag) {
        styleTag = document.createElement("style");
        styleTag.id = ANCESTOR_MAXWIDTH_STYLE_ID;
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = selectors.map(s => `${s} { max-width: none !important; }`).join("\n");
}

function isInstantSendClick(e: React.MouseEvent): boolean {
    switch (settings.store.instantSendModifier as InstantSendModifier) {
        case "shift": return e.shiftKey;
        case "alt": return e.altKey;
        case "ctrl":
        default: return IS_MAC ? e.metaKey : e.ctrlKey;
    }
}

function GifFoldersSettingsMenu() {
    const s = settings.use(["chatBarIcon", "instantSendModifier", "enableCache", "gridColumns", "freeResize", "freeResizeTileMin", "maxCacheSize"]);

    return (
        <Menu.Menu
            navId="vc-gif-folders-settings-menu"
            onClose={() => ContextMenuApi.closeContextMenu()}
            aria-label="GIF Folders Settings"
        >
            <Menu.MenuGroup label="Chat Bar Icon">
                {(Object.keys(CHAT_BAR_ICON_LABELS) as ChatBarIconOption[]).map(opt => (
                    <Menu.MenuRadioItem
                        key={opt}
                        group="gif-folders-chat-bar-icon"
                        id={`gif-folders-chat-bar-icon-${opt}`}
                        label={CHAT_BAR_ICON_LABELS[opt]}
                        checked={s.chatBarIcon === opt}
                        action={() => { s.chatBarIcon = opt; }}
                    />
                ))}
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuGroup label="Instant-Send Hotkey">
                {(Object.keys(INSTANT_SEND_MODIFIER_LABELS) as InstantSendModifier[]).map(mod => (
                    <Menu.MenuRadioItem
                        key={mod}
                        group="gif-folders-instant-send-modifier"
                        id={`gif-folders-instant-send-${mod}`}
                        label={`Hold ${INSTANT_SEND_MODIFIER_LABELS[mod]} + Click`}
                        checked={s.instantSendModifier === mod}
                        action={() => { s.instantSendModifier = mod; }}
                    />
                ))}
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuGroup label="Window Width">
                <Menu.MenuCheckboxItem
                    id="gif-folders-free-resize"
                    label="Free Resize"
                    checked={s.freeResize}
                    action={() => { s.freeResize = !s.freeResize; }}
                />
                {/* Only meaningful in Free Resize mode - fixed-column mode has
                 * its own separate, non-configurable floor (TILE_MIN_PX). */}
                <Menu.MenuControlItem
                    id="gif-folders-free-resize-tile-min"
                    label={`Minimum GIF Size (${s.freeResizeTileMin}px)`}
                    disabled={!s.freeResize}
                    control={(controlProps, ref) => (
                        <Slider
                            {...controlProps}
                            ref={ref}
                            disabled={!s.freeResize}
                            initialValue={s.freeResizeTileMin}
                            minValue={80}
                            maxValue={200}
                            markers={[80, 100, 120, 140, 160, 180, 200]}
                            stickToMarkers={false}
                            onValueChange={(v: number) => { s.freeResizeTileMin = Math.round(v); }}
                            onValueRender={(v: number) => `${Math.round(v)}px`}
                        />
                    )}
                />
            </Menu.MenuGroup>
            <Menu.MenuGroup label="GIFs Per Row">
                {GRID_COLUMNS_OPTIONS.map(n => (
                    <Menu.MenuRadioItem
                        key={n}
                        group="gif-folders-grid-columns"
                        id={`gif-folders-grid-columns-${n}`}
                        label={`${n} per row`}
                        checked={s.gridColumns === n}
                        disabled={s.freeResize}
                        action={() => { s.gridColumns = n; }}
                    />
                ))}
            </Menu.MenuGroup>
            <Menu.MenuSeparator />
            <Menu.MenuCheckboxItem
                id="gif-folders-toggle-cache"
                label={`Cache GIFs Locally (${getMediaCacheSizeLabel()})`}
                checked={s.enableCache}
                action={() => {
                    const next = !s.enableCache;
                    s.enableCache = next;
                    if (!next && Object.keys(mediaCache).length > 0) {
                        showToast('Cache disabled. Use "Clear Cache" to free up existing space.', Toasts.Type.MESSAGE);
                    }
                }}
            />
            {s.enableCache && (
                <Menu.MenuGroup label="Local Cache Size Limit">
                    {MAX_CACHE_SIZE_OPTIONS.map(opt => (
                        <Menu.MenuRadioItem
                            key={opt}
                            group="gif-folders-max-cache-size"
                            id={`gif-folders-max-cache-size-${opt}`}
                            label={MAX_CACHE_SIZE_LABELS[opt]}
                            checked={s.maxCacheSize === opt}
                            action={() => { s.maxCacheSize = opt; }}
                        />
                    ))}
                </Menu.MenuGroup>
            )}
        </Menu.Menu>
    );
}

function openGifFoldersSettingsMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    ContextMenuApi.openContextMenu(e, () => <GifFoldersSettingsMenu />);
}

// ---------- Manager modal ----------

function useForceUpdate() {
    const [, setTick] = useState(0);
    React.useEffect(() => {
        const cb = () => setTick(t => t + 1);
        listeners.add(cb);
        return () => { listeners.delete(cb); };
    }, []);
}

// Reproducibly, Chromium's animated-image decoder appears to cache decoded playback
// state by the underlying byte content itself, not by the <img> element or the
// blob: URL used to load it: even a genuinely fresh blob: URL (a brand new, unique
// createObjectURL() result each time - see getPlayableSrc/RESTART_INTERVAL_MS above)
// wrapping the exact same previously-seen bytes shows up already frozen on whatever
// frame the animation last stopped on, rather than restarting from frame 1, once
// this browser session has already fully decoded those bytes once before. No amount
// of URL-identity trickery can work around a cache keyed on content rather than URL.
// The only fully reliable fix is to stop asking the browser's <img> tag to animate
// the file at all: decode every frame ourselves via the WebCodecs ImageDecoder API
// and paint them to a <canvas> on our own timer, so nothing is ever left to a decode
// cache outside our control. Falls back to the caller rendering a plain <img> (via
// onError) if ImageDecoder isn't available in this Electron/Chromium version, the
// format isn't supported, or decoding fails for any reason.
const MAX_DECODED_FRAMES = 300; // sanity cap - most reaction GIFs are well under this

/**
 * Minimal local shape for the WebCodecs ImageDecoder API used below - not global
 * type declarations (this project's TS lib may or may not already declare these,
 * and redeclaring them globally risks colliding either way this project's tsconfig
 * is set up), just enough of the real spec to type this component's own local
 * variables instead of leaving them as `any`. See the spec for the full surface:
 * https://developer.mozilla.org/en-US/docs/Web/API/ImageDecoder
 */
interface DecodedVideoFrame {
    duration: number | null;
    close(): void;
}
interface WebCodecsImageDecoder {
    tracks: {
        ready: Promise<void>;
        selectedTrack: { frameCount?: number; } | null;
    };
    decode(options: { frameIndex: number; }): Promise<{ image: DecodedVideoFrame; }>;
    close(): void;
}
interface WebCodecsImageDecoderCtor {
    new(init: { data: Uint8Array; type: string; }): WebCodecsImageDecoder;
    isTypeSupported?(type: string): Promise<boolean>;
}

function AnimatedCanvasImage({ label, dataUrl, mimeType, className, onClick, onLoad, onError }: {
    label: string;
    dataUrl: string;
    mimeType: string;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
    onLoad?: () => void;
    onError?: () => void;
}) {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);

    React.useEffect(() => {
        let cancelled = false;
        let frames: ImageBitmap[] = [];
        let frameDurations: number[] = [];
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        // Only kept referenced long enough to decode+convert every frame, then
        // closed immediately after - unlike the VideoFrames it produces (converted
        // to ImageBitmaps right away, see below), there's no reason to keep this
        // around for playback.
        let decoder: { close(): void; } | null = null;

        (async () => {
            const ImageDecoderCtor = (window as unknown as { ImageDecoder?: WebCodecsImageDecoderCtor; }).ImageDecoder;
            if (!ImageDecoderCtor) {
                onError?.();
                return;
            }

            try {
                if (ImageDecoderCtor.isTypeSupported && !(await ImageDecoderCtor.isTypeSupported(mimeType))) {
                    onError?.();
                    return;
                }

                const blob = dataUrlToBlob(dataUrl);
                if (!blob) {
                    onError?.();
                    return;
                }
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (cancelled) return;

                const dec = new ImageDecoderCtor({ data: bytes, type: mimeType });
                decoder = dec;
                await dec.tracks.ready;
                const track = dec.tracks.selectedTrack;
                const frameCount = Math.min(track?.frameCount ?? 1, MAX_DECODED_FRAMES);

                // Decode each frame and immediately convert it to an ImageBitmap,
                // closing the VideoFrame right away rather than holding onto it -
                // VideoFrame is meant to be consumed quickly (e.g. drawn once), and
                // reusing the same one for repeated redraws over an extended,
                // possibly multi-minute animation loop isn't a reliably-supported
                // pattern in every decoder implementation. ImageBitmap is the type
                // actually designed for "hold many images, redraw them repeatedly".
                for (let i = 0; i < frameCount; i++) {
                    if (cancelled) break;
                    const { image } = await dec.decode({ frameIndex: i });
                    try {
                        const bitmap = await createImageBitmap(image as unknown as ImageBitmapSource);
                        frames.push(bitmap);
                        frameDurations.push(image.duration ?? 0);
                    } finally {
                        image.close();
                    }
                }
                try { decoder?.close(); } catch { /* already closed */ }
                decoder = null;

                if (cancelled || frames.length === 0) {
                    frames.forEach(f => f.close());
                    if (!cancelled) onError?.();
                    return;
                }

                const canvas = canvasRef.current;
                if (!canvas) {
                    frames.forEach(f => f.close());
                    return;
                }
                canvas.width = frames[0].width;
                canvas.height = frames[0].height;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    frames.forEach(f => f.close());
                    onError?.();
                    return;
                }

                onLoad?.();

                // A reaction GIF/WebP never legitimately needs more than ~1s between
                // frames - clamping guards against a malformed, misread, or overflowed
                // duration value on any one frame (some encoders also use a
                // deliberately long final-frame duration as an inter-loop pause,
                // which an overflow could turn into something absurd) turning into a
                // delay so long it's indistinguishable from "permanently frozen",
                // even though the setTimeout chain is technically still alive.
                const MAX_FRAME_DELAY_MS = 1000;

                let frameIndex = 0;
                const drawFrame = () => {
                    if (cancelled) return;
                    try {
                        // Must clear first: without this, any transparent pixels in
                        // the new frame let whatever was drawn last frame show
                        // through underneath, since drawImage() only overwrites the
                        // pixels the new frame actually covers. For anything with
                        // alpha transparency (very common - reaction stickers,
                        // characters on a transparent background) that looks exactly
                        // like old Windows XP window-drag ghosting: every frame's
                        // opaque pixels persist and stack up instead of replacing
                        // what came before.
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(frames[frameIndex], 0, 0, canvas.width, canvas.height);
                        const rawDurationMs = frameDurations[frameIndex] ? frameDurations[frameIndex] / 1000 : 100;
                        const durationMs = Math.min(rawDurationMs, MAX_FRAME_DELAY_MS);
                        frameIndex = (frameIndex + 1) % frames.length;
                        timeoutId = setTimeout(drawFrame, Math.max(durationMs, 20));
                    } catch (e) {
                        // A frame failed to draw - stop cleanly and fall back to the
                        // plain <img> rather than leaving the canvas frozen with no
                        // way to recover.
                        logger.warn("Canvas player: frame draw failed, falling back to <img>", label, e);
                        onError?.();
                    }
                };
                drawFrame();
            } catch (e) {
                logger.warn("Canvas player: setup failed, falling back to <img>", label, e);
                if (!cancelled) onError?.();
            }
        })();

        return () => {
            cancelled = true;
            if (timeoutId) clearTimeout(timeoutId);
            frames.forEach(f => { try { f.close(); } catch { /* already closed */ } });
            try { decoder?.close(); } catch { /* already closed */ }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataUrl, mimeType]);

    return <canvas ref={canvasRef} className={className} onClick={onClick} draggable={false} />;
}

// Backs GifTile's isVisible tracking (below) with one IntersectionObserver per
// grid root, shared by every tile inside it, instead of each tile creating its
// own private instance. A folder can have hundreds of entries, all mounted at
// once with no virtualization (see isVisible's own comment in GifTile) - one
// observer per tile means a folder that size spins up hundreds of separate
// observer instances, all independently watching the same root.
//
// Free Resize specifically stresses this in a way fixed-column mode doesn't:
// dragging the window's edge changes the *column count* (auto-fill), not just
// each column's pixel width, so a fast drag can reflow dozens of tiles into
// completely different rows within a couple of frames - while the grid root
// itself is also resizing many times a second as the drag continues. Under
// that combined load, some subset of tiles reliably end up stuck showing the
// empty placeholder (isVisible stuck false) even though they're plainly
// scrolled into view once the drag settles; a genuine scroll afterward always
// corrects it, since scroll-driven intersection recomputation is some of the
// most heavily-exercised code in any browser, but nothing about a pure resize
// reflow was getting every tile the equivalent all-at-once recheck. Sharing a
// single observer per root - so the browser computes all of a root's
// intersecting targets together in one pass instead of hundreds of separate,
// independently-scheduled ones racing the same rapidly-changing root - is the
// standard fix for this class of symptom regardless of the exact underlying
// scheduling detail, and cuts real per-tile overhead besides.
//
// Not confirmed against a live client - there's no way to reproduce a fast
// Free Resize drag outside Discord itself - so treat this as the best-grounded
// theory from code review, not a verified root cause, the same as several
// other fixes in this file's investigation notes.
const sharedVisibilityObservers = new WeakMap<Element, {
    observer: IntersectionObserver;
    callbacks: Map<Element, (visible: boolean) => void>;
}>();

function observeTileVisibility(root: Element, el: Element, onChange: (visible: boolean) => void): () => void {
    let shared = sharedVisibilityObservers.get(root);
    if (!shared) {
        const callbacks = new Map<Element, (visible: boolean) => void>();
        const observer = new IntersectionObserver(
            entries => {
                for (const entry of entries) {
                    callbacks.get(entry.target)?.(entry.isIntersecting);
                }
            },
            { root, rootMargin: "300px" }
        );
        shared = { observer, callbacks };
        sharedVisibilityObservers.set(root, shared);
    }
    shared.callbacks.set(el, onChange);
    shared.observer.observe(el);

    return () => {
        shared!.callbacks.delete(el);
        shared!.observer.unobserve(el);
        // Nothing left watching this root - tear it down rather than leaking
        // an observer with an empty callback map (e.g. after closing a
        // folder/search view whose tiles have all unmounted).
        if (shared!.callbacks.size === 0) {
            shared!.observer.disconnect();
            sharedVisibilityObservers.delete(root);
        }
    };
}

function GifTile({ folder, entry, onInsert, folderBadge, reorderable, isDragging, isDropTarget, onTilePointerDown }: {
    folder: string;
    entry: GifEntry;
    onInsert: (entry: GifEntry, instant: boolean) => void;
    folderBadge?: string;
    /** Whether this tile can be picked up and dragged to reorder the folder - only makes sense for a single, currently-open folder, not search results spanning several. */
    reorderable?: boolean;
    isDragging?: boolean;
    isDropTarget?: boolean;
    onTilePointerDown?: (e: React.PointerEvent) => void;
}) {
    const [broken, setBroken] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [restartTick, setRestartTick] = useState(0);
    // Flips permanently (for this tile's lifetime) the first time a cache-busted
    // restart attempt itself fails to load - see displaySrc below for why that can
    // happen and why falling back to the plain link is the safe response.
    const [bustBroken, setBustBroken] = useState(false);
    // Tracks whether we've already asked Discord for a fresh signature on this
    // tile's link, so a load failure only triggers one refresh attempt rather than
    // retrying it every time the interval or a remount fires onError again.
    const [refreshState, setRefreshState] = useState<"idle" | "trying" | "done">("idle");
    // Flips permanently if the canvas-based player (see AnimatedCanvasImage above)
    // fails for this tile - e.g. ImageDecoder isn't available in this Electron/
    // Chromium version - falling back to the plain <img> restart-tick system below.
    const [canvasFailed, setCanvasFailed] = useState(false);

    // Whether this tile is actually scrolled into view (or close to it). A folder
    // can have hundreds of entries, all mounted at once with no virtualization -
    // decoding and holding every frame of every animated tile's canvas player in
    // memory simultaneously, regardless of whether it's even visible, is a real
    // memory risk for large folders. Caching (downloading bytes) still happens
    // for every tile regardless, since that's what makes scrolling feel instant;
    // only the actual frame-decoding/rendering below waits for visibility.
    const tileRef = React.useRef<HTMLDivElement>(null);
    const [isVisible, setIsVisible] = useState(false);
    React.useEffect(() => {
        const el = tileRef.current;
        const root = el?.closest(".vc-gif-folders-grid");
        if (!el || !root) return;
        return observeTileVisibility(root, el, setIsVisible);
    }, []);

    // Rendered from a blob: URL (derived from the durably-cached base64 data) rather
    // than the data: URI directly - see getPlayableSrc for why. isVideo/isDirectMediaUrl
    // are computed from entry.mediaSrc (the real URL), never from displaySrc, since a
    // blob: URL has no host or file extension for those checks to look at.
    const cachedSrc = getPlayableSrc(entry.mediaSrc, restartTick);
    // Fallback used whenever we don't have cached bytes to build a blob: URL from -
    // either caching hasn't finished yet, or it's failed outright (very commonly
    // because this Discord client's CSP allows loading media via <img>/<video> but
    // blocks fetch() to these origins entirely - see cacheGif's circuit breaker).
    // Restarting this path needs the URL to genuinely change: a same-URL remount
    // doesn't reliably force Chromium to re-decode and replay an animation that's
    // already finished, and neither does a harmless #fragment suffix, since neither
    // changes the resource identity the browser's networking/decode layer keys on.
    // A real query parameter does - it's the standard cache-busting technique for
    // exactly this - but on a *signed* CDN link, adding an unrecognized parameter
    // risks invalidating the signature depending on how that server validates it. If
    // that happens once (caught via onError below), stop busting this tile's queries
    // for good and just accept the live link without a restart, rather than trading
    // "frozen but visible" for "broken every 4 seconds".
    const bustedFallback = restartTick === 0 || bustBroken
        ? entry.mediaSrc
        : `${entry.mediaSrc}${entry.mediaSrc.includes("?") ? "&" : "?"}_gfr=${restartTick}`;
    const displaySrc = cachedSrc ?? bustedFallback;
    const isVideo = isVideoUrl(entry.mediaSrc);

    // If we never managed to cache actual bytes for this entry AND the media src we
    // have isn't verifiably direct media, this is a share/page link with no way to
    // preview it inline (most often an already-saved entry from before embed-based
    // resolution was added). Retrying a fetch would just fail the same way every
    // time, so we skip straight to an "open the original" affordance.
    const hasCachedBytes = !!getCachedSrc(entry.mediaSrc);
    const isUnpreviewable = !hasCachedBytes && !isVideo && !isDirectMediaUrl(entry.mediaSrc);

    // Prefer the canvas player (see AnimatedCanvasImage above) whenever we actually
    // have cached bytes for a gif/webp - the only formats that need frame-accurate
    // looping at all (video loops natively via the <video loop> attribute, and a
    // static image has nothing to loop). This is what actually guarantees correct
    // looping now; the <img>-based restart-tick system below only remains as the
    // fallback for uncached entries, where we don't have bytes to decode from yet.
    const cachedEntry = getCacheEntry(entry.mediaSrc);
    const cachedMimeType = cachedEntry ? /^data:([^;]+);base64,/.exec(cachedEntry.dataUrl)?.[1] ?? null : null;
    const canUseCanvas = !canvasFailed && !isVideo && !!cachedEntry && (cachedMimeType === "image/gif" || cachedMimeType === "image/webp");

    React.useEffect(() => {
        setBroken(false);
        setLoaded(false);
        setRestartTick(0);
        setBustBroken(false);
        setCanvasFailed(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entry.mediaSrc]);

    // Keeps this tile cached whenever it's missing bytes - covers both the initial
    // mount AND the case where the cache gets cleared (or otherwise loses this
    // entry) while the tile is already mounted and visible, e.g. hitting "Clear
    // Cache" mid-session. Without this, a cleared-but-still-mounted tile would sit on
    // the less-reliable <img> restart-tick fallback (see AnimatedCanvasImage above
    // for why the canvas player exists in the first place) until something else -
    // switching folders, reopening the window - happens to remount it and retrigger
    // caching. cacheGif's own in-flight/already-cached checks make calling it again
    // here harmless even if the mount effect above just called it too.
    React.useEffect(() => {
        if (!hasCachedBytes && !isVideo && !isUnpreviewable) {
            cacheGif(entry.mediaSrc);
        }
    }, [hasCachedBytes, entry.mediaSrc, isVideo, isUnpreviewable]);

    // Some GIFs (as opposed to Discord's video-transcoded "gifs") are encoded to stop
    // after a fixed number of loops instead of playing forever, which looks exactly
    // like it's "stuck" once it reaches the last frame. There's no "animation ended"
    // event for <img> gifs, so once we know (from cacheGif's analysis, when caching
    // works) that a file doesn't loop forever - or we simply don't have cache info at
    // all - we periodically force a fresh reload of the image (see displaySrc above),
    // which restarts its animation from frame 1. Only relevant to the <img> fallback
    // path: canUseCanvas tiles drive their own looping forever and never need this.
    React.useEffect(() => {
        if (isVideo || broken || isUnpreviewable || canUseCanvas) return;
        const interval = setInterval(() => {
            const meta = getCacheEntry(entry.mediaSrc);
            // No cache entry at all - never cached, or caching failed outright (very
            // commonly a systemic fetch()-blocking CSP rather than anything
            // file-specific - see cacheGif's circuit breaker) - is treated the same as
            // a confirmed finite loop count. These are exactly the tiles most likely
            // to be stuck, so they need the periodic restart more than anyone.
            // Restarting something that was actually fine all along is harmless;
            // never restarting something that's actually stuck is the bug.
            if (!meta || meta.loopsForever === false) {
                setRestartTick(t => t + 1);
            }
        }, RESTART_INTERVAL_MS);
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entry.mediaSrc, isVideo, broken, isUnpreviewable]);

    function retry() {
        setBroken(false);
        setLoaded(false);
        setBustBroken(false);
        // Bump the tick (not just re-render with the same src) so this is a
        // genuinely different request, not a replay of the exact URL that just
        // failed - some failures can bounce back near-instantly from the browser's
        // own cache of that specific failed request rather than actually hitting the
        // network again.
        setRestartTick(t => t + 1);
        cacheGif(entry.mediaSrc, /* bypassCircuit */ true);
    }

    // Shared by all three media branches below (video/canvas/img), which otherwise
    // repeat both identically.
    const tileMediaClassName = "vc-gif-folders-tile-img" + (loaded ? " vc-gif-folders-tile-loaded" : "");
    function handleInsertClick(e: React.MouseEvent) {
        onInsert(entry, isInstantSendClick(e));
    }

    function handleMediaError() {
        if (!cachedSrc && restartTick > 0 && !bustBroken) {
            // The cache-busting query param added for this restart attempt broke the
            // load - most likely it invalidated a signed CDN URL's signature. Stop
            // busting this tile's queries from now on and fall back to the plain
            // link instead of leaving the tile stuck on the "couldn't load"
            // placeholder every restart interval.
            setBustBroken(true);
            setLoaded(false);
            return;
        }

        // First failure on the plain, unbusted link, with nothing cached: Discord's
        // signed CDN links expire, and that's by far the most common reason an old
        // but otherwise-fine saved GIF stops loading - the attachment is still there,
        // its signature just is not. Ask Discord to reissue a fresh one before
        // giving up; if that works, swap it into the saved entry (see
        // refreshEntryMediaUrl) so this doesn't need to happen again until the new
        // one also eventually expires.
        if (!cachedSrc && restartTick === 0 && refreshState === "idle" && isDiscordCdnUrl(entry.mediaSrc)) {
            setRefreshState("trying");
            refreshAttachmentUrl(entry.mediaSrc).then(fresh => {
                setRefreshState("done");
                if (fresh) {
                    void refreshEntryMediaUrl(folder, entry.id, entry.mediaSrc, fresh);
                    // The entry.mediaSrc change this persists flows back in as a new
                    // prop value, which the mount effect above treats as a fresh
                    // start (resets broken/loaded/restartTick and retries loading) -
                    // nothing else to do here.
                } else {
                    setBroken(true);
                }
            });
            return;
        }

        setBroken(true);
    }

    function openMenu(e: React.MouseEvent) {
        e.preventDefault();
        e.stopPropagation();
        const otherFolders = getFolderNames().filter(name => name !== folder);
        const alreadyIn = foldersContaining(entry.shareSrc);
        ContextMenuApi.openContextMenu(e, () => (
            <Menu.Menu navId="vc-gif-folders-tile-menu" onClose={() => ContextMenuApi.closeContextMenu()}>
                <Menu.MenuItem
                    id="gif-tile-insert"
                    label="Insert into Chat Box"
                    action={() => {
                        insertTextIntoChatInputBox(entry.shareSrc + " ");
                        showToast("Inserted into chat box", Toasts.Type.SUCCESS);
                    }}
                />
                <Menu.MenuItem
                    id="gif-tile-copy"
                    label="Copy Link"
                    action={() => {
                        navigator.clipboard?.writeText(entry.shareSrc);
                        showToast("Copied link to clipboard", Toasts.Type.SUCCESS);
                    }}
                />
                <Menu.MenuItem
                    id="gif-tile-rename"
                    label="Rename"
                    action={() => openGifRenamePrompt(folder, entry)}
                />
                <Menu.MenuItem
                    id="gif-tile-move-folder"
                    label="Move to Folder"
                >
                    {otherFolders.length === 0 ? (
                        <Menu.MenuItem id="gif-tile-move-folder-none" label="No other folders" disabled />
                    ) : (
                        otherFolders.map(name => (
                            <Menu.MenuItem
                                key={name}
                                id={`gif-tile-move-folder-${name}`}
                                label={alreadyIn.includes(name) ? `✓ ${name}` : name}
                                action={() => moveGifToFolder(folder, name, entry.id)}
                            />
                        ))
                    )}
                </Menu.MenuItem>
                <Menu.MenuItem
                    id="gif-tile-move-front"
                    label="Move to First"
                    action={() => moveGifToFront(folder, entry.id)}
                />
                <Menu.MenuItem
                    id="gif-tile-move-back"
                    label="Move to Last"
                    action={() => moveGifToBack(folder, entry.id)}
                />
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="gif-tile-remove"
                    label="Remove from Folder"
                    color="danger"
                    action={() => confirmDeleteGifEntry(folder, entry)}
                />
            </Menu.Menu>
        ));
    }

    return (
        <div
            ref={tileRef}
            className={
                "vc-gif-folders-tile"
                + (isDragging ? " vc-gif-folders-tile-dragging" : "")
                + (isDropTarget ? " vc-gif-folders-tile-drop-target" : "")
            }
            onContextMenu={openMenu}
            title={entry.name}
            data-gif-id={reorderable ? entry.id : undefined}
            onPointerDown={reorderable ? (e: React.PointerEvent) => onTilePointerDown?.(e) : undefined}
        >
            {folderBadge && <div className="vc-gif-folders-tile-badge">{folderBadge}</div>}

            {isUnpreviewable ? (
                <div
                    className="vc-gif-folders-tile-broken"
                    role="button"
                    title={entry.shareSrc}
                    onClick={() => VencordNative.native.openExternal(entry.shareSrc)}
                >
                    <OpenExternalIcon width={18} height={18} />
                    <span>No preview — open original</span>
                </div>
            ) : broken ? (
                <div className="vc-gif-folders-tile-broken" role="button" onClick={retry}>
                    <FolderIcon width={18} height={18} />
                    <span>Couldn't load — tap to retry</span>
                </div>
            ) : !isVisible ? (
                // Not yet scrolled into view (or close to it) - show just the
                // loading placeholder rather than paying the decode/memory cost -
                // especially the canvas player, which holds every frame of an
                // animated tile in memory - for something that isn't even on
                // screen. A folder can have hundreds of entries mounted at once.
                <div className="vc-gif-folders-tile-img" />
            ) : isVideo ? (
                <video
                    key={displaySrc}
                    src={displaySrc}
                    className={tileMediaClassName}
                    autoPlay
                    loop
                    muted
                    playsInline
                    draggable={false}
                    onClick={handleInsertClick}
                    onError={handleMediaError}
                    onLoadedData={() => setLoaded(true)}
                />
            ) : canUseCanvas && cachedEntry && cachedMimeType ? (
                <AnimatedCanvasImage
                    key={entry.mediaSrc}
                    label={entry.name}
                    dataUrl={cachedEntry.dataUrl}
                    mimeType={cachedMimeType}
                    className={tileMediaClassName}
                    onClick={handleInsertClick}
                    onLoad={() => setLoaded(true)}
                    onError={() => {
                        setCanvasFailed(true);
                        setLoaded(false);
                    }}
                />
            ) : (
                <img
                    key={displaySrc}
                    src={displaySrc}
                    decoding="async"
                    referrerPolicy="no-referrer"
                    draggable={false}
                    className={tileMediaClassName}
                    onClick={handleInsertClick}
                    onError={handleMediaError}
                    onLoad={() => setLoaded(true)}
                />
            )}

            <div className="vc-gif-folders-tile-name">{entry.name}</div>

            <div
                className="vc-gif-folders-tile-delete"
                role="button"
                aria-label="Remove this GIF from current group"
                title="Remove this GIF from current group"
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); confirmDeleteGifEntry(folder, entry); }}
            >
                <DeleteIcon width={16} height={16} />
            </div>
        </div>
    );
}

// Shared by the "no search results" and "empty folder" placeholder messages
// below - same reserved min-height either way, so the content area doesn't
// visibly collapse/jump when switching between an empty and populated view.
const EMPTY_STATE_TEXT_STYLE: React.CSSProperties = { margin: "24px 16px", minHeight: 170, display: "flex", alignItems: "center" };

function ManagerModal({ modalProps }: { modalProps: RenderModalProps; }) {
    useForceUpdate();
    const folderNames = getFolderNames();
    const [active, setActive] = useState(folderNames[0] ?? "");
    const [query, setQuery] = useState("");
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    // Modal width - see the layout effects below. gridColumns drives both the
    // grid's actual column count and how much extra width gets added on top of
    // the toolbar-fit buffer, unless freeResize is on, in which case the
    // person's own manual dragging (bounded below by freeResizeTileMin) is
    // what decides it instead.
    const { gridColumns: gridColumnsRaw, freeResize, freeResizeTileMin } = settings.use(["gridColumns", "freeResize", "freeResizeTileMin"]);
    const gridColumns = getGridColumns(gridColumnsRaw);
    // Reused on both grid instances (folder view and search results) below.
    // --vc-gif-folders-tile-min only affects anything while the free-resize
    // class (below) is also present - see that CSS rule's own comment.
    const gridStyle = {
        "--vc-gif-folders-cols": gridColumns,
        "--vc-gif-folders-tile-min": `${freeResizeTileMin}px`
    } as React.CSSProperties;
    const gridClassName = freeResize ? "vc-gif-folders-grid vc-gif-folders-grid-free-resize" : "vc-gif-folders-grid";
    const baseModalWidthRef = React.useRef<number | null>(null);
    const baseModalHeightRef = React.useRef<number | null>(null);
    // False until the width effect below has run at least once - distinguishes
    // "the modal just opened" (honor rememberedWidth, if any) from "gridColumns
    // or freeResize just changed during this session" (always recompute fresh
    // and overwrite whatever was remembered - see the effect's own comment).
    const hasAppliedInitialWidthRef = React.useRef(false);

    // Tears down the width-override stylesheet rules (see setDialogWidth and
    // clearAncestorMaxWidths) when the modal closes, so they don't linger in
    // the document after the fact. Both are created lazily on first use, so
    // nothing needs to create them here - only clean them up.
    React.useEffect(() => {
        return () => {
            document.getElementById(DIALOG_WIDTH_STYLE_ID)?.remove();
            document.getElementById(ANCESTOR_MAXWIDTH_STYLE_ID)?.remove();
            document.getElementById(DIALOG_HEIGHT_STYLE_ID)?.remove();
            document.getElementById(GRID_MAXHEIGHT_STYLE_ID)?.remove();
        };
    }, []);

    // Applies tightenModalChrome once per modal open - see that function's
    // own comment for why this is a direct element lookup rather than a CSS
    // rule. Deliberately the *first* layout effect in this component, ahead
    // of the width/height effects below: those measure the dialog's "natural"
    // size once (baseModalWidthRef/baseModalHeightRef) as the baseline their
    // own math builds on, and that measurement needs to already reflect the
    // shrunk header/footer - otherwise the freed-up space from tightening
    // never reaches the grid, it just becomes dead space between the grid and
    // wherever the (now smaller) footer ends up, since the dialog's overall
    // height and the grid's own max-height would both already be locked in
    // relative to the old, untightened baseline by the time tightening ran.
    // Runs as a layout effect, same as those, so it happens before paint.
    React.useLayoutEffect(() => {
        const dialog = findModalDialogElement();
        if (!dialog) return;
        tightenModalChrome(dialog);
    }, []);

    // Sets the modal's width on open and whenever gridColumns/freeResize/
    // freeResizeTileMin change during the session:
    //  - On open, uses rememberedWidth (the width as of the last manual
    //    resize or setting-driven recompute, persisted across restarts) if
    //    one exists, so the modal reopens the same size it was last left at.
    //  - Whenever gridColumns, freeResize, or freeResizeTileMin themselves
    //    change afterward - a deliberate choice made *during* this session -
    //    recomputes fresh from the toolbar-fit buffer and column count
    //    instead, on the reasoning that picking a specific row count,
    //    toggling Free Resize, or dragging its minimum-size slider is a
    //    more specific, more recent signal than whatever the modal
    //    previously happened to be sized to. That freshly-computed width
    //    then becomes the new rememberedWidth, so the *next* open reflects
    //    this choice rather than snapping back to something older.
    //  - Either way, the result is never allowed below minWidthForColumns -
    //    for a fixed column count in the ordinary case, or "one tile at
    //    freeResizeTileMin" when Free Resize is on (see that function's own
    //    comment for why n=1 is the right floor there).
    // The starting point for the fresh-computation path is measured live off
    // the actual DOM rather than a hardcoded number, since the Modal
    // component's own default width for size="lg" isn't something this
    // plugin controls or can know in advance; only measured once (cached in
    // baseModalWidthRef) so repeated runs of this effect don't re-measure an
    // already-overridden width. Runs as a layout effect (not a regular
    // effect) so the resize happens before paint, avoiding a visible flash
    // at the wrong size.
    React.useLayoutEffect(() => {
        const el = findModalDialogElement();
        if (!el) return; // couldn't find the dialog box either way - nothing to do
        if (baseModalWidthRef.current === null) {
            baseModalWidthRef.current = el.getBoundingClientRect().width;
        }
        const baseWidth = baseModalWidthRef.current;
        if (!baseWidth) return;

        let targetWidth: number;
        if (!hasAppliedInitialWidthRef.current && rememberedWidth) {
            targetWidth = rememberedWidth;
        } else {
            const toolbarBuffer = 180; // room for Delete Folder + the Settings icon to stay on row 1
            const extraColumns = freeResize ? 0 : Math.max(0, gridColumns - 3);
            targetWidth = baseWidth + toolbarBuffer + extraColumns * 150;
        }
        if (!freeResize) {
            targetWidth = Math.max(targetWidth, minWidthForColumns(gridColumns));
        } else {
            targetWidth = Math.max(targetWidth, minWidthForColumns(1, freeResizeTileMin));
        }
        targetWidth = Math.round(targetWidth);

        setDialogWidth(el, targetWidth);
        hasAppliedInitialWidthRef.current = true;
        void persistRememberedWidth(targetWidth);
    }, [gridColumns, freeResize, freeResizeTileMin]);

    // Applies the modal's remembered height on open, if one exists - mirrors
    // the width effect above, but simpler: there's no settings-driven value
    // (like gridColumns) that height ever needs to recompute against, so this
    // only ever needs to run once per open, not react to anything changing
    // afterward. Also grows/shrinks .vc-gif-folders-grid's own max-height by
    // the same amount the dialog itself differs from its natural, un-resized
    // height - see GRID_MAXHEIGHT_STYLE_ID's comment for why - so reopening
    // at a remembered height actually shows the right number of rows instead
    // of just reserving blank space for them.
    React.useLayoutEffect(() => {
        const el = findModalDialogElement();
        if (!el) return;
        baseModalHeightRef.current = el.getBoundingClientRect().height;
        if (rememberedHeight) {
            const targetHeight = Math.round(rememberedHeight);
            setDialogHeight(el, targetHeight);
            setGridMaxHeight(GRID_DEFAULT_MAX_HEIGHT_PX + (targetHeight - baseModalHeightRef.current));
        }
    }, []);

    // Clears any max-width on whatever sits between this plugin's own content
    // and the dialog box (Discord's own body/scroller wrappers - see
    // INVESTIGATION.md Part 8). Growing the dialog box itself (the effect
    // above, or a manual drag) wasn't enough on its own: at 5-6 columns, the
    // grid kept clipping regardless of how wide the dialog got, which pointed
    // at an intermediate wrapper capping its own width independently rather
    // than simply filling whatever the dialog box gives it. Uses the same
    // persistent-stylesheet technique setDialogWidth does (clearAncestorMax
    // Widths), rather than a direct inline-style write - these are React-
    // owned nodes too, exposed to the same reset-on-unrelated-re-render risk
    // that turned out to be the dialog box's actual problem (Part 9). Only
    // ever a no-op for any level that didn't actually have a cap to begin
    // with. Runs once per modal open - this ancestor chain's identity doesn't
    // change while it stays open.
    React.useLayoutEffect(() => {
        const anchor = document.querySelector<HTMLElement>(".vc-gif-folders-search-row");
        const dialog = findModalDialogElement();
        if (!anchor || !dialog || anchor === dialog) return;

        const ancestors: HTMLElement[] = [];
        let el: HTMLElement | null = anchor.parentElement;
        while (el && el !== dialog) {
            ancestors.push(el);
            el = el.parentElement;
        }
        clearAncestorMaxWidths(ancestors);

        return () => {
            document.getElementById(ANCESTOR_MAXWIDTH_STYLE_ID)?.remove();
        };
    }, []);

    // Lets the drag handles below (created once, in an effect that never
    // re-runs while the modal stays open) read the *current*
    // gridColumns/freeResize/freeResizeTileMin rather than whatever they were
    // at the moment the handles were created - all three can change later via
    // the settings menu without the handles themselves needing to be torn
    // down and recreated.
    const gridColumnsRef = React.useRef(gridColumns);
    const freeResizeRef = React.useRef(freeResize);
    const freeResizeTileMinRef = React.useRef(freeResizeTileMin);
    React.useEffect(() => {
        gridColumnsRef.current = gridColumns;
        freeResizeRef.current = freeResize;
        freeResizeTileMinRef.current = freeResizeTileMin;
    }, [gridColumns, freeResize, freeResizeTileMin]);

    // Adds real left/right drag handles to the dialog box, as direct DOM
    // children rather than JSX - the dialog element lives outside what this
    // component actually renders (it's Modal's own root, not ours), so this
    // is the only way to attach something visually flush with its edges.
    // CSS's native `resize` property was tried first, but it only ever offers
    // a browser-drawn grab point in the bottom-right corner, not something
    // grabbable from either side - this gives that directly instead. Runs
    // once per modal open (empty dependency array) and cleans up on close;
    // the dialog element itself doesn't change identity while the modal
    // stays open, so there's nothing to re-run this for.
    React.useLayoutEffect(() => {
        const dialog = findModalDialogElement();
        if (!dialog) return;

        const computedPosition = getComputedStyle(dialog).position;
        const positionWasStatic = computedPosition === "static";
        if (positionWasStatic) dialog.style.position = "relative";

        const cleanups: Array<() => void> = [];
        for (const edge of ["left", "right"] as const) {
            const handle = document.createElement("div");
            handle.className = `vc-gif-folders-resize-handle vc-gif-folders-resize-handle-${edge}`;
            dialog.appendChild(handle);

            let drag: { startX: number; startWidth: number; } | null = null;
            const onPointerDown = (e: PointerEvent) => {
                e.preventDefault();
                drag = { startX: e.clientX, startWidth: dialog.getBoundingClientRect().width };
                handle.setPointerCapture(e.pointerId);
            };
            const onPointerMove = (e: PointerEvent) => {
                if (!drag) return;
                const dx = e.clientX - drag.startX;
                const delta = edge === "right" ? dx : -dx;
                // A fixed column count can no longer fit its tiles below
                // minWidthForColumns(gridColumns) and starts clipping instead
                // of shrinking further. Free Resize has no fixed count to
                // protect, so its floor is instead "one tile's worth of
                // width" at whatever size the freeResizeTileMin slider is
                // set to - minWidthForColumns(1, freeResizeTileMin) rather
                // than a separately hand-picked number, so it can't quietly
                // drift out of sync with the slider's own range.
                const minWidth = freeResizeRef.current
                    ? minWidthForColumns(1, freeResizeTileMinRef.current)
                    : minWidthForColumns(gridColumnsRef.current);
                const newWidth = Math.max(minWidth, Math.min(window.innerWidth * 0.96, drag.startWidth + delta));
                setDialogWidth(dialog, Math.round(newWidth));
            };
            const onPointerUp = () => {
                if (drag) void persistRememberedWidth(Math.round(dialog.getBoundingClientRect().width));
                drag = null;
            };

            handle.addEventListener("pointerdown", onPointerDown);
            handle.addEventListener("pointermove", onPointerMove);
            handle.addEventListener("pointerup", onPointerUp);
            cleanups.push(() => {
                handle.removeEventListener("pointerdown", onPointerDown);
                handle.removeEventListener("pointermove", onPointerMove);
                handle.removeEventListener("pointerup", onPointerUp);
                handle.remove();
            });
        }

        // Top/bottom height handles - same drag mechanics as left/right above,
        // but along the Y axis, and with one extra job: growing/shrinking
        // .vc-gif-folders-grid's own max-height by the same pixel amount the
        // dialog itself just moved, live during the drag (not just on open -
        // see the height-apply-on-open effect above for that half). Without
        // this, the grid would stay capped at whatever max-height it already
        // had while the dialog around it visibly grew or shrank.
        for (const edge of ["top", "bottom"] as const) {
            const handle = document.createElement("div");
            handle.className = `vc-gif-folders-resize-handle-horizontal vc-gif-folders-resize-handle-${edge}`;
            dialog.appendChild(handle);

            let drag: { startY: number; startHeight: number; startGridMaxHeight: number; } | null = null;
            const onPointerDown = (e: PointerEvent) => {
                e.preventDefault();
                const grid = document.querySelector<HTMLElement>(".vc-gif-folders-grid");
                drag = {
                    startY: e.clientY,
                    startHeight: dialog.getBoundingClientRect().height,
                    startGridMaxHeight: grid?.getBoundingClientRect().height ?? GRID_DEFAULT_MAX_HEIGHT_PX
                };
                handle.setPointerCapture(e.pointerId);
            };
            const onPointerMove = (e: PointerEvent) => {
                if (!drag) return;
                const dy = e.clientY - drag.startY;
                const delta = edge === "bottom" ? dy : -dy;
                const newHeight = Math.max(MIN_MODAL_HEIGHT_PX, Math.min(window.innerHeight * 0.92, drag.startHeight + delta));
                setDialogHeight(dialog, Math.round(newHeight));
                setGridMaxHeight(drag.startGridMaxHeight + delta);
            };
            const onPointerUp = () => {
                if (drag) void persistRememberedHeight(Math.round(dialog.getBoundingClientRect().height));
                drag = null;
            };

            handle.addEventListener("pointerdown", onPointerDown);
            handle.addEventListener("pointermove", onPointerMove);
            handle.addEventListener("pointerup", onPointerUp);
            cleanups.push(() => {
                handle.removeEventListener("pointerdown", onPointerDown);
                handle.removeEventListener("pointermove", onPointerMove);
                handle.removeEventListener("pointerup", onPointerUp);
                handle.remove();
            });
        }

        return () => {
            cleanups.forEach(fn => fn());
            if (positionWasStatic) dialog.style.position = "";
        };
    }, []);

    // Relocates the Settings button to sit next to the modal's own close ("X")
    // button, freeing up room in the toolbar (which otherwise needs to fit an
    // icon-only button alongside six text buttons) and matching a more
    // conventional "gear icon next to close" placement. Finds the close button
    // by its accessible name - matching a specific, purpose-built element by
    // what it's labelled, rather than a generic structural landmark, which is
    // what went wrong with role="dialog" in Part 6 (see INVESTIGATION.md Part
    // 8). Not confirmed against a real Discord build - if the close button
    // isn't found this way, settingsPortalTarget stays null and the toolbar's
    // own Settings button (below) stays exactly as it was, so nothing is lost
    // if this guess doesn't land.
    const [settingsPortalTarget, setSettingsPortalTarget] = useState<HTMLElement | null>(null);
    React.useLayoutEffect(() => {
        const dialog = findModalDialogElement();
        const closeButton = dialog?.querySelector<HTMLElement>(
            'button[aria-label="Close" i], button[aria-label*="close" i]'
        );
        if (!closeButton?.parentElement) return;

        const wrapper = document.createElement("div");
        wrapper.className = "vc-gif-folders-header-settings-wrapper";
        closeButton.parentElement.insertBefore(wrapper, closeButton);
        setSettingsPortalTarget(wrapper);

        return () => {
            wrapper.remove();
            setSettingsPortalTarget(null);
        };
    }, []);

    // Export-to-disk progress - see handleExportAllToDisk. isExporting guards
    // against a second click starting a second concurrent gather+export pass;
    // exportProgress drives the button's live "(done/total)" label.
    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState<{ done: number; total: number; } | null>(null);

    // Drag-to-reorder state for the current folder's grid - see reorderGifInFolder.
    // Implemented with plain pointer events rather than the HTML5 Drag and Drop API:
    // Discord's own client listens for drag events globally (it needs to detect
    // files being dragged in from outside the window to upload), and that appeared
    // to intercept/short-circuit dragenter/dragover before this plugin's handlers
    // could reliably see them - drop targets never highlighted, and the dragged
    // tile's state could get stuck since dragend wasn't firing consistently either.
    // Pointer events are a separate system entirely and don't have that conflict.
    const [draggedId, setDraggedId] = useState<string | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);
    const dragStartRef = React.useRef<{ x: number; y: number; id: string; } | null>(null);
    const isDraggingRef = React.useRef(false);
    const overIdRef = React.useRef<string | null>(null);
    const currentFolderRef = React.useRef(active);

    const currentFolder = cache[active] ? active : folderNames[0] ?? "";
    const gifs = cache[currentFolder] ?? [];

    const trimmedQuery = query.trim();
    const isSearching = trimmedQuery.length > 0;

    // Debounced separately from the raw query above: the search input and clear
    // (x) button react to isSearching instantly, since those are tied directly to
    // what's in the text box, not to the results. Everything else that actually
    // switches views (folder tabs, rename/delete/export buttons, the content grid
    // itself) waits for debouncedQuery instead - see showingSearchView below -
    // so the whole view changes as one single step rather than the content area
    // going blank/collapsing and then re-expanding once results are ready.
    // Debouncing also avoids computing and rendering the results grid - the
    // expensive part, since each matching tile mounts a full GifTile, and for an
    // animated one that means decoding every frame fresh (see AnimatedCanvasImage)
    // - on every single keystroke; a single common letter can match hundreds of
    // entries in a large library.
    const [debouncedQuery, setDebouncedQuery] = useState(trimmedQuery);
    React.useEffect(() => {
        const timer = setTimeout(() => setDebouncedQuery(trimmedQuery), 250);
        return () => clearTimeout(timer);
    }, [trimmedQuery]);

    // Whichever view (search results vs the open folder) was showing stays
    // showing, stale but stable, until debouncedQuery catches up - so e.g.
    // narrowing "g" to "gu" keeps "g"'s results on screen rather than clearing
    // them, and the very first keystroke keeps the folder view exactly as it was
    // rather than collapsing to an empty search view first. Folder tabs and the
    // rename/delete/export buttons below switch on this too, so the whole view
    // changes as one single step once results are actually ready, instead of the
    // content area going blank/collapsing and then re-expanding.
    const showingSearchView = debouncedQuery.length > 0;

    const allSearchResults = debouncedQuery ? searchAllFolders(debouncedQuery) : [];
    // Also caps how many tiles actually get mounted at once - even after
    // debouncing, a broad one- or two-letter query can still match far more than
    // anyone is realistically going to scroll through, and there's no reason to
    // pay the mounting/decoding cost for entries the person will never see
    // without narrowing their search further anyway.
    const MAX_SEARCH_RESULTS = 60;
    const searchResults = allSearchResults.slice(0, MAX_SEARCH_RESULTS);
    const hiddenResultCount = allSearchResults.length - searchResults.length;

    React.useEffect(() => {
        if (debouncedQuery) ensureCached(searchResults.map(r => r.entry));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedQuery]);

    React.useEffect(() => {
        if (!isSearching) ensureCached(gifs);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentFolder]);

    React.useEffect(() => {
        currentFolderRef.current = currentFolder;
    }, [currentFolder]);

    const DRAG_THRESHOLD_PX = 6;

    function handleTilePointerDown(e: React.PointerEvent) {
        // Left button (or primary touch point) only - never interferes with
        // right-click (context menu), and a plain click that never moves past the
        // threshold below just falls through to the tile's own onClick as normal.
        if (e.button !== 0) return;
        const id = e.currentTarget.getAttribute("data-gif-id");
        if (!id) return;
        // Belt-and-suspenders alongside the user-select: none in CSS - stops the
        // browser from initiating its own text-selection/drag handling for this
        // gesture at all, which otherwise competes with the pointer tracking below
        // (delayed/inconsistent movement detection, a stray selection-highlight
        // overlay). Doesn't suppress the synthesized "click" for a plain press
        // that never moves past the threshold, so normal insert-on-click still works.
        e.preventDefault();
        dragStartRef.current = { x: e.clientX, y: e.clientY, id };
    }

    React.useEffect(() => {
        function onPointerMove(e: PointerEvent) {
            const start = dragStartRef.current;
            if (!start) return;

            if (!isDraggingRef.current) {
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
                isDraggingRef.current = true;
                setDraggedId(start.id);
            }

            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
            const tileEl = el?.closest<HTMLElement>("[data-gif-id]");
            const overId = tileEl?.getAttribute("data-gif-id") ?? null;
            const resolved = overId && overId !== start.id ? overId : null;
            overIdRef.current = resolved;
            setDropTargetId(resolved);
        }

        function endDrag() {
            const start = dragStartRef.current;
            if (start && isDraggingRef.current && overIdRef.current) {
                void reorderGifInFolder(currentFolderRef.current, start.id, overIdRef.current);
            }
            dragStartRef.current = null;
            isDraggingRef.current = false;
            overIdRef.current = null;
            setDraggedId(null);
            setDropTargetId(null);
        }

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", endDrag);
        // If the pointer leaves the window entirely (e.g. released outside it) or
        // the OS cancels the gesture, don't leave the tile stuck in dragging state.
        window.addEventListener("pointercancel", endDrag);
        return () => {
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", endDrag);
            window.removeEventListener("pointercancel", endDrag);
        };
    }, []);

    function insert(entry: GifEntry, instant = false) {
        const channel = getCurrentChannel();
        if (!channel) {
            showToast("Couldn't find the current channel", Toasts.Type.FAILURE);
            return;
        }

        // If the user clicked "Reply" on a message before opening GIF Folders, the
        // chat bar is showing "Replying to Username" - match what actually typing
        // and sending would do instead of silently sending a plain message and
        // losing that context. Wrapped defensively since this reaches into an
        // internal Discord module not covered by Vencord's stable APIs: if anything
        // here doesn't match this client's version, it just falls back to sending
        // normally rather than failing to send at all.
        let pendingReply: PendingReplyState | undefined;
        try {
            pendingReply = PendingReplyModule?.getPendingReply?.(channel.id);
        } catch (e) {
            logger.warn("Couldn't read pending reply state", e);
        }
        const replyReference = pendingReply?.message?.id ? {
            message_id: pendingReply.message.id,
            channel_id: pendingReply.message.channel_id ?? channel.id,
            guild_id: channel.guild_id || undefined
        } : null;
        // Matches the little "@" toggle Discord shows next to the reply banner -
        // whether the reply also pings the original author.
        const allowedMentions = { parse: ["users", "roles", "everyone"], replied_user: !!pendingReply?.shouldMention };

        function clearPendingReply() {
            if (!replyReference) return;
            // Matches what Discord's own chat bar does immediately after sending a
            // reply: clears the "Replying to Username" banner rather than leaving
            // it active for whatever gets sent next.
            try {
                FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId: channel.id });
            } catch (e) {
                logger.warn("Couldn't clear pending reply state", e);
            }
        }

        function sendAsLink() {
            if (replyReference) {
                // Sent via a direct call to Discord's REST API, using the shape its
                // public API docs specify (message_reference/allowed_mentions in
                // snake_case, at the top level of the request body), rather than
                // through Vencord's sendMessage() wrapper - confirmed via logging
                // that the pending-reply data itself was being read correctly, but
                // the wrapper wasn't carrying messageReference/allowedMentions
                // through to the actual request. This is the one send path that
                // needs that guarantee; the plain (non-reply) send below is
                // untouched since it's worked reliably this whole time.
                RestAPI.post({
                    url: `/channels/${channel.id}/messages`,
                    body: { content: entry.shareSrc, message_reference: replyReference, allowed_mentions: allowedMentions }
                }).then(clearPendingReply).catch(e => {
                    logger.error("Couldn't send reply", e);
                    showToast("Couldn't send GIF - see console for details", Toasts.Type.FAILURE);
                });
            } else {
                // Always (re)send the original share link, never the internally-
                // resolved preview media url - see the shareSrc/mediaSrc split on
                // GifEntry for why.
                sendMessage(channel.id, { content: entry.shareSrc });
            }
        }

        if (isDiscordAttachmentUrl(entry.shareSrc)) {
            // Re-upload the cached bytes as a brand new attachment instead of
            // sending a link to the old one - see sendAsFreshAttachment for why
            // that avoids the "📎 filename" reference text Discord shows above a
            // link to an attachment. Falls back to the normal link-based send
            // below if anything about that doesn't work out, so sending never
            // actually breaks either way.
            sendAsFreshAttachment(channel.id, entry, replyReference, allowedMentions).then(sent => {
                if (sent) clearPendingReply();
                else sendAsLink();
            });
        } else {
            sendAsLink();
        }

        if (instant) {
            // Modifier-click: leave the window open so several GIFs can be fired off
            // in a row. There's no modal-close here to act as "yep, that sent", so
            // toast instead.
            showToast("Sent to chat", Toasts.Type.SUCCESS);
            return;
        }
        modalProps.onClose();
    }

    async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const text = await file.text();
        await importFromJson(text);
    }

    async function handleExportAllToDisk() {
        if (isExporting) return; // already running - ignore a second click rather than starting a second pass

        const { exportGifFileBatch, pickExportFolder } = getNativeApi() ?? {};
        if (!exportGifFileBatch || !pickExportFolder) {
            // Desktop-only: writing real files and showing a native folder picker
            // both need the main-process access native.ts provides, which the
            // web/browser build doesn't have at all.
            showToast("This needs the desktop app - not available here", Toasts.Type.FAILURE);
            return;
        }

        const totalCount = getFolderNames().reduce((sum, name) => sum + (cache[name]?.length ?? 0), 0);
        if (totalCount === 0) {
            showToast("No GIFs saved yet", Toasts.Type.FAILURE);
            return;
        }

        // Ask where to export FIRST, while it's still a cheap, cancelable no-op -
        // backing out costs nothing here. The expensive part (downloading
        // anything not already cached, for potentially hundreds of entries) only
        // starts once the person has actually committed to a destination, rather
        // than making them wait through the whole gather before ever seeing the
        // dialog and only then finding out they can cancel.
        const basePath = await pickExportFolder();
        if (!basePath) return;

        setIsExporting(true);
        setExportProgress({ done: 0, total: totalCount });
        try {
            const result = await exportAllFoldersToDisk(basePath, (done, total) => setExportProgress({ done, total }));
            const skippedNote = result.skipped > 0 ? ` (${result.skipped} skipped - dead links or download failures)` : "";
            showToast(`Exported ${result.written} GIF(s) to ${basePath}${skippedNote}`, Toasts.Type.SUCCESS);
        } catch (e) {
            logger.error("Export to disk failed", e);
            showToast("Couldn't export - see console for details", Toasts.Type.FAILURE);
        } finally {
            setIsExporting(false);
            setExportProgress(null);
        }
    }

    return (
        <Modal
            {...modalProps}
            title="Thunde's GIF Folders"
            size="lg"
            className="vc-gif-folders-modal-root"
            actions={[]}
        >
            <div className="vc-gif-folders-search-row">
                <TextInput
                    value={query}
                    onChange={(v: string) => setQuery(v)}
                    placeholder="Search GIFs by name…"
                />
                {isSearching && (
                    <div className="vc-gif-folders-search-clear" role="button" onClick={() => setQuery("")}>✕</div>
                )}
            </div>

            {!showingSearchView && (
                <div className="vc-gif-folders-tabs">
                    {folderNames.length === 0 && (
                        <Forms.FormText style={{ margin: "16px 0" }}>
                            No folders yet. Create one to start saving GIFs.
                        </Forms.FormText>
                    )}
                    {folderNames.map(name => (
                        <div
                            key={name}
                            className={"vc-gif-folders-tab" + (name === currentFolder ? " vc-gif-folders-tab-active" : "")}
                            onClick={() => setActive(name)}
                        >
                            {name} <span className="vc-gif-folders-tab-count">{cache[name].length}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="vc-gif-folders-toolbar">
                <Forms.FormText style={{ flexGrow: 1, opacity: 0.7 }}>
                    {isSearching && (
                        debouncedQuery !== trimmedQuery
                            ? "Searching\u2026"
                            : hiddenResultCount > 0
                                ? `${allSearchResults.length} result(s) for "${debouncedQuery}" - showing first ${searchResults.length}, refine your search to narrow it down`
                                : `${allSearchResults.length} result(s) for "${debouncedQuery}"`
                    )}
                </Forms.FormText>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json"
                    style={{ display: "none" }}
                    onChange={handleImportFile}
                />
                <Button variant="secondary" size="xs" onClick={() => fileInputRef.current?.click()}>
                    Import
                </Button>
                {!showingSearchView && currentFolder && (
                    <Button
                        variant="secondary"
                        size="xs"
                        onClick={() => downloadText(`${currentFolder}.giffolders.json`, serializeFolder(currentFolder))}
                    >
                        Export Folder
                    </Button>
                )}
                <Button variant="secondary" size="xs" onClick={handleExportAllToDisk} disabled={isExporting}>
                    {isExporting && exportProgress
                        ? `Exporting\u2026 (${exportProgress.done}/${exportProgress.total})`
                        : "Export All to Disk"}
                </Button>
                <Button variant="secondary" size="xs" onClick={clearMediaCache}>
                    Clear Cache ({getMediaCacheSizeLabel()})
                </Button>
                {/* Was the primary action in Discord's own modal footer,
                 * removed in favor of this toolbar (see the Modal call
                 * above) - kept unconditional, unlike Rename/Delete just
                 * below, since creating a folder shouldn't require one to
                 * already be selected first. */}
                <Button variant="secondary" size="xs" onClick={() => openNewFolderPrompt(name => setActive(name))}>
                    + New Folder
                </Button>
                {!showingSearchView && currentFolder && (
                    <>
                        <Button variant="secondary" size="xs" onClick={() => openRenamePrompt(currentFolder)}>
                            Rename Folder
                        </Button>
                        <Button
                            variant="dangerSecondary"
                            size="xs"
                            onClick={() => confirmDeleteFolder(currentFolder, () => setActive(getFolderNames()[0] ?? ""))}
                        >
                            Delete Folder
                        </Button>
                    </>
                )}
                {!settingsPortalTarget && (
                    <Button variant="secondary" size="iconOnly" onClick={openGifFoldersSettingsMenu}>
                        <MainSettingsIcon aria-label="GIF Folders Settings" width={18} height={18} />
                    </Button>
                )}
            </div>

            {settingsPortalTarget && ReactDOM.createPortal(
                <button
                    type="button"
                    className="vc-gif-folders-header-settings-button"
                    aria-label="GIF Folders Settings"
                    onClick={openGifFoldersSettingsMenu}
                >
                    <MainSettingsIcon width={25} height={25} />
                </button>,
                settingsPortalTarget
            )}

            {showingSearchView ? (
                searchResults.length === 0 ? (
                    <Forms.FormText style={EMPTY_STATE_TEXT_STYLE}>
                        No GIFs match "{debouncedQuery}". Try renaming a GIF so it's easier to find later.
                    </Forms.FormText>
                ) : (
                    <div className={gridClassName} style={gridStyle}>
                        {searchResults.map(({ folder, entry }) => (
                            <GifTile key={entry.id} folder={folder} entry={entry} onInsert={insert} folderBadge={folder} />
                        ))}
                    </div>
                )
            ) : (
                currentFolder && (
                    gifs.length === 0 ? (
                        <Forms.FormText style={EMPTY_STATE_TEXT_STYLE}>
                            No GIFs saved in "{currentFolder}" yet. Right click a GIF in chat and choose
                            "Save GIF to" → "{currentFolder}".
                        </Forms.FormText>
                    ) : (
                        <div className={gridClassName} style={gridStyle}>
                            {gifs.map(entry => (
                                <GifTile
                                    key={entry.id}
                                    folder={currentFolder}
                                    entry={entry}
                                    onInsert={insert}
                                    reorderable
                                    isDragging={draggedId === entry.id}
                                    isDropTarget={dropTargetId === entry.id}
                                    onTilePointerDown={handleTilePointerDown}
                                />
                            ))}
                        </div>
                    )
                )
            )}
        </Modal>
    );
}

function openManagerModal() {
    openModal(modalProps => <ManagerModal modalProps={modalProps} />);
}

// Chat-bar entry point icon. This is Discord's own ":gorilla:" (U+1F98D) artwork,
// not just the bare unicode character - Discord renders all of its standard
// emoji using bundled Twemoji images rather than the host OS's emoji font, and
// those can look meaningfully different from each other (different art style,
// sometimes a different animal pose entirely) depending on the OS/font. Using
// the character itself here would follow whatever font this Electron window
// falls back to instead of matching what every other ":gorilla:" in the app
// looks like, so the artwork is embedded directly instead.
//
// Source: assets/svg/1f98d.svg from jdecked/twemoji (the actively-maintained
// continuation of Twitter's original Twemoji, and the same artwork Discord
// itself ships under @discordapp/twemoji). Graphics are CC-BY 4.0; per that
// project's own README a mention in the source is sufficient attribution:
// https://github.com/jdecked/twemoji - Copyright Twitter, Inc and other
// contributors, licensed under CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/).
//
// Mirrors the width/height prop shape of the icons imported from
// "@components/Icons" above so it drops in wherever those are expected - both
// as JSX here and as the bare component reference handed to addChatBarButton
// below.
function GifFoldersIcon({ width = 24, height = 24, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 36 36"
            width={width}
            height={height}
            className={className}
            aria-hidden="true"
        >
            <path fill="#31373D" d="M5 16c0-4-5-3-4 1s3 5 3 5l1-6zm26 0c0-4 5-3 4 1s-3 5-3 5l-1-6z" />
            <path fill="#31373D" d="M32.65 21.736c0 10.892-4.691 14.087-14.65 14.087-9.958 0-14.651-3.195-14.651-14.087S8.042.323 18 .323c9.959 0 14.65 10.521 14.65 21.413z" />
            <path fill="#66757F" d="M27.567 23c1.49-4.458 2.088-7.312-.443-7.312H8.876c-2.532 0-1.933 2.854-.444 7.312C3.504 34.201 17.166 34.823 18 34.823S32.303 33.764 27.567 23z" />
            <path fill="#31373D" d="M15 18.003c0 1.105-.896 2-2 2s-2-.895-2-2c0-1.104.896-1 2-1s2-.105 2 1zm10 0c0 1.105-.896 2-2 2s-2-.895-2-2c0-1.104.896-1 2-1s2-.105 2 1z" />
            <ellipse fill="#31373D" cx="15.572" cy="23.655" rx="1.428" ry="1" />
            <path fill="#31373D" d="M21.856 23.655c0 .553-.639 1-1.428 1-.79 0-1.429-.447-1.429-1 0-.553.639-1 1.429-1s1.428.448 1.428 1z" />
            <path fill="#99AAB5" d="M21.02 21.04c-1.965-.26-3.02.834-3.02.834s-1.055-1.094-3.021-.834c-3.156.417-3.285 3.287-1.939 3.105.766-.104.135-.938 1.713-1.556 1.579-.616 3.247.66 3.247.66s1.667-1.276 3.246-.659.947 1.452 1.714 1.556c1.346.181 1.218-2.689-1.94-3.106z" />
            <path fill="#31373D" d="M24.835 30.021c-1.209.323-3.204.596-6.835.596s-5.625-.272-6.835-.596c-3.205-.854-1.923-1.735 0-1.477 1.923.259 3.631.415 6.835.415 3.205 0 4.914-.156 6.835-.415 1.923-.258 3.204.623 0 1.477z" />
            <path fill="#66757F" d="M4.253 16.625c1.403-1.225-1.078-3.766-2.196-2.544-.341.373.921-.188 1.336 1.086.308.942.001 2.208.86 1.458zm27.493 0c-1.402-1.225 1.078-3.766 2.196-2.544.341.373-.921-.188-1.337 1.086-.306.942 0 2.208-.859 1.458z" />
        </svg>
    );
}

// Hover companion to GifFoldersIcon above - Discord's own ":banana:" (U+1F34C),
// from the same Twemoji set as the gorilla. Swapped in on hover of the chat-bar
// button (see GifFoldersChatBarIcon below) to echo the little animation
// Discord's own emoji-picker chat-bar button does when hovered (it cycles
// through random emoji); a gorilla swapping to a banana on hover felt like the
// natural pairing rather than picking something random.
//
// Source: assets/svg/1f34c.svg from jdecked/twemoji - see the source/license
// note on GifFoldersIcon above, which applies here identically.
function GifFoldersBananaIcon({ width = 24, height = 24, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 36 36"
            width={width}
            height={height}
            className={className}
            aria-hidden="true"
        >
            <path fill="#FFE8B6" d="M28 2c2.684-1.342 5 4 3 13-1.106 4.977-5 9-9 12s-11-1-7-5 8-7 10-13c1.304-3.912 1-6 3-7z" />
            <path fill="#FFD983" d="M31 8c0 3-1 9-4 13s-7 5-4 1 5-7 6-11 2-7 2-3z" />
            <path fill="#FFCC4D" d="M22 20c-.296.592 1.167-3.833-3-6-1.984-1.032-10 1-4 1 3 0 4 2 2 4-.291.292-.489.603-.622.912-.417.346-.873.709-1.378 1.088-2.263 1.697-5.84 4.227-10 7-3 2-4 3-4 4 0 3 9 3 14 1s10-7 10-7l4-4c-3-4-7-2-7-2z" />
            <path fill="#FFE8B6" d="M22 20s1.792-4.729-3-7c-4.042-1.916-8-1-11 1s-2 4-3 5 1 2 3 0 8.316-4.895 11-4c3 1 2 2.999 3 5z" />
            <path fill="#A6D388" d="M26 35h-4c-2 0-3 1-4 1s-2-2 0-2 4 0 5-1 5 2 3 2z" />
            <circle fill="#3E721D" cx="18" cy="35" r="1" />
            <path fill="#FFCC4D" d="M32.208 28S28 35 26 35h-4c-2 0 0-1 1-2s5 0 5-6c0-3 4.208 1 4.208 1z" />
            <path fill="#FFE8B6" d="M26 19c3 0 8 3 7 9s-5 7-7 7h-2c-2 0-1-1 0-2s4 0 4-6c0-3-4-7-6-7 0 0 2-1 4-1z" />
            <path fill="#FFD983" d="M17 21c3 0 5 1 3 3-1.581 1.581-6 5-10 6s-8 1-5-1 9.764-8 12-8z" />
            <path fill="#C1694F" d="M2 31c1 0 1 0 1 .667C3 32.333 3 33 2 33s-1-1.333-1-1.333S1 31 2 31z" />
        </svg>
    );
}

// "GIF" text option (see CHAT_BAR_ICON_LABELS.gif above) - plain styled text
// rather than embedded artwork, since there's no standard Unicode "GIF" emoji
// to source real Twemoji-style art from the way there was for the gorilla and
// banana. Uses currentColor like FolderIcon (from "@components/Icons") does,
// so unlike the two Twemoji options it responds to Discord's normal
// icon-button hover/theme coloring instead of always looking the same.
function GifFoldersTextIcon({ width = 24, height = 24, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <span
            className={`vc-gif-folders-icon-text ${className ?? ""}`}
            style={{ width, height }}
            aria-hidden="true"
        >
            GIF
        </span>
    );
}

function GifFoldersChatBarIcon() {
    const { chatBarIcon } = settings.use(["chatBarIcon"]);

    let icon: React.ReactNode;
    switch (chatBarIcon as ChatBarIconOption) {
        case "folder":
            icon = <FolderIcon width={24} height={24} />;
            break;
        case "gif":
            icon = <GifFoldersTextIcon width={24} height={24} />;
            break;
        case "gorilla":
        default:
            // Both icons are always mounted, stacked on top of each other, and
            // swapped with a pure-CSS opacity cross-fade (see
            // .vc-gif-folders-chatbar-icon-swap and friends in styles.css) keyed
            // off ":hover" on the button's own wrapper element. Doing this in
            // CSS rather than a React onMouseEnter/onMouseLeave handler avoids
            // fighting with ChatBarButton's own hover handling, which already
            // owns those events on the clickable element to drive the "GIF
            // Folders" tooltip popup.
            icon = (
                <div className="vc-gif-folders-chatbar-icon-swap">
                    <GifFoldersIcon width={24} height={24} className="vc-gif-folders-icon-gorilla" />
                    <GifFoldersBananaIcon width={24} height={24} className="vc-gif-folders-icon-banana" />
                </div>
            );
            break;
    }

    return (
        <ChatBarButton tooltip="GIF Folders" onClick={openManagerModal}>
            {icon}
        </ChatBarButton>
    );
}

export default definePlugin({
    name: "GifFolders",
    description: "Save GIFs into multiple custom folders via right click. Rename, reorder, and search your saved GIFs, browse them in a manager popup, and keep them loading instantly with a local cache you can export to share with friends.",
    authors: [{ name: "Thunde", id: 0n }],
    tags: ["Media", "Utility"],
    dependencies: ["ChatInputButtonAPI"],
    settings,

    contextMenus: {
        "message": messageContextMenuPatch,
        "image-context": imageContextMenuPatch,
        "video-context": videoContextMenuPatch
    },

    async start() {
        // Button first, cache load second - on purpose. loadCache() already
        // falls back to a safe empty state internally for each piece it loads
        // (see its own try/catches), so this ordering isn't covering for a
        // known failure - it's making sure that even something unanticipated
        // happening before/during load can never leave the plugin looking
        // "enabled" with no visible way to open it, which is worse than
        // opening to an empty or partially-warm cache.
        addChatBarButton("GifFolders", GifFoldersChatBarIcon, GifFoldersIcon);
        try {
            await loadCache();
        } catch (e) {
            logger.error("Unexpected error during GIF Folders startup load", e);
        }
        void migrateLoopDetection();
        // No background "warm every folder" pass here on purpose - see the chat
        // investigation this follows on from. It used to unconditionally try to
        // cache every saved GIF, in every folder, five seconds after every single
        // Discord launch, regardless of whether the manager was ever opened that
        // session. Once total saved content exceeded the cache budget, that pass
        // could never actually finish - it just kept evicting and re-adding,
        // fighting whatever folder the person actually had open at the time.
        // ManagerModal's own per-folder effect (below, keyed on currentFolder)
        // already warms whichever folder is shown first the moment the window
        // opens, which was the actual goal here - it just does it for one folder,
        // on demand, instead of every folder, unconditionally.
    },

    stop() {
        removeChatBarButton("GifFolders");
    }
});
