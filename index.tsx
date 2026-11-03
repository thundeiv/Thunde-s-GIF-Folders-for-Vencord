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
import { Heading } from "@components/Heading";
import { DeleteIcon, FolderIcon, MainSettingsIcon, OpenExternalIcon, PlusIcon } from "@components/Icons";
import { Paragraph } from "@components/Paragraph";
import { IS_MAC } from "@utils/constants";
import { getCurrentChannel, insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import {
    ConfirmModal,
    ContextMenuApi,
    FluxDispatcher,
    Menu,
    Modal,
    openModal,
    React,
    RestAPI,
    showToast,
    Slider,
    TextInput,
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
        onChange: () => applyCacheBudget(),
        description: "Local cache budget across all folders combined. Past this, the least-recently-viewed GIFs stop being cached locally (they're never deleted from the folder - just re-fetched from their live link next time you view them). Cached files stay on disk and are only loaded when shown, so a bigger cache mostly costs disk space.",
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

/**
 * What's kept in memory (and stored as a small record) for each cached file - just
 * facts about it, never the file itself. The file lives in its own record (see
 * MEDIA_DATA_PREFIX) and is only loaded when a tile, a send or an export needs it.
 */
interface MediaCacheEntry {
    cachedAt: number;
    /** File size in bytes */
    size: number;
    mimeType: string;
    /** The media URL this file belongs to (stored since 3 Nov 2026) */
    src?: string;
    /**
     * A file made by the plugin itself (e.g. a smaller copy, see compressEntry) - it has
     * no link to re-download it from, so it's never evicted or cleared like cache.
     */
    pinned?: true;
    /**
     * In memory only, never stored: this file is still in an old format because
     * converting it failed this session (see migrateLegacyEntry). It's read from the
     * old record when needed, and the old record is left untouched.
     */
    legacy?: true;
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

/** One cached file in the previous format: the whole file as a base64 data: URL */
interface LegacyMediaCacheEntry {
    dataUrl?: unknown;
    cachedAt?: unknown;
    loopsForever?: unknown;
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
const LEGACY_MEDIA_PREFIX = "GifFolders_media_cache_entry_v1:";
// Current format (since 3 Nov 2026). The old one above kept every file as a base64
// data: URL string, and loadCache had to read all of them into memory at startup -
// for a big cache that meant gigabytes of strings held for the whole session. Now each
// file has two records: a small info record (loaded at startup) and the file itself,
// stored as a Blob (kept on disk by the browser, loaded only when shown). Old-format
// entries are converted once, in the background - see runLegacyMigration.
const OLD_META_PREFIX = "GifFolders_media_meta_v1:";
const OLD_DATA_PREFIX = "GifFolders_media_data_v1:";
// v2 (3 Nov 2026): same layout as v1, but keyed by the stronger hashUrl. Records keyed
// by the old 32-bit hash (all three older formats) are converted using the URLs in
// your folders - see loadCache and convertLegacyEntry.
const MEDIA_META_PREFIX = "GifFolders_media_meta_v2:";
const MEDIA_DATA_PREFIX = "GifFolders_media_data_v2:";
const REMEMBERED_WIDTH_KEY = "GifFolders_remembered_width_v1";
const REMEMBERED_HEIGHT_KEY = "GifFolders_remembered_height_v1";
// See INVESTIGATION.md Part 29 - separate from REMEMBERED_HEIGHT_KEY (the
// dialog's own height) on purpose. This remembers the grid's own precisely
// *measured* content-height from the last successful settleGridHeight, so a
// future open can start from a real, previously-confirmed-correct value on
// the very first paint, instead of a same-frame formula guess that's only
// ever approximate (INVESTIGATION.md Part 20) and then visibly corrects a
// moment later.
const REMEMBERED_GRID_CONTENT_HEIGHT_KEY = "GifFolders_remembered_grid_content_height_v1";
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
// Cached files still in the old format, waiting to be converted (see runLegacyMigration).
// They count as cached: anything that needs one converts it on the spot.
// Keyed by the new cache key; says where the old copy is.
interface LegacySource {
    /** The old 32-bit key the old records are stored under */
    oldKey: string;
    /** Which old formats exist for it ("v1" = Blob records, "dataurl" = base64 string) */
    kinds: Array<"v1" | "dataurl">;
    src: string;
}
let pendingLegacy = new Map<string, LegacySource>();
// Old copies still in use this session because converting them failed (see migrationBroken)
const legacySources = new Map<string, LegacySource>();
// Whether the oldest single-record format (MEDIA_CACHE_KEY) still exists
let hasLegacyBlob = false;
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
// See REMEMBERED_GRID_CONTENT_HEIGHT_KEY's own comment and
// INVESTIGATION.md Part 29 - the grid's own last precisely-*measured*
// content-height (from settleGridHeight), not derived from rememberedHeight.
let rememberedGridContentHeight: number | null = null;
let ready = false;
const listeners = new Set<() => void>();
const inFlightFetches = new Map<string, Promise<boolean>>();

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

/**
 * The cache key for a media URL. Two independent 32-bit hashes (djb2 + FNV-1a) give
 * ~64 bits, so two different URLs sharing a key is practically impossible. (Before
 * 3 Nov 2026 only the 32-bit djb2 half was used - see oldHashUrl - which made a rare
 * mix-up of two GIFs possible.)
 */
function hashUrl(url: string): string {
    let a = 5381;
    let b = 0x811c9dc5;
    for (let i = 0; i < url.length; i++) {
        const c = url.charCodeAt(i);
        a = ((a << 5) + a + c) | 0;
        b = Math.imul(b ^ c, 0x01000193);
    }
    return (a >>> 0).toString(36) + "_" + (b >>> 0).toString(36);
}

/** The previous 32-bit cache key - only used to find and convert old cache records */
function oldHashUrl(url: string): string {
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

// Old cache records that no saved GIF refers to are only cleaned up when the folders
// themselves loaded fine - otherwise every record would look unused
let foldersLoadedOk = false;

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
        foldersLoadedOk = true;
    } catch (e) {
        logger.error("Failed to load GIF folders from DataStore", e);
        foldersLoadedOk = false;
        cache = {};
        for (const name of DEFAULT_FOLDERS) cache[name] = [];
    }

    try {
        // Only the small info records are read here - the files themselves stay on
        // disk until something needs one (see requestBlob)
        const allKeys = (await DataStore.keys()).filter((k): k is string => typeof k === "string");
        const idsWith = (prefix: string) => allKeys.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
        const metaIds = idsWith(MEDIA_META_PREFIX);
        const dataIds = new Set(idsWith(MEDIA_DATA_PREFIX));
        const legacyIds = idsWith(LEGACY_MEDIA_PREFIX);

        // Start from a clean slate - nothing loaded from an earlier run may outlive it
        for (const key of [...blobUrlCache.keys()]) releaseBlobUrl(key);
        clearCachedBlobs();
        mediaCache = {};
        const metas = metaIds.length > 0 ? await DataStore.getMany<MediaCacheEntry>(metaIds.map(id => MEDIA_META_PREFIX + id)) : [];
        const incomplete = new Set<string>();
        metaIds.forEach((id, i) => {
            const meta = metas[i];
            if (meta && typeof meta.size === "number" && typeof meta.mimeType === "string" && dataIds.has(id)) mediaCache[id] = meta;
            else incomplete.add(id);
        });
        // A file without its info record (or the other way round) can only be left
        // over from an interrupted write - neither half is usable on its own
        for (const id of dataIds) if (!mediaCache[id]) incomplete.add(id);
        if (incomplete.size > 0) {
            await DataStore.delMany([...incomplete].flatMap(id => [MEDIA_META_PREFIX + id, MEDIA_DATA_PREFIX + id]));
        }

        // Older records are keyed by the old 32-bit hash, which can't be turned back
        // into a URL - so match them up through the URLs your saved GIFs use
        const srcsByOldKey = new Map<string, Set<string>>();
        for (const entries of Object.values(cache)) {
            for (const entry of entries ?? []) {
                const oldKey = oldHashUrl(entry.mediaSrc);
                if (!srcsByOldKey.has(oldKey)) srcsByOldKey.set(oldKey, new Set());
                srcsByOldKey.get(oldKey)!.add(entry.mediaSrc);
            }
        }
        const oldDataIds = new Set(idsWith(OLD_DATA_PREFIX));
        const oldKinds = new Map<string, Array<"v1" | "dataurl">>();
        for (const id of idsWith(OLD_META_PREFIX)) if (oldDataIds.has(id)) oldKinds.set(id, ["v1"]);
        for (const id of legacyIds) oldKinds.set(id, [...(oldKinds.get(id) ?? []), "dataurl"]);
        // A v1 file without its info record (or the other way round) is unusable
        const halfOld = [...idsWith(OLD_META_PREFIX), ...oldDataIds].filter(id => !oldKinds.get(id)?.includes("v1"));

        pendingLegacy = new Map();
        legacySources.clear();
        const removable: string[] = [];
        for (const [oldKey, kinds] of oldKinds) {
            const srcs = srcsByOldKey.get(oldKey);
            const oldRecords = kinds.flatMap(kind => kind === "v1" ? [OLD_META_PREFIX + oldKey, OLD_DATA_PREFIX + oldKey] : [LEGACY_MEDIA_PREFIX + oldKey]);
            if (!srcs || srcs.size !== 1) {
                // No saved GIF uses it (removed GIF, or a link that changed), or two
                // saved GIFs share the old key so it can't be told which one it is.
                // Either way it's only a cached copy - those GIFs get cached again.
                if (foldersLoadedOk) removable.push(...oldRecords);
                if (srcs && srcs.size > 1) logger.warn("Two saved GIFs shared an old cache key - dropping that cached copy so neither shows the wrong file", [...srcs]);
                continue;
            }
            const src = [...srcs][0];
            const key = hashUrl(src);
            if (mediaCache[key]) removable.push(...oldRecords); // converted before, old copy not deleted yet
            else pendingLegacy.set(key, { oldKey, kinds, src });
        }
        if (foldersLoadedOk) removable.push(...halfOld.flatMap(id => [OLD_META_PREFIX + id, OLD_DATA_PREFIX + id]));
        if (removable.length > 0) await DataStore.delMany(removable);
        hasLegacyBlob = allKeys.includes(MEDIA_CACHE_KEY);
    } catch (e) {
        logger.error("Failed to load GIF media cache from DataStore", e);
        mediaCache = {};
        pendingLegacy = new Map();
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

    try {
        const storedGridContentHeight = await DataStore.get<number>(REMEMBERED_GRID_CONTENT_HEIGHT_KEY);
        rememberedGridContentHeight = typeof storedGridContentHeight === "number" && storedGridContentHeight > 0 ? storedGridContentHeight : null;
    } catch (e) {
        logger.error("Failed to load GIF Folders remembered grid content height from DataStore", e);
        rememberedGridContentHeight = null;
    }

    ready = true;
    notify();
}

async function persist() {
    try {
        await DataStore.set(DATA_KEY, cache);
    } catch (e) {
        logger.error("Failed to save GIF folders to DataStore", e);
        showToast({ text: "Couldn't save GIF folders — see console for details", variant: "critical" });
    }
    notify();
}

/** The info record as stored - never includes the in-memory-only `legacy` flag */
function storedMeta(entry: MediaCacheEntry): MediaCacheEntry {
    const { cachedAt, size, mimeType, loopsForever, src, pinned } = entry;
    const out: MediaCacheEntry = { cachedAt, size, mimeType };
    if (loopsForever !== undefined) out.loopsForever = loopsForever;
    if (src) out.src = src;
    if (pinned) out.pinned = true;
    return out;
}

/** The old records (by old key) behind a not-yet-converted file */
function oldRecordKeys(source: LegacySource): string[] {
    return source.kinds.flatMap(kind => kind === "v1"
        ? [OLD_META_PREFIX + source.oldKey, OLD_DATA_PREFIX + source.oldKey]
        : [LEGACY_MEDIA_PREFIX + source.oldKey]);
}

/** Re-saves just the small info records (e.g. a refreshed cachedAt) - never the files */
async function persistMediaCacheEntries(keys: Iterable<string>) {
    const pairs: [string, MediaCacheEntry][] = [];
    for (const key of new Set(keys)) {
        const entry = mediaCache[key];
        if (entry && !entry.legacy) pairs.push([MEDIA_META_PREFIX + key, storedMeta(entry)]);
    }
    if (pairs.length === 0) return;
    try {
        await DataStore.setMany(pairs);
    } catch (e) {
        logger.error("Failed to save GIF media cache entries to DataStore", e);
    }
}

/** Deletes every stored record for these cached files, in any format */
async function deleteMediaCacheEntries(keys: Iterable<string>) {
    const storeKeys = Array.from(new Set(keys)).flatMap(key => {
        const source = legacySources.get(key) ?? pendingLegacy.get(key);
        return [MEDIA_META_PREFIX + key, MEDIA_DATA_PREFIX + key, ...(source ? oldRecordKeys(source) : [])];
    });
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
    // Files the plugin made itself (pinned) aren't cache - they never count or get evicted
    let total = Object.values(mediaCache).reduce((sum, e) => sum + (e.pinned ? 0 : e.size), 0) + incomingBytes;
    if (total <= budget) return [];

    const byOldest = Object.keys(mediaCache).filter(k => !mediaCache[k].pinned).sort((a, b) => mediaCache[a].cachedAt - mediaCache[b].cachedAt);
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
/** Trims the cache right away after the size limit is lowered, instead of waiting for the next download */
function applyCacheBudget() {
    const evicted = evictOldMediaCacheEntries(0);
    if (evicted.length === 0) return;
    void deleteMediaCacheEntries(evicted);
    notify();
}

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

/**
 * See REMEMBERED_GRID_CONTENT_HEIGHT_KEY and INVESTIGATION.md Part 29.
 * Called from settleGridHeight's own finish() every time it successfully
 * computes a precise value - not just on drag-release like
 * persistRememberedHeight, since a plain modal-open settle (no drag
 * involved) is exactly the case this exists to improve on the *next* open.
 */
async function persistRememberedGridContentHeight(contentHeightPx: number) {
    rememberedGridContentHeight = contentHeightPx;
    try {
        await DataStore.set(REMEMBERED_GRID_CONTENT_HEIGHT_KEY, contentHeightPx);
    } catch (e) {
        logger.error("Failed to save GIF Folders remembered grid content height to DataStore", e);
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
    const removed = (cache[name] ?? []).map(e => e.mediaSrc);
    delete cache[name];
    await persist();
    await forgetLocalFilesIfUnused(removed);
}

async function saveGifToFolder(folder: string, shareSrc: string, mediaSrc?: string) {
    if (!cache[folder]) cache[folder] = [];
    if (cache[folder].some(g => g.shareSrc === shareSrc)) {
        showToast({ text: `Already in "${folder}"`, variant: "default" });
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
    showToast({ text: `Saved GIF to "${folder}"`, variant: "success" });
    // Warm the cache right away so it's instant next time the folder is opened.
    cacheGif(resolvedMediaSrc);
}

async function removeGifFromFolder(folder: string, id: string) {
    if (!cache[folder]) return;
    const removed = cache[folder].filter(g => g.id === id).map(e => e.mediaSrc);
    cache[folder] = cache[folder].filter(g => g.id !== id);
    await persist();
    showToast({ text: `Removed GIF from "${folder}"`, variant: "default" });
    await forgetLocalFilesIfUnused(removed);
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
 * Moves the dragged folder to take the dropped-on folder's position, shifting
 * the rest - same semantics as reorderGifInFolder above. Folder order is just
 * Object.keys(cache)'s insertion order (cache is a plain object, not an
 * array), and a JS object has no way to reorder its own existing keys in
 * place, so this rebuilds `cache` from scratch, key by key, in the new order.
 */
async function reorderFolder(draggedName: string, targetName: string) {
    if (draggedName === targetName || !cache[draggedName] || !cache[targetName]) return;
    const names = Object.keys(cache);
    const fromIndex = names.indexOf(draggedName);
    const toIndex = names.indexOf(targetName);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = names.splice(fromIndex, 1);
    names.splice(toIndex, 0, moved);
    const reordered: FolderMap = {};
    for (const name of names) reordered[name] = cache[name];
    cache = reordered;
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
    showToast({ text: `Moved to the front of "${folder}"`, variant: "success" });
}

async function moveGifToBack(folder: string, id: string) {
    const list = cache[folder];
    if (!list) return;
    const idx = list.findIndex(g => g.id === id);
    if (idx === -1 || idx === list.length - 1) return;
    const [item] = list.splice(idx, 1);
    list.push(item);
    await persist();
    showToast({ text: `Moved to the back of "${folder}"`, variant: "success" });
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
        showToast({ text: `Already in "${toFolder}"`, variant: "default" });
        return;
    }

    const [item] = list.splice(idx, 1);
    cache[toFolder].unshift(item);
    await persist();
    showToast({ text: `Moved to "${toFolder}"`, variant: "success" });
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
        let blob = isCachedSrc(entry.mediaSrc) ? await requestBlob(entry.mediaSrc) : null;
        if (!blob) {
            await cacheGif(entry.mediaSrc, true);
            blob = await requestBlob(entry.mediaSrc);
        }
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
//
// mediaCache (in memory) only holds small facts about each cached file. The files
// themselves are stored as Blobs in their own records and loaded on demand through
// requestBlob - a tile asks for its file only once it's visible. Recently used Blobs
// are kept in a small in-memory LRU (blobCache) so re-showing them is instant. A Blob
// read back from IndexedDB is a handle to data the browser keeps on disk, so holding
// one costs next to no memory until it's actually decoded.

/** Whether this media has a local copy (including old-format ones still waiting to be converted) */
function isCachedId(key: string): boolean {
    return !!mediaCache[key] || pendingLegacy.has(key);
}

function isCachedSrc(mediaSrc: string): boolean {
    return isCachedId(hashUrl(mediaSrc));
}

function getCacheEntry(mediaSrc: string): MediaCacheEntry | null {
    return mediaCache[hashUrl(mediaSrc)] ?? null;
}

// In-memory only, never persisted: blob: URLs for the <img>/<video> players. We
// deliberately don't use data: URIs - Chromium's animated-image decoder does not
// reliably animate certain formats (notably animated WebP, which Discord attachments
// use a lot) from a data: URI, even though the exact same bytes animate perfectly fine
// from a blob: URL or a normal network fetch.
//
// Each entry also remembers which "restart tick" (see GifTile) it was minted for.
// createObjectURL() always returns a brand new opaque URL, even for byte-identical
// content, and a genuinely new URL is exactly what's needed to force Chromium to
// treat a restart as a fresh, independently-decoded resource rather than reattaching
// to whatever frame an animation that already finished its native loop count was
// left on - reusing the same blob: URL string (as before) doesn't reliably do that.
const blobUrlCache = new Map<string, { tick: number; url: string; }>();

// Uses the browser's built-in base64 conversion when it has one (much faster than a
// per-character JS loop for multi-MB files), with the old loops as a fallback.
function base64ToBytes(base64: string): Uint8Array {
    const native = (Uint8Array as unknown as { fromBase64?(s: string): Uint8Array; }).fromBase64;
    if (native) return native.call(Uint8Array, base64);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
    const native = (bytes as unknown as { toBase64?(): string; }).toBase64;
    if (native) return native.call(bytes);
    let binary = "";
    // Build the binary string in chunks - String.fromCharCode(...bytes) on a large
    // typed array can blow the call stack (each byte becomes a separate argument).
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

/** Splits a base64 data: URL (the old storage format, and JSON exports) into its bytes and type */
function parseDataUrl(dataUrl: string): { bytes: Uint8Array; mimeType: string; } | null {
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx === -1) return null;
    const mimeMatch = /^data:(.*?);base64$/.exec(dataUrl.slice(0, commaIdx));
    if (!mimeMatch) return null;
    try {
        const bytes = base64ToBytes(dataUrl.slice(commaIdx + 1));
        return bytes.length > 0 ? { bytes, mimeType: mimeMatch[1] || "application/octet-stream" } : null;
    } catch {
        return null;
    }
}

/** Reads a GIF/WebP's own loop count - see MediaCacheEntry.loopsForever */
function detectLoopsForever(bytes: Uint8Array, mimeType: string, url = ""): boolean | undefined {
    // The loop-count readers scan bytes.buffer, so it has to be exactly this file
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    if (mimeType === "image/gif" || (!mimeType.startsWith("image/webp") && GifExtRegex.test(url))) {
        try {
            return getGifLoopCount(buffer) === 0;
        } catch {
            return undefined;
        }
    }
    if (mimeType === "image/webp" || WebpExtRegex.test(url)) {
        // Only a confirmed loop count of 0 (infinite) counts as "safe to leave alone".
        // Anything else - a positive count, or an ANIM chunk that couldn't be read -
        // is assumed to possibly stop and need periodic restarts. Restarting a file
        // that was fine all along is harmless; never restarting one that's stuck is
        // the bug this guards against.
        try {
            return getWebpLoopCount(buffer) === 0;
        } catch {
            return false;
        }
    }
    return undefined;
}

// Recently used cached files, keyed like mediaCache, so showing, restarting or
// sending them again needs no read at all. Least-recently-used entries are dropped
// past the byte budget - a dropped one is just read from storage again next time.
const BLOB_CACHE_MAX_BYTES = 150 * 1024 * 1024;
const blobCache = new Map<string, Blob>(); // Map keeps insertion order = LRU order
let blobCacheBytes = 0;

function storeCachedBlob(key: string, blob: Blob) {
    dropCachedBlob(key);
    blobCache.set(key, blob);
    blobCacheBytes += blob.size;
    for (const [oldKey, oldBlob] of blobCache) {
        if (blobCacheBytes <= BLOB_CACHE_MAX_BYTES || blobCache.size <= 1) break;
        blobCache.delete(oldKey);
        blobCacheBytes -= oldBlob.size;
    }
}

function dropCachedBlob(key: string) {
    const blob = blobCache.get(key);
    if (!blob) return;
    blobCache.delete(key);
    blobCacheBytes -= blob.size;
}

function clearCachedBlobs() {
    blobCache.clear();
    blobCacheBytes = 0;
}

/** An already-loaded file, if there is one - never starts a load */
function peekLoadedBlob(mediaSrc: string): Blob | null {
    const key = hashUrl(mediaSrc);
    return isCachedId(key) ? blobCache.get(key) ?? null : null;
}

function toBlob(value: unknown, mimeType: string): Blob | null {
    if (value instanceof Blob) return value.type ? value : new Blob([value], { type: mimeType });
    if (value instanceof ArrayBuffer) return new Blob([value], { type: mimeType });
    if (ArrayBuffer.isView(value)) return new Blob([value as ArrayBufferView as BlobPart], { type: mimeType });
    return null;
}

/** "missing" = there is no usable stored file; "error" = reading failed (it may still be there) */
async function readStoredBlob(key: string, mimeType: string): Promise<Blob | "missing" | "error"> {
    let value: unknown;
    try {
        value = await DataStore.get(MEDIA_DATA_PREFIX + key);
    } catch (e) {
        logger.warn("Couldn't read a cached file", key, e);
        return "error";
    }
    return toBlob(value, mimeType) ?? "missing";
}

// Set if this Chromium can't keep Blobs in IndexedDB - files are then stored as raw
// ArrayBuffers instead (works everywhere, but has to be read into memory to be used)
let storeFilesAsBuffers = false;

/**
 * Stores one cached file and its info record, then reads the file back to make sure
 * it really arrived. Returns the stored (disk-backed) Blob, or null if anything failed.
 * The file is written first and the info record second, in one transaction: if the
 * file can't be stored, no info record is left pointing at nothing.
 */
async function writeCacheEntry(key: string, meta: MediaCacheEntry, blob: Blob): Promise<Blob | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const payload = storeFilesAsBuffers ? await blob.arrayBuffer() : blob;
            await DataStore.setMany([[MEDIA_DATA_PREFIX + key, payload], [MEDIA_META_PREFIX + key, storedMeta(meta)]]);
        } catch (e) {
            if (!storeFilesAsBuffers && (e as { name?: string; })?.name === "DataCloneError") {
                logger.info("This client can't store Blobs in IndexedDB, storing cached files as ArrayBuffers instead");
                storeFilesAsBuffers = true;
                continue;
            }
            logger.error("Couldn't store a cached file", key, e);
            return null;
        }

        const stored = await readStoredBlob(key, meta.mimeType);
        if (stored instanceof Blob && stored.size === meta.size) {
            try {
                // Actually read a little, so a record that exists but whose data is
                // unreadable doesn't count as stored
                await stored.slice(0, Math.min(16, stored.size)).arrayBuffer();
                // In ArrayBuffer mode the read-back copy is in memory anyway - keep the original
                return storeFilesAsBuffers ? blob : stored;
            } catch (e) {
                logger.error("A cached file was stored but can't be read back", key, e);
                return null;
            }
        }
        logger.error("A cached file didn't read back correctly after storing it", key);
        return null;
    }
    return null;
}

/** Small concurrency limiter, so many tiles converting at once can't spike memory */
function createLimiter(max: number) {
    let active = 0;
    const waiting: Array<() => void> = [];
    return async function run<T>(fn: () => Promise<T>): Promise<T> {
        if (active >= max) await new Promise<void>(resolve => waiting.push(resolve));
        active++;
        try {
            return await fn();
        } finally {
            active--;
            waiting.shift()?.();
        }
    };
}
const legacySlots = createLimiter(3);

// ---------- One-time conversion of the old cache format ----------
//
// Each old-format entry is converted on its own: read it, write the new records,
// read the new file back to verify it, and only then delete the old record. If
// anything goes wrong the old record is left exactly as it was. Discord being closed
// halfway is fine - the next start simply continues with whatever is left.

// Set when storing a converted file fails - most likely the disk/quota, so further
// attempts this session would fail too. Everything left keeps working from the old
// records (see readLegacyBlob) and conversion is tried again next start.
let migrationBroken = false;
let migrationRun = 0;
const legacyInFlight = new Map<string, Promise<void>>();

function migrateLegacyEntry(key: string): Promise<void> {
    const existing = legacyInFlight.get(key);
    if (existing) return existing;
    const promise = legacySlots(() => convertLegacyEntry(key)).finally(() => legacyInFlight.delete(key));
    legacyInFlight.set(key, promise);
    return promise;
}

/** Reads an old copy (any older format) as bytes + type, or null if it's not usable */
async function readOldCopy(source: LegacySource): Promise<{ blob: Blob; mimeType: string; cachedAt?: number; loopsForever?: boolean; bytes?: Uint8Array; } | "error" | null> {
    try {
        if (source.kinds.includes("v1")) {
            const [meta, data] = await DataStore.getMany<unknown>([OLD_META_PREFIX + source.oldKey, OLD_DATA_PREFIX + source.oldKey]);
            const m = meta as Partial<MediaCacheEntry> | undefined;
            const mimeType = typeof m?.mimeType === "string" ? m.mimeType : "application/octet-stream";
            const blob = toBlob(data, mimeType);
            if (blob && blob.size > 0) {
                return { blob, mimeType, cachedAt: typeof m?.cachedAt === "number" ? m.cachedAt : undefined, loopsForever: typeof m?.loopsForever === "boolean" ? m.loopsForever : undefined };
            }
        }
        if (source.kinds.includes("dataurl")) {
            const old = await DataStore.get<LegacyMediaCacheEntry>(LEGACY_MEDIA_PREFIX + source.oldKey);
            const parsed = typeof old?.dataUrl === "string" ? parseDataUrl(old.dataUrl) : null;
            if (parsed) {
                return {
                    blob: new Blob([parsed.bytes as BlobPart], { type: parsed.mimeType }),
                    bytes: parsed.bytes,
                    mimeType: parsed.mimeType,
                    cachedAt: typeof old?.cachedAt === "number" ? old.cachedAt : undefined,
                    loopsForever: typeof old?.loopsForever === "boolean" ? old.loopsForever : undefined
                };
            }
        }
        return null;
    } catch (e) {
        logger.warn("Couldn't read an old-format cached file", source.oldKey, e);
        return "error";
    }
}

async function convertLegacyEntry(key: string): Promise<void> {
    const source = pendingLegacy.get(key);
    if (!source) return; // handled meanwhile

    if (mediaCache[key] && !mediaCache[key].legacy) {
        // A new-format copy exists already (e.g. downloaded again meanwhile)
        pendingLegacy.delete(key);
        try {
            await DataStore.delMany(oldRecordKeys(source));
        } catch { /* harmless leftover, cleaned up next start */ }
        return;
    }

    const old = await readOldCopy(source);
    if (old === "error" || !old) {
        // Not readable or not convertible - leave the old records exactly as they are
        if (!old) logger.warn("Skipping an old-format cached file that can't be read", source.oldKey);
        pendingLegacy.delete(key);
        return;
    }

    let loopsForever = old.loopsForever;
    if (loopsForever === undefined && (old.mimeType === "image/gif" || old.mimeType === "image/webp")) {
        loopsForever = detectLoopsForever(old.bytes ?? new Uint8Array(await old.blob.arrayBuffer()), old.mimeType);
    }
    const meta: MediaCacheEntry = {
        cachedAt: old.cachedAt ?? Date.now(),
        size: old.blob.size,
        mimeType: old.mimeType,
        loopsForever,
        src: source.src
    };

    if (!migrationBroken) {
        const stored = await writeCacheEntry(key, meta, old.blob);
        if (stored) {
            mediaCache[key] = meta;
            pendingLegacy.delete(key);
            storeCachedBlob(key, stored);
            try {
                // Only now that the new copy is confirmed are the old ones removed
                await DataStore.delMany(oldRecordKeys(source));
            } catch (e) {
                logger.warn("Converted a cached file but couldn't delete its old copy (it'll be removed next start)", key, e);
            }
            return;
        }
        migrationBroken = true;
        logger.error("Stopping the cache conversion for this session - storing files failed. Nothing was deleted.");
        showToast({ text: "GIF Folders: couldn't convert the cache this time (storage error). Nothing was lost - it keeps using the old format for now.", variant: "critical" });
    }

    // Conversion not possible right now: use the old copy for this session, untouched
    legacySources.set(key, source);
    mediaCache[key] = { ...meta, legacy: true };
    pendingLegacy.delete(key);
    storeCachedBlob(key, old.blob);
}

/** Reads a file that couldn't be converted straight from its old records */
async function readLegacyBlob(key: string): Promise<Blob | "missing" | "error"> {
    const source = legacySources.get(key);
    if (!source) return "missing";
    const old = await readOldCopy(source);
    return old === "error" ? "error" : old ? old.blob : "missing";
}

/** Converts the oldest format (every file in one record), deleting it only if every file made it */
async function migrateLegacyBlob(run: number): Promise<number> {
    let all: Record<string, LegacyMediaCacheEntry> | undefined;
    try {
        all = await DataStore.get<Record<string, LegacyMediaCacheEntry>>(MEDIA_CACHE_KEY);
    } catch (e) {
        logger.warn("Couldn't read the oldest-format media cache, leaving it for next time", e);
        return 0;
    }
    if (!all || typeof all !== "object") return 0;

    // Its entries are keyed by the old 32-bit hash too
    const srcByOldKey = new Map<string, string | null>();
    for (const entries of Object.values(cache)) {
        for (const entry of entries ?? []) {
            const oldKey = oldHashUrl(entry.mediaSrc);
            const known = srcByOldKey.get(oldKey);
            srcByOldKey.set(oldKey, known === undefined || known === entry.mediaSrc ? entry.mediaSrc : null); // null = ambiguous
        }
    }

    let converted = 0;
    let allOk = true;
    for (const [oldKey, old] of Object.entries(all)) {
        if (run !== migrationRun || migrationBroken) return converted;
        const src = srcByOldKey.get(oldKey);
        if (!src) continue; // unused or ambiguous - only a cached copy, it gets cached again
        const key = hashUrl(src);
        if (mediaCache[key]) continue;
        const parsed = typeof old?.dataUrl === "string" ? parseDataUrl(old.dataUrl) : null;
        if (!parsed) continue; // unusable either way
        const meta: MediaCacheEntry = {
            cachedAt: typeof old.cachedAt === "number" ? old.cachedAt : Date.now(),
            size: parsed.bytes.length,
            mimeType: parsed.mimeType,
            loopsForever: typeof old.loopsForever === "boolean" ? old.loopsForever : detectLoopsForever(parsed.bytes, parsed.mimeType),
            src
        };
        const stored = await writeCacheEntry(key, meta, new Blob([parsed.bytes as BlobPart], { type: parsed.mimeType }));
        if (!stored) {
            allOk = false;
            break;
        }
        mediaCache[key] = meta;
        converted++;
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (allOk && run === migrationRun && foldersLoadedOk) {
        try {
            await DataStore.del(MEDIA_CACHE_KEY);
            hasLegacyBlob = false;
        } catch { /* try again next start */ }
    }
    return converted;
}

/** Converts every old-format cached file, one at a time, in the background */
async function runLegacyMigration() {
    const run = ++migrationRun;
    const total = pendingLegacy.size;
    if (total === 0 && !hasLegacyBlob) return;

    logger.info(`Converting ${total} cached file(s) to the new storage format`);
    const announce = total >= 20;
    if (announce) {
        showToast({ text: `GIF Folders: updating your cache (one-time, ${total} files). Everything keeps working meanwhile.`, variant: "default", duration: 6000 });
    }

    let processed = 0;
    for (const key of [...pendingLegacy.keys()]) {
        if (run !== migrationRun || migrationBroken) return;
        if (!pendingLegacy.has(key)) continue; // converted on demand meanwhile
        await migrateLegacyEntry(key);
        if (++processed % 25 === 0) notify(); // keeps the cache size label current
        await new Promise(resolve => setTimeout(resolve, 0)); // let Discord breathe between files
    }

    if (hasLegacyBlob && !migrationBroken && run === migrationRun) await migrateLegacyBlob(run);
    if (run !== migrationRun) return;

    // Every file's size is known now, so the cache budget can be applied
    const evicted = evictOldMediaCacheEntries(0);
    if (evicted.length > 0) await deleteMediaCacheEntries(evicted);
    notify();

    const converted = Object.values(mediaCache).filter(e => !e.legacy).length;
    logger.info(`Cache conversion finished (${converted} file(s) in the new format)`);
    if (announce && !migrationBroken) showToast({ text: "GIF Folders: cache update finished", variant: "success" });
}

// ---------- Loading cached files on demand ----------

const blobLoads = new Map<string, Promise<Blob | null>>();

/**
 * The cached file for this media as a Blob, loading it from storage if needed (and
 * converting it first if it's still in the old format). Null if it isn't cached, or
 * if the stored copy turned out to be unusable - in that case it's dropped from the
 * cache so the live link is used and the file gets cached again.
 */
function requestBlob(mediaSrc: string): Promise<Blob | null> {
    const key = hashUrl(mediaSrc);
    const hot = blobCache.get(key);
    if (hot && isCachedId(key)) {
        storeCachedBlob(key, hot); // mark as recently used
        return Promise.resolve(hot);
    }
    const inFlight = blobLoads.get(key);
    if (inFlight) return inFlight;

    const promise = (async (): Promise<Blob | null> => {
        if (pendingLegacy.has(key)) {
            await migrateLegacyEntry(key);
            const converted = blobCache.get(key);
            if (converted) return converted;
            if (!mediaCache[key]) {
                notify(); // couldn't be converted - tiles fall back to the live link
                return null;
            }
        }

        const meta = mediaCache[key];
        if (!meta) return null;

        const result = meta.legacy ? await readLegacyBlob(key) : await readStoredBlob(key, meta.mimeType);
        if (result instanceof Blob) {
            if (mediaCache[key] === meta) storeCachedBlob(key, result);
            return result;
        }

        if (mediaCache[key] === meta) {
            delete mediaCache[key];
            releaseBlobUrl(key);
            // Only delete stored records when the file is definitely gone - a failed
            // read leaves everything in place for next time. Old-format records are
            // never deleted here.
            if (result === "missing" && !meta.legacy) void deleteMediaCacheEntries([key]);
            notify();
        }
        return null;
    })().finally(() => blobLoads.delete(key));

    blobLoads.set(key, promise);
    return promise;
}

function releaseBlobUrl(key: string) {
    dropCachedBlob(key);
    const existing = blobUrlCache.get(key);
    if (existing) {
        URL.revokeObjectURL(existing.url);
        blobUrlCache.delete(key);
    }
}

/**
 * The blob: URL the <img>/<video> players should use for this already-loaded file.
 * `tick` is GifTile's restart counter - passing an incremented tick always mints a
 * fresh blob: URL; passing the same tick as last time reuses the existing one rather
 * than pointlessly recreating it on every unrelated re-render.
 */
function getPlayableSrc(mediaSrc: string, blob: Blob, tick: number): string {
    const key = hashUrl(mediaSrc);
    const existing = blobUrlCache.get(key);
    if (existing && existing.tick === tick) return existing.url;

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
    // Raw bytes since 3 Nov 2026 (previously base64) - downloadBytes accepts either
    downloadMedia(url: string, maxBytes?: number): Promise<{ bytes?: Uint8Array; base64?: string; mimeType: string; } | null>;
    pickExportFolder(): Promise<string | null>;
    exportGifFileBatch(basePath: string, items: Array<{ dirName: string; filename: string; bytes: Uint8Array; }>): Promise<{ written: number; skipped: number; }>;
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
async function downloadBytes(url: string, maxBytes?: number): Promise<{ bytes: Uint8Array; mimeType: string; } | null> {
    const { downloadMedia } = getNativeApi() ?? {};
    if (downloadMedia) {
        try {
            const result = await downloadMedia(url, maxBytes);
            if (!result) return null;
            let bytes: Uint8Array;
            if (result.bytes) {
                bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes as ArrayBufferLike);
                // The loop-count readers look at bytes.buffer, so make sure it's exactly this file
                if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) bytes = bytes.slice();
            } else if (typeof result.base64 === "string") {
                bytes = base64ToBytes(result.base64);
            } else {
                return null;
            }
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
    return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

/** Downloads and stores a local copy of this media. Resolves true if it's cached (now or already). */
async function cacheGif(url: string, bypassCircuit = false): Promise<boolean> {
    if (!settings.store.enableCache && !isLocalSrc(url)) return false;
    if (fetchCircuitOpen && !bypassCircuit) return false;

    try {
        const u = new URL(url);
        if (isKnownPageUrl(u)) return false;
    } catch { /* relative/odd URL, let fetch decide */ }

    const key = hashUrl(url);
    if (isCachedId(key)) {
        touchMediaCacheEntry(key);
        return true;
    }
    if (isLocalSrc(url)) return false; // a smaller copy has no link to download from

    const existing = inFlightFetches.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<boolean> => {
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
            if (!downloaded) return false;
            const { bytes, mimeType } = downloaded;
            if (bytes.length === 0 || bytes.length > MAX_CACHED_BYTES) return false; // sanity guard

            // GIFs (as opposed to Discord's video-transcoded "gifs") can be encoded to
            // stop after a fixed number of loops, which is exactly the "plays once
            // then freezes on the last frame" bug - detect it once here so the tile
            // knows whether it needs to restart playback itself (see detectLoopsForever).
            const loopsForever = detectLoopsForever(bytes, mimeType, url);

            releaseBlobUrl(key); // in case this is a re-cache (e.g. the user hit "retry"), don't keep serving stale bytes
            const evicted = evictOldMediaCacheEntries(bytes.length);
            const meta: MediaCacheEntry = { cachedAt: Date.now(), size: bytes.length, mimeType, loopsForever, src: url };
            const blob = new Blob([bytes as BlobPart], { type: mimeType });
            mediaCache[key] = meta;
            storeCachedBlob(key, blob);
            consecutiveFetchFailures = 0;
            notify();
            if (evicted.length > 0) void deleteMediaCacheEntries(evicted);

            // Store it on disk. The stored copy then replaces the in-memory one, so
            // this file stops taking up memory once nothing is showing it.
            const stored = await writeCacheEntry(key, meta, blob);
            if (stored && mediaCache[key] === meta && blobCache.get(key) === blob) storeCachedBlob(key, stored);
            return true;
        } catch (e) {
            consecutiveFetchFailures++;
            if (!fetchCircuitOpen && consecutiveFetchFailures >= FETCH_FAILURE_THRESHOLD) {
                fetchCircuitOpen = true;
                logger.warn(
                    `Local caching looks unavailable in this Discord client (${FETCH_FAILURE_THRESHOLD} downloads in a row failed, across different domains). ` +
                    "GIFs will still display and play from their live links; pausing further cache attempts for the rest of this session to stop spamming the console. " +
                    "Tap a tile's \"Couldn't load - tap to retry\" (if any appear) to force a fresh attempt - " +
                    "tapping any one of them also retries every other tile stuck the same way, a few at a time.",
                );
            } else if (!fetchCircuitOpen) {
                logger.warn("Couldn't cache GIF (this is often just a CORS restriction - the GIF will still display, just won't be cached locally)", url, e);
            }
            return false;
        } finally {
            inFlightFetches.delete(key);
        }
    })();

    inFlightFetches.set(key, promise);
    return promise;
}

async function ensureCached(entries: GifEntry[], concurrency = 4) {
    if (!settings.store.enableCache || entries.length === 0) return;
    const queue = entries.filter(e => !isCachedSrc(e.mediaSrc));
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
    migrationRun++; // stops a conversion in progress
    const keep = new Set(Object.keys(mediaCache).filter(key => mediaCache[key].pinned));
    for (const key of [...blobUrlCache.keys()]) if (!keep.has(key)) releaseBlobUrl(key);
    for (const key of [...blobCache.keys()]) if (!keep.has(key)) dropCachedBlob(key);
    for (const key of Object.keys(mediaCache)) if (!keep.has(key)) delete mediaCache[key];
    pendingLegacy.clear();
    legacySources.clear();
    try {
        // Every cache record in any format, except files the plugin made itself
        const keepRecords = new Set([...keep].flatMap(key => [MEDIA_META_PREFIX + key, MEDIA_DATA_PREFIX + key]));
        const all = (await DataStore.keys()).filter((k): k is string => typeof k === "string");
        const doomed = all.filter(k => (k.startsWith("GifFolders_media_") && !keepRecords.has(k)));
        if (doomed.length > 0) await DataStore.delMany(doomed);
        hasLegacyBlob = false;
    } catch (e) {
        logger.error("Failed to clear the GIF media cache", e);
    }
    notify();
    showToast({ text: "Cleared local GIF cache", variant: "default" });
}

function getMediaCacheSizeLabel(): string {
    const bytes = Object.values(mediaCache).reduce((sum, e) => sum + (e.pinned ? 0 : e.size), 0);
    const budget = getMaxTotalCacheBytes();
    const mb = bytes / (1024 * 1024);
    const usedLabel = bytes === 0 && pendingLegacy.size === 0 ? "empty" : mb < 0.1 ? "<0.1 MB" : `${mb.toFixed(1)} MB`;
    const converting = pendingLegacy.size > 0 ? ", converting\u2026" : "";
    if (!Number.isFinite(budget)) return `${usedLabel} / unlimited${converting}`;
    return `${usedLabel} / ${(budget / (1024 * 1024)).toFixed(0)} MB${converting}`;
}

// ---------- Export / Import (the practical way to "send a GIF cache to a friend") ----------

/**
 * Builds a folder's JSON export (with each cached file embedded as a data: URL, so a
 * friend gets the files even if links die) as a Blob, one entry at a time - so it
 * never needs one giant string or every file in memory at once.
 */
async function serializeFolder(name: string, includeCache = true): Promise<Blob> {
    let out = new Blob([`{"type":"GifFoldersExport","version":2,"exportedAt":${Date.now()},"folders":{${JSON.stringify(name)}:[`]);
    let first = true;
    for (const e of cache[name] ?? []) {
        const item: Record<string, unknown> = { name: e.name, shareSrc: e.shareSrc, mediaSrc: e.mediaSrc, addedAt: e.addedAt };
        if (includeCache && isCachedSrc(e.mediaSrc)) {
            const blob = await requestBlob(e.mediaSrc);
            if (blob) {
                const mimeType = getCacheEntry(e.mediaSrc)?.mimeType || blob.type || "application/octet-stream";
                item.dataUrl = bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), mimeType);
            }
        }
        // Appending to a Blob keeps earlier parts out of the JS heap
        out = new Blob([out, (first ? "" : ",") + JSON.stringify(item)]);
        first = false;
    }
    return new Blob([out, "]}}"], { type: "application/json" });
}

function downloadBlob(filename: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportFolderToJson(name: string) {
    try {
        if ((cache[name]?.length ?? 0) > 20) showToast({ text: `Preparing "${name}" for export\u2026`, variant: "default" });
        downloadBlob(`${name}.giffolders.json`, await serializeFolder(name));
    } catch (e) {
        logger.error("Folder export failed", e);
        showToast({ text: "Couldn't export this folder - see console for details", variant: "critical" });
    }
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
                let blob = isCachedSrc(entry.mediaSrc) ? await requestBlob(entry.mediaSrc) : null;
                if (!blob) {
                    await cacheGif(entry.mediaSrc, true);
                    blob = await requestBlob(entry.mediaSrc);
                }
                if (!blob) return null; // dead link or similar - just skip it
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (bytes.length === 0) return null;
                // The mime type is already known for certain here - it's how this
                // very entry got cached - so pass it through instead of making
                // deriveExportFilename guess from the URL.
                const mimeType = getCacheEntry(entry.mediaSrc)?.mimeType ?? (blob.type || null);
                return { folder, filename: deriveExportFilename(entry, mimeType), bytes };
            } catch {
                return null;
            } finally {
                done++;
                onProgress?.(done, jobs.length);
            }
        }));

        const batch: Array<{ dirName: string; filename: string; bytes: Uint8Array; }> = [];
        for (const g of gathered) {
            if (!g) { skipped++; continue; }
            const finalName = dedupeExportName(sanitizeExportName(g.filename), usedFileNamesPerFolder[g.folder]);
            usedFileNamesPerFolder[g.folder].add(finalName);
            batch.push({ dirName: dirNameFor[g.folder], filename: finalName, bytes: g.bytes });
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
        showToast({ text: "That file isn't a valid GIF Folders export", variant: "critical" });
        return;
    }

    if (typeof parsed !== "object" || parsed === null) {
        showToast({ text: "That file isn't a valid GIF Folders export", variant: "critical" });
        return;
    }
    const folders = (parsed as Record<string, unknown>).folders;
    if (!folders || typeof folders !== "object") {
        showToast({ text: "That file isn't a valid GIF Folders export", variant: "critical" });
        return;
    }

    let importedGifs = 0;
    let touchedFolders = 0;

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
                const parsed = isCachedId(key) ? null : parseDataUrl(raw.dataUrl);
                // Same per-file limit as downloading - anything bigger is fetched from its link instead
                if (parsed && parsed.bytes.length <= MAX_CACHED_BYTES) {
                    const meta: MediaCacheEntry = {
                        cachedAt: Date.now(),
                        size: parsed.bytes.length,
                        mimeType: parsed.mimeType,
                        loopsForever: detectLoopsForever(parsed.bytes, parsed.mimeType, mediaSrc),
                        src: mediaSrc,
                        // A plugin-made file has no link to come back from - keep it like the original
                        ...(isLocalSrc(mediaSrc) ? { pinned: true as const } : {})
                    };
                    const stored = await writeCacheEntry(key, meta, new Blob([parsed.bytes as BlobPart], { type: parsed.mimeType }));
                    if (stored) mediaCache[key] = meta;
                }
            }
        }
    }

    await persist();
    // Imported files count toward the cache budget like any other
    const evicted = evictOldMediaCacheEntries(0);
    if (evicted.length > 0) await deleteMediaCacheEntries(evicted);
    notify();

    showToast({ text: `Imported ${importedGifs} GIF(s) into ${touchedFolders} folder(s)`, variant: "success" });
}

// ---------- Making smaller copies ----------
//
// "Make Smaller Copy" (tile right-click menu) re-encodes a cached GIF/image at a
// lower resolution - and, if needed, fewer frames - until it fits a target size, and
// adds the result to the same folder as a new entry. Browsers can decode GIFs but
// can't encode them, so the GIF encoder (palette, LZW, frame deltas) lives here.
// The copy has no link of its own: its file is stored pinned (never evicted or
// cleared), and sending it uploads the file.

const LOCAL_SRC_PREFIX = "gif-folders-local://";

/** A file made by the plugin itself (a smaller copy) rather than one from a link */
function isLocalSrc(src: string): boolean {
    return src.startsWith(LOCAL_SRC_PREFIX);
}

function formatMB(bytes: number): string {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? `${mb.toFixed(0)} MB` : mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

class ByteWriter {
    private chunks: Uint8Array[] = [];
    private buf = new Uint8Array(1 << 16);
    private pos = 0;
    private written = 0;
    byte(b: number) {
        if (this.pos === this.buf.length) this.flush();
        this.buf[this.pos++] = b;
    }
    word(w: number) {
        this.byte(w & 255);
        this.byte((w >> 8) & 255);
    }
    bytes(arr: ArrayLike<number>) {
        for (let i = 0; i < arr.length; i++) this.byte(arr[i]);
    }
    get size() {
        return this.written + this.pos;
    }
    private flush() {
        if (this.pos === 0) return;
        this.chunks.push(this.buf.slice(0, this.pos));
        this.written += this.pos;
        this.pos = 0;
    }
    toBlob(type: string) {
        this.flush();
        return new Blob(this.chunks as BlobPart[], { type });
    }
}

// LZW dictionary: (prefix code * 256 + next index) -> code. Stamped with a generation
// number so resetting it (every 4096 codes) doesn't mean clearing a million entries.
const lzwStamp = new Int32Array(4096 * 256);
const lzwCode = new Int16Array(4096 * 256);
let lzwGeneration = 0;

/** Palette index 255 is always the transparent one (also used to skip unchanged pixels) */
const TRANSPARENT_INDEX = 255;

/**
 * Lets the LZW writer swap a pixel's palette index for another one that looks close
 * enough, whenever that continues the dictionary string it's in the middle of
 * ("lossy LZW", the same idea as gifsicle's --lossy). Longer strings mean far fewer
 * codes, so the file shrinks a lot while every pixel stays within `limit` of its real
 * color - at full resolution, instead of the blur that shrinking the GIF costs.
 * Swaps that change nothing on screen (drawing the color that's already showing
 * instead of a transparent "keep" pixel, and the other way round) are always allowed,
 * even in fast mode.
 */
interface LzwLossy {
    /** The real frame (full size, RGBA) and where the stored rectangle sits in it */
    rgba: Uint8ClampedArray;
    frameWidth: number;
    x0: number;
    y0: number;
    rectWidth: number;
    /** Palette index on screen at each full-frame pixel (255 = nothing yet); null when the frame replaces the whole picture */
    shown: Uint8Array | null;
    palette: Uint8Array;
    /** Largest allowed weighted color distance from the real pixel; 0 = only invisible swaps */
    limit: number;
    /** Per palette index: other indices that might be close enough, nearest first */
    neighbors: Uint8Array[] | null;
}

/**
 * Writes palette indices as a GIF image data block (LZW, 8-bit minimum code size).
 * With `lossy`, `pixels` is updated in place to the values actually written.
 */
function writeLzw(w: ByteWriter, pixels: Uint8Array, lossy?: LzwLossy) {
    const minCodeSize = 8;
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let next = endCode + 1;
    const block = new Uint8Array(255);
    let blockLen = 0;
    let acc = 0;
    let accBits = 0;

    const pushByte = (b: number) => {
        block[blockLen++] = b;
        if (blockLen === 255) {
            w.byte(255);
            w.bytes(block);
            blockLen = 0;
        }
    };
    const emit = (code: number) => {
        acc |= code << accBits;
        accBits += codeSize;
        while (accBits >= 8) {
            pushByte(acc & 255);
            acc >>>= 8;
            accBits -= 8;
        }
    };
    const reset = () => {
        if (++lzwGeneration === 0x7fffffff) {
            lzwStamp.fill(0);
            lzwGeneration = 1;
        }
        codeSize = minCodeSize + 1;
        next = endCode + 1;
    };

    // Lossy swaps: only looked at when the plain next pixel would end the string
    const rgba = lossy?.rgba, shown = lossy?.shown ?? null, palette = lossy?.palette;
    const limit = lossy?.limit ?? 0, neighbors = lossy?.neighbors ?? null;
    const rectWidth = lossy?.rectWidth ?? 1, frameWidth = lossy?.frameWidth ?? 0;
    const x0 = lossy?.x0 ?? 0, y0 = lossy?.y0 ?? 0;
    const T = TRANSPARENT_INDEX;
    const substitute = (i: number, k: number, base: number): number => {
        const fi = (y0 + ((i / rectWidth) | 0)) * frameWidth + x0 + (i % rectWidth);
        const s = shown ? shown[fi] : T;
        const p = fi * 4;
        const opaque = rgba![p + 3] >= 128;
        const r = rgba![p], g = rgba![p + 1], b = rgba![p + 2];
        if (k === T) {
            // "Keep" shows s - drawing s itself looks exactly the same
            if (s === T) return -1;
            if (lzwStamp[base + s] === lzwGeneration) return s;
            if (limit > 0 && neighbors && opaque) {
                for (const a of neighbors[s]) {
                    if (lzwStamp[base + a] !== lzwGeneration) continue;
                    const dr = r - palette![a * 3], dg = g - palette![a * 3 + 1], db = b - palette![a * 3 + 2];
                    if (dr * dr * 2 + dg * dg * 4 + db * db * 3 <= limit) return a;
                }
            }
            return -1;
        }
        if (!opaque) return -1;
        if (s !== T && lzwStamp[base + T] === lzwGeneration) {
            if (s === k) return T;
            if (limit > 0) {
                const dr = r - palette![s * 3], dg = g - palette![s * 3 + 1], db = b - palette![s * 3 + 2];
                if (dr * dr * 2 + dg * dg * 4 + db * db * 3 <= limit) return T;
            }
        }
        if (limit > 0 && neighbors) {
            for (const a of neighbors[k]) {
                if (lzwStamp[base + a] !== lzwGeneration) continue;
                const dr = r - palette![a * 3], dg = g - palette![a * 3 + 1], db = b - palette![a * 3 + 2];
                if (dr * dr * 2 + dg * dg * 4 + db * db * 3 <= limit) return a;
            }
        }
        return -1;
    };

    w.byte(minCodeSize);
    reset();
    emit(clearCode);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
        const k = pixels[i];
        const base = prefix * 256;
        const slot = base + k;
        if (lzwStamp[slot] === lzwGeneration) {
            prefix = lzwCode[slot];
            continue;
        }
        if (lossy) {
            const alt = substitute(i, k, base);
            if (alt >= 0) {
                pixels[i] = alt;
                prefix = lzwCode[base + alt];
                continue;
            }
        }
        emit(prefix);
        if (next < 4096) {
            lzwStamp[slot] = lzwGeneration;
            lzwCode[slot] = next++;
            // The decoder adds its matching entry one code later - this keeps the
            // code width switching at exactly the same point on both sides
            if (next > (1 << codeSize) && codeSize < 12) codeSize++;
        } else {
            emit(clearCode);
            reset();
        }
        prefix = k;
    }
    emit(prefix);
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    emit(endCode);
    while (accBits > 0) {
        pushByte(acc & 255);
        acc >>>= 8;
        accBits -= 8;
    }
    if (blockLen > 0) {
        w.byte(blockLen);
        w.bytes(block.subarray(0, blockLen));
    }
    w.byte(0);
}

/** For each palette color, the other colors within `radius` (weighted distance), nearest first */
function paletteNeighbors(palette: Uint8Array, radius: number): Uint8Array[] {
    const n = palette.length / 3;
    const lists: Uint8Array[] = [];
    for (let c = 0; c < n; c++) {
        const near: Array<[number, number]> = [];
        for (let a = 0; a < n; a++) {
            if (a === c) continue;
            const dr = palette[c * 3] - palette[a * 3], dg = palette[c * 3 + 1] - palette[a * 3 + 1], db = palette[c * 3 + 2] - palette[a * 3 + 2];
            const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
            if (d <= radius) near.push([d, a]);
        }
        near.sort((x, y) => x[0] - y[0]);
        lists.push(Uint8Array.from(near.slice(0, 24).map(x => x[1])));
    }
    while (lists.length < 256) lists.push(new Uint8Array(0));
    return lists;
}

/**
 * Median-cut palette from a 15-bit color histogram. Each palette color is the average
 * of the real pixel colors that fell into its box, so flat colors come out exact.
 */
function buildPalette(counts: Float64Array, sums: Float64Array, maxColors: number): Uint8Array {
    const colors: number[] = [];
    for (let c = 0; c < 32768; c++) if (counts[c] > 0) colors.push(c);
    const channel = (c: number, ch: number) => (c >> (10 - ch * 5)) & 31;

    let boxes: number[][] = colors.length > 0 ? [colors] : [];
    while (boxes.length < maxColors) {
        let bestIndex = -1, bestScore = 0, bestChannel = 0;
        boxes.forEach((box, index) => {
            if (box.length < 2) return;
            let total = 0;
            const lo = [31, 31, 31], hi = [0, 0, 0];
            for (const c of box) {
                total += counts[c];
                for (let ch = 0; ch < 3; ch++) {
                    const v = channel(c, ch);
                    if (v < lo[ch]) lo[ch] = v;
                    if (v > hi[ch]) hi[ch] = v;
                }
            }
            const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
            const ch = ranges.indexOf(Math.max(...ranges));
            const score = ranges[ch] * Math.sqrt(total);
            if (score > bestScore) {
                bestScore = score;
                bestIndex = index;
                bestChannel = ch;
            }
        });
        if (bestIndex < 0) break;
        const box = boxes[bestIndex].sort((x, y) => channel(x, bestChannel) - channel(y, bestChannel));
        let half = 0, running = 0;
        for (const c of box) half += counts[c];
        half /= 2;
        let cut = 1;
        for (let i = 0; i < box.length - 1; i++) {
            running += counts[box[i]];
            if (running >= half) { cut = i + 1; break; }
        }
        boxes = [...boxes.slice(0, bestIndex), box.slice(0, cut), box.slice(cut), ...boxes.slice(bestIndex + 1)];
    }

    const palette = new Uint8Array(boxes.length * 3);
    boxes.forEach((box, i) => {
        let n = 0, r = 0, g = 0, b = 0;
        for (const c of box) {
            n += counts[c];
            r += sums[c * 3];
            g += sums[c * 3 + 1];
            b += sums[c * 3 + 2];
        }
        palette[i * 3] = Math.round(r / n);
        palette[i * 3 + 1] = Math.round(g / n);
        palette[i * 3 + 2] = Math.round(b / n);
    });
    return palette;
}

interface DecodedImageSource {
    decode(options: { frameIndex: number; }): Promise<{ image: DecodedVideoFrame; }>;
}

/** Reads frame `index` scaled to w×h as RGBA pixels, plus its duration in microseconds */
async function readScaledFrame(decoder: DecodedImageSource, index: number, ctx: OffscreenCanvasRenderingContext2D, w: number, h: number) {
    const { image } = await decoder.decode({ frameIndex: index });
    try {
        const bitmap = await createImageBitmap(image as unknown as ImageBitmapSource, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return { rgba: ctx.getImageData(0, 0, w, h).data, duration: image.duration };
    } finally {
        image.close();
    }
}

const yieldToDiscord = () => new Promise(resolve => setTimeout(resolve, 0));

interface GifEncodeOptions {
    /** Lossy LZW: how far (per color channel, 0-255) a pixel may be from its real color */
    lossy?: number;
    /** Pixels within this far (per channel) of what's already on screen count as unchanged */
    threshold?: number;
    /** How many frames the palette is built from */
    paletteFrames?: number;
    /** Match colors to the palette at 6 bits per channel instead of 5 */
    fineColors?: boolean;
    /** Stop early (blob: null) once the file is bigger than this */
    abortAbove?: number;
}

/**
 * Encodes an animated (or single-frame) image as a GIF at w×h, keeping every
 * `frameStep`-th frame (skipped frames' time is added to the kept one).
 * loopCount: 0 = forever, n = that many times, null = play once (as in the original).
 * `size` is the file's size - or, when it stopped early, a rough guess of what it would have been.
 */
async function encodeGif(
    decoder: DecodedImageSource, frameCount: number, w: number, h: number, frameStep: number, loopCount: number | null,
    onFrame?: (done: number, total: number) => void, options: GifEncodeOptions = {}
): Promise<{ blob: Blob | null; size: number; }> {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const kept: number[] = [];
    for (let i = 0; i < frameCount; i += frameStep) kept.push(i);

    // Pass 1: palette from a sample of frames, and whether anything is see-through
    const counts = new Float64Array(32768);
    const sums = new Float64Array(32768 * 3);
    let transparentPixels = 0, sampledPixels = 0;
    const sampleCount = Math.min(options.paletteFrames ?? 16, kept.length);
    for (let s = 0; s < sampleCount; s++) {
        const { rgba } = await readScaledFrame(decoder, kept[Math.floor(s * kept.length / sampleCount)], ctx, w, h);
        for (let p = 0; p < rgba.length; p += 4) {
            sampledPixels++;
            if (rgba[p + 3] < 128) { transparentPixels++; continue; }
            const c = ((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3);
            counts[c]++;
            sums[c * 3] += rgba[p];
            sums[c * 3 + 1] += rgba[p + 1];
            sums[c * 3 + 2] += rgba[p + 2];
        }
        await yieldToDiscord();
    }
    const palette = buildPalette(counts, sums, 255);
    const transparent = TRANSPARENT_INDEX;
    const hasAlpha = transparentPixels > sampledPixels * 0.001;

    const fine = !!options.fineColors;
    const lut = new Int16Array(fine ? 1 << 18 : 32768).fill(-1);
    const nearest = (r: number, g: number, b: number) => {
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < palette.length; i += 3) {
            const dr = r - palette[i], dg = g - palette[i + 1], db = b - palette[i + 2];
            const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
            if (d < bestDist) { bestDist = d; best = i / 3; }
        }
        return best;
    };
    // Per-channel errors -> the weighted distance used everywhere here (weights 2+4+3)
    const lossyLimit = 9 * (options.lossy ?? 0) ** 2;
    const thresholdLimit = 9 * (options.threshold ?? 0) ** 2;
    const lossy: LzwLossy = {
        rgba: new Uint8ClampedArray(0), frameWidth: w, x0: 0, y0: 0, rectWidth: w, shown: null, palette,
        limit: lossyLimit, neighbors: lossyLimit > 0 ? paletteNeighbors(palette, lossyLimit * 4) : null
    };

    const out = new ByteWriter();
    out.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // "GIF89a"
    out.word(w);
    out.word(h);
    out.byte(0xf7); // global color table, 8 bits per channel, 256 entries
    out.byte(0);
    out.byte(0);
    const table = new Uint8Array(768);
    table.set(palette);
    out.bytes(table);
    if (loopCount !== null) {
        out.bytes([0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01]); // NETSCAPE2.0
        out.word(Math.min(loopCount, 65535));
        out.byte(0);
    }

    // Pass 2: every kept frame. Opaque animations only store the rectangle that
    // changed since the previous frame, with unchanged pixels left transparent - the
    // same trick most GIF optimizers use. Animations with see-through pixels store
    // whole frames (each replaces the last), since "unchanged" can't be told apart
    // from "now transparent" there. `shown` is what's on screen after each frame.
    let shown: Uint8Array | null = null;
    const current = new Uint8Array(w * h);
    const draw = new Uint8Array(w * h);
    for (let k = 0; k < kept.length; k++) {
        const { rgba, duration } = await readScaledFrame(decoder, kept[k], ctx, w, h);
        // A kept frame also covers the frames skipped after it (assumed equally long)
        const span = Math.min(frameStep, frameCount - kept[k]);
        const delay = Math.max(2, Math.round((duration ?? 100000) * span / 10000));

        for (let p = 0, i = 0; p < rgba.length; p += 4, i++) {
            if (rgba[p + 3] < 128) { current[i] = transparent; continue; }
            const c = fine
                ? ((rgba[p] >> 2) << 12) | ((rgba[p + 1] >> 2) << 6) | (rgba[p + 2] >> 2)
                : ((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3);
            let idx = lut[c];
            if (idx < 0) idx = lut[c] = nearest(rgba[p], rgba[p + 1], rgba[p + 2]);
            current[i] = idx;
        }

        let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
        let pixels = current;
        const delta = !!shown && !hasAlpha;
        if (delta) {
            const on = shown!;
            x0 = w; y0 = h; x1 = -1; y1 = -1;
            for (let y = 0, i = 0; y < h; y++) {
                for (let x = 0; x < w; x++, i++) {
                    const c = current[i], s = on[i];
                    let changed = c !== transparent && c !== s;
                    if (changed && thresholdLimit > 0 && s !== transparent) {
                        const p = i * 4;
                        const dr = rgba[p] - palette[s * 3], dg = rgba[p + 1] - palette[s * 3 + 1], db = rgba[p + 2] - palette[s * 3 + 2];
                        if (dr * dr * 2 + dg * dg * 4 + db * db * 3 <= thresholdLimit) changed = false;
                    }
                    draw[i] = changed ? c : transparent;
                    if (changed) {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                }
            }
            if (x1 < 0) { x0 = 0; y0 = 0; x1 = 0; y1 = 0; } // nothing changed: one see-through pixel
            const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
            pixels = new Uint8Array(rw * rh);
            for (let y = 0; y < rh; y++) pixels.set(draw.subarray((y + y0) * w + x0, (y + y0) * w + x0 + rw), y * rw);
        }
        const rw = x1 - x0 + 1;

        // Graphic control: disposal 1 (keep) for opaque deltas, 2 (clear) for see-through frames
        out.bytes([0x21, 0xf9, 0x04, (hasAlpha ? 2 : 1) << 2 | 1]);
        out.word(delay);
        out.byte(transparent);
        out.byte(0);
        out.byte(0x2c);
        out.word(x0);
        out.word(y0);
        out.word(rw);
        out.word(y1 - y0 + 1);
        out.byte(0);
        lossy.rgba = rgba;
        lossy.x0 = x0;
        lossy.y0 = y0;
        lossy.rectWidth = rw;
        lossy.shown = delta ? shown : null;
        writeLzw(out, pixels, lossy);

        if (!delta) {
            if (!hasAlpha) shown = new Uint8Array(pixels);
        } else {
            const on = shown!;
            for (let j = 0, y = y0; y <= y1; y++) {
                for (let x = x0, i = y * w + x0; x <= x1; x++, i++, j++) {
                    if (pixels[j] !== transparent) on[i] = pixels[j];
                }
            }
        }
        onFrame?.(k + 1, kept.length);
        if (options.abortAbove && out.size > options.abortAbove) {
            return { blob: null, size: Math.round(out.size * kept.length / (k + 1)) };
        }
        await yieldToDiscord();
    }
    out.byte(0x3b);
    if (options.abortAbove && out.size > options.abortAbove) return { blob: null, size: out.size };
    const blob = out.toBlob("image/gif");
    return { blob, size: blob.size };
}

/**
 * How close an image is to the original, as PSNR in dB (higher = closer; ~40+ looks
 * identical). Both are RGBA at the same size; see-through pixels are compared by
 * their visible (alpha-weighted) color plus the alpha itself.
 */
function imageError(a: Uint8ClampedArray, b: Uint8ClampedArray): { sum: number; count: number; } {
    let sum = 0;
    for (let p = 0; p < a.length; p += 4) {
        const aa = a[p + 3], ba = b[p + 3];
        if (aa === 255 && ba === 255) {
            const d0 = a[p] - b[p], d1 = a[p + 1] - b[p + 1], d2 = a[p + 2] - b[p + 2];
            sum += d0 * d0 + d1 * d1 + d2 * d2;
        } else {
            for (let c = 0; c < 3; c++) {
                const d = (a[p + c] * aa - b[p + c] * ba) / 255;
                sum += d * d;
            }
            sum += (aa - ba) * (aa - ba);
        }
    }
    return { sum, count: a.length / 4 * 3 };
}
const toPsnr = (sum: number, count: number) => 10 * Math.log10(255 * 255 / Math.max(1e-6, sum / count));

/** Picture size used to compare results with the original (full size, up to about 0.6 megapixels) */
function scoringSize(width: number, height: number) {
    const s = Math.min(1, Math.sqrt(600000 / (width * height)));
    return [Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s))] as const;
}

/**
 * "Best quality" for animations: instead of only shrinking the picture, it tries
 * stronger and stronger lossy-GIF settings, finds the largest size that fits with
 * each, scores every result against the original frames (at the original size, so
 * blur from shrinking counts against it), and keeps the one closest to the original.
 */
async function smallerGifBest(
    decoder: DecodedImageSource, frameCount: number, width: number, height: number, loopCount: number | null,
    originalSize: number, targetBytes: number, onProgress?: (text: string) => void
): Promise<Blob | null> {
    const ImageDecoderCtor = (window as unknown as { ImageDecoder: WebCodecsImageDecoderCtor; }).ImageDecoder;
    const sizeFor = (scale: number) => [Math.max(16, Math.round(width * scale)), Math.max(16, Math.round(height * scale))] as const;
    const baseStep = Math.max(1, Math.ceil(frameCount / 600));

    // Reference frames from the original, at the size results are compared at
    const [sw, sh] = scoringSize(width, height);
    const scoreCanvas = new OffscreenCanvas(sw, sh);
    const scoreCtx = scoreCanvas.getContext("2d", { willReadFrequently: true })!;
    const refCache = new Map<number, Uint8ClampedArray>();
    const reference = async (index: number) => {
        let ref = refCache.get(index);
        if (!ref) refCache.set(index, ref = new Uint8ClampedArray((await readScaledFrame(decoder, index, scoreCtx, sw, sh)).rgba));
        return ref;
    };
    const score = async (blob: Blob, frameStep: number) => {
        const out = new ImageDecoderCtor({ data: new Uint8Array(await blob.arrayBuffer()), type: "image/gif" });
        try {
            await out.tracks.ready;
            const n = Math.ceil(frameCount / frameStep);
            let sum = 0, count = 0;
            for (const k of new Set([0, Math.floor(n / 3), Math.floor(n * 2 / 3), n - 1])) {
                const { rgba } = await readScaledFrame(out, k, scoreCtx, sw, sh);
                const e = imageError(await reference(k * frameStep), rgba);
                sum += e.sum;
                count += e.count;
            }
            return toPsnr(sum, count);
        } finally {
            out.close();
        }
    };

    // One knob for both lossy settings (per-channel color error): lossy LZW = q,
    // "counts as unchanged" = 0.6 q. Measured on a 26 MB cartoon GIF at full size:
    // q 12 -> 57% of the size, q 20 -> 25%, q 40 -> 8%.
    const settings = (q: number): GifEncodeOptions => ({ lossy: q, threshold: q * 0.6, fineColors: true, abortAbove: targetBytes });
    const qMax = 48;
    let tries = 0;
    const maxTries = 16;
    const encode = async (q: number, scale: number, frameStep: number) => {
        const [w, h] = sizeFor(scale);
        tries++;
        return encodeGif(decoder, frameCount, w, h, frameStep, loopCount,
            (done, total) => onProgress?.(`Best quality: try ${tries} (${scale >= 1 ? "full size" : `${w}\u00d7${h}`}, strength ${Math.round(q)}) - frame ${done} of ${total}`),
            settings(q));
    };

    /** The gentlest setting that fits at this size (log-size interpolation, up to 5 encodes) */
    const gentlestFit = async (scale: number, frameStep: number) => {
        let lo = -1, loSize = 0; // strongest known too big
        let hi = -1, hiSize = 0, hiBlob: Blob | null = null; // gentlest known to fit
        // File size falls roughly exponentially with q (about 6% per step)
        let q = Math.min(qMax, Math.max(0, Math.log(originalSize / targetBytes) / 0.06));
        for (let attempt = 0; attempt < 5 && tries < maxTries; attempt++) {
            const result = await encode(q, scale, frameStep);
            if (result.blob) { hi = q; hiSize = result.size; hiBlob = result.blob; } else { lo = q; loSize = result.size; }
            if (hi >= 0 && (hi === 0 || (lo >= 0 && hi - lo <= 1.5))) break;
            if (lo >= qMax) break; // even the strongest setting doesn't fit here
            let next: number;
            if (lo >= 0 && hi >= 0) {
                const t = Math.log(loSize / targetBytes) / Math.log(loSize / hiSize);
                next = lo + (hi - lo) * Math.min(0.85, Math.max(0.15, t));
            } else if (hi >= 0) {
                next = Math.max(0, hi - Math.log(targetBytes / hiSize) / 0.06 - 1);
                if (next >= hi - 0.5) break; // just fits already
            } else {
                next = Math.min(qMax, lo + Math.log(loSize / targetBytes) / 0.06 + 1);
            }
            q = next;
        }
        return hiBlob ? { blob: hiBlob, q: hi, scale } : null;
    };

    /** The largest size that fits with this setting (up to 3 encodes) */
    const largestFit = async (q: number, frameStep: number, start: number) => {
        let fit: { blob: Blob; scale: number; q: number; } | null = null;
        let tooBig = Infinity;
        let scale = Math.min(1, start);
        for (let attempt = 0; attempt < 3 && tries < maxTries; attempt++) {
            const result = await encode(q, scale, frameStep);
            let next: number;
            if (result.blob) {
                if (!fit || scale > fit.scale) fit = { blob: result.blob, scale, q };
                if (scale >= 1) break;
                next = Math.min(1, scale * Math.sqrt(targetBytes / result.size) * 0.985);
                if (tooBig < Infinity) next = Math.min(next, (scale + tooBig) / 2);
                if (next < scale * 1.03) break; // already within ~3% of the best size
            } else {
                tooBig = Math.min(tooBig, scale);
                next = scale * Math.sqrt(targetBytes / result.size) * 0.97;
                if (fit) next = Math.max(next, (fit.scale + scale) / 2);
                if (fit && next < fit.scale * 1.03) break;
            }
            if (next < 0.06) break;
            scale = next;
        }
        return fit;
    };

    // 1. Full size, with the gentlest lossy setting that fits. Shrinking the picture
    //    blurs every edge, which costs far more quality than lossy compression does.
    const candidates: Array<{ blob: Blob; scale: number; q: number; psnr: number; }> = [];
    const addCandidate = async (fit: { blob: Blob; scale: number; q: number; } | null) => {
        if (!fit) return;
        onProgress?.("Best quality: comparing with the original…");
        candidates.push({ ...fit, psnr: await score(fit.blob, baseStep) });
    };
    const full = await gentlestFit(1, baseStep);
    await addCandidate(full);
    // Full size with no lossy setting at all: nothing to compare against
    if (full && full.q === 0) return full.blob;
    // Fast mode's way (no lossy settings, just smaller) is always in the running too, so
    // best quality never comes out worse than fast - noisy, photo-like GIFs can favor it
    await addCandidate(await largestFit(0, baseStep, Math.sqrt(targetBytes / originalSize)));

    // 2. When that takes a strong setting (or nothing fits), also try a smaller
    //    picture with a gentler setting, and keep whichever looks closer
    if (!full || full.q > 24) {
        const gentler = full ? full.q / 2 : qMax / 2;
        await addCandidate(await largestFit(gentler, baseStep, Math.sqrt(targetBytes / originalSize) * 1.6));
        if (!full) await addCandidate(await largestFit(qMax, baseStep, Math.sqrt(targetBytes / originalSize) * 2.2));
    }
    if (candidates.length === 0) return null;
    let best = candidates.reduce((a, b) => (b.psnr > a.psnr ? b : a));

    // Last resort, as in fast mode: when it still has to shrink a lot, every other
    // frame at a noticeably bigger size can look better than every frame tiny
    if (best.scale < 0.4 && frameCount >= 8 && tries < maxTries) {
        const fit = await largestFit(best.q, baseStep * 2, Math.min(1, best.scale * 1.4));
        if (fit && fit.scale >= best.scale * 1.3) best = { ...fit, psnr: best.psnr };
    }
    logger.info(`Best-quality GIF: ${tries} encodes, picked ${Math.round(best.scale * 100)}% size at strength ${Math.round(best.q)} (${candidates.map(c => `${Math.round(c.scale * 100)}%/q${Math.round(c.q)}: ${c.psnr.toFixed(1)} dB`).join(", ")})`);
    return best.blob;
}

/**
 * "Best quality" for still images: the highest WebP quality that fits at full size,
 * then at a few smaller sizes, keeping whichever is closest to the original.
 */
async function smallerStillBest(image: DecodedVideoFrame, width: number, height: number, targetBytes: number, onProgress?: (text: string) => void): Promise<Blob | null> {
    const [sw, sh] = scoringSize(width, height);
    const scoreCanvas = new OffscreenCanvas(sw, sh);
    const scoreCtx = scoreCanvas.getContext("2d", { willReadFrequently: true })!;
    const refBitmap = await createImageBitmap(image as unknown as ImageBitmapSource, { resizeWidth: sw, resizeHeight: sh, resizeQuality: "high" });
    scoreCtx.drawImage(refBitmap, 0, 0);
    refBitmap.close();
    const reference = new Uint8ClampedArray(scoreCtx.getImageData(0, 0, sw, sh).data);

    const candidates: Array<{ blob: Blob; psnr: number; }> = [];
    let scale = 1;
    for (let round = 0; round < 5; round++) {
        const w = Math.max(16, Math.round(width * scale)), h = Math.max(16, Math.round(height * scale));
        onProgress?.(`Best quality: trying ${w}×${h}…`);
        const canvas = new OffscreenCanvas(w, h);
        const bitmap = await createImageBitmap(image as unknown as ImageBitmapSource, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
        canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
        bitmap.close();
        const encode = (quality: number) => canvas.convertToBlob({ type: "image/webp", quality });

        // Highest quality that fits at this size (binary search)
        let fit: Blob | null = null, fitQuality = 0;
        const top = await encode(1);
        if (top.size <= targetBytes) {
            fit = top;
            fitQuality = 1;
        } else {
            const bottom = await encode(0.3);
            if (bottom.size <= targetBytes) {
                fit = bottom;
                fitQuality = 0.3;
                let lo = 0.3, hi = 1;
                for (let i = 0; i < 6; i++) {
                    const q = (lo + hi) / 2;
                    const out = await encode(q);
                    if (out.size <= targetBytes) { fit = out; fitQuality = q; lo = q; } else hi = q;
                }
            }
        }
        if (fit) {
            const shown = await createImageBitmap(fit, { resizeWidth: sw, resizeHeight: sh, resizeQuality: "high" });
            scoreCtx.clearRect(0, 0, sw, sh);
            scoreCtx.drawImage(shown, 0, 0);
            shown.close();
            const e = imageError(reference, scoreCtx.getImageData(0, 0, sw, sh).data);
            candidates.push({ blob: fit, psnr: toPsnr(e.sum, e.count) });
            if (fitQuality >= 0.85) break; // good quality at this size - smaller can only look worse
        }
        scale *= 0.8;
    }
    if (candidates.length === 0) return null;
    return candidates.reduce((a, b) => (b.psnr > a.psnr ? b : a)).blob;
}

type CompressMode = "fast" | "best";

/**
 * Makes a smaller version of a GIF, image or video, aiming for at most targetBytes.
 * Animated input (or any GIF) comes out as a GIF; still images as WebP; videos as WebM.
 * "best" tries many settings and keeps the closest to the original (much slower).
 * Returns null if it can't be made smaller than the original.
 */
async function createSmallerFile(blob: Blob, mimeType: string, targetBytes: number, onProgress?: (text: string) => void, mode: CompressMode = "fast"): Promise<{ blob: Blob; reachedTarget: boolean; detail?: string; } | null> {
    if (mimeType.startsWith("video/")) {
        return mode === "best" ? createSmallerVideoBest(blob, targetBytes, onProgress) : createSmallerVideo(blob, targetBytes, onProgress);
    }
    const ImageDecoderCtor = (window as unknown as { ImageDecoder?: WebCodecsImageDecoderCtor; }).ImageDecoder;
    if (!ImageDecoderCtor) throw new Error("This Discord version can't decode images for compression");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const decoder = new ImageDecoderCtor({ data: bytes, type: mimeType });
    try {
        await decoder.tracks.ready;
        const frameCount = Math.max(1, decoder.tracks.selectedTrack?.frameCount ?? 1);
        const first = (await decoder.decode({ frameIndex: 0 })).image;
        const width = first.displayWidth ?? 0, height = first.displayHeight ?? 0;
        first.close();
        if (!width || !height) return null;

        const sizeFor = (scale: number) => [Math.max(16, Math.round(width * scale)), Math.max(16, Math.round(height * scale))] as const;
        let scale = Math.min(1, Math.max(0.12, Math.sqrt(targetBytes / blob.size)));
        let best: Blob | null = null;
        let smallest: Blob | null = null;

        if (frameCount === 1 && mimeType !== "image/gif") {
            // Still image: WebP keeps transparency and compresses far better than GIF,
            // so try full size first and only shrink if that isn't small enough
            const { image } = await decoder.decode({ frameIndex: 0 });
            scale = 1;
            try {
                if (mode === "best") {
                    best = await smallerStillBest(image, width, height, targetBytes, onProgress);
                }
                // Fast mode, or nothing fit in best mode: the quick search (keeps the smallest it got)
                for (let attempt = 0; attempt < 6 && !best; attempt++) {
                    const [w, h] = sizeFor(scale);
                    const canvas = new OffscreenCanvas(w, h);
                    const bitmap = await createImageBitmap(image as unknown as ImageBitmapSource, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
                    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
                    bitmap.close();
                    const out = await canvas.convertToBlob({ type: "image/webp", quality: attempt === 0 ? 0.9 : 0.8 });
                    if (!smallest || out.size < smallest.size) smallest = out;
                    if (out.size <= targetBytes) break;
                    scale = scale * Math.sqrt(targetBytes / out.size) * 0.95;
                    if (scale < 0.05) break;
                }
                best ??= smallest;
            } finally {
                image.close();
            }
        } else {
            let loopCount: number | null = 0;
            try {
                loopCount = mimeType === "image/gif" ? getGifLoopCount(bytes.buffer) : mimeType === "image/webp" ? getWebpLoopCount(bytes.buffer) : 0;
            } catch { loopCount = 0; }
            if (mode === "best") best = await smallerGifBest(decoder, frameCount, width, height, loopCount, blob.size, targetBytes, onProgress);
            let frameStep = Math.max(1, Math.ceil(frameCount / 600));
            for (let attempt = 0; attempt < 5 && !best; attempt++) {
                const [w, h] = sizeFor(scale);
                const { blob: out } = await encodeGif(decoder, frameCount, w, h, frameStep, loopCount,
                    (done, total) => onProgress?.(`Pass ${attempt + 1}: frame ${done} of ${total} (${w}\u00d7${h})`));
                if (!out) break;
                if (!smallest || out.size < smallest.size) smallest = out;
                if (out.size <= targetBytes) break;
                let next = scale * Math.sqrt(targetBytes / out.size) * 0.95;
                // Below about half size, dropping every other frame keeps more detail
                if (next < 0.5 && frameStep === 1 && frameCount >= 8) {
                    frameStep = 2;
                    next = Math.min(1, next * 1.35);
                }
                if (next < 0.08) break;
                scale = next;
            }
            best ??= smallest;
        }

        if (!best || best.size >= blob.size) return null;
        return { blob: best, reachedTarget: best.size <= targetBytes };
    } finally {
        decoder.close();
    }
}


/**
 * Videos are re-encoded by playing them (silently) into a MediaRecorder at a bitrate
 * worked out from the target size - browsers can encode video, but only in real time,
 * so this takes as long as the video itself. Output is WebM (VP9 or VP8 + Opus), which
 * Discord plays inline. The resolution is lowered to suit the bitrate.
 */
async function createSmallerVideo(blob: Blob, targetBytes: number, onProgress?: (text: string) => void): Promise<{ blob: Blob; reachedTarget: boolean; } | null> {
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(t => MediaRecorder.isTypeSupported(t));
    if (!mimeType) throw new Error("This Discord version can't record video");

    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.src = url;
    video.playsInline = true;
    video.preload = "auto";
    let audioContext: AudioContext | null = null;
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("This video format can't be played here, so it can't be compressed"));
        });
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Couldn't read this video's length");
        const srcW = video.videoWidth, srcH = video.videoHeight;
        if (!srcW || !srcH) throw new Error("Couldn't read this video's size");

        // Bitrate budget: ~92% of the target (container overhead + encoder overshoot)
        const totalBps = targetBytes * 8 * 0.92 / duration;
        const audioBps = Math.max(24000, Math.min(96000, totalBps * 0.12));
        const videoBps = Math.max(60000, totalBps - audioBps);
        const fps = 30;
        // About 0.08 bits per pixel per frame keeps VP8/VP9 looking decent
        const scale = Math.min(1, Math.sqrt(videoBps / (fps * 0.08) / (srcW * srcH)));
        const w = Math.max(64, Math.round(srcW * scale / 2) * 2);
        const h = Math.max(64, Math.round(srcH * scale / 2) * 2);

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d")!;
        // The video's sound goes into the recording only, never to the speakers
        audioContext = new AudioContext();
        await audioContext.resume();
        const destination = audioContext.createMediaStreamDestination();
        audioContext.createMediaElementSource(video).connect(destination);
        const stream = new MediaStream([...canvas.captureStream(fps).getVideoTracks(), ...destination.stream.getAudioTracks()]);

        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: Math.round(videoBps), audioBitsPerSecond: Math.round(audioBps) });
        const chunks: Blob[] = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });

        let finished = false;
        const drawFrame = () => {
            if (finished) return;
            ctx.drawImage(video, 0, 0, w, h);
            video.requestVideoFrameCallback(drawFrame);
        };
        video.requestVideoFrameCallback(drawFrame);
        video.ontimeupdate = () => onProgress?.(`Re-encoding video: ${Math.floor(video.currentTime)}s of ${Math.round(duration)}s (${w}×${h}) - keep Discord open`);

        recorder.start(1000);
        const ended = new Promise<void>((resolve, reject) => {
            video.onended = () => resolve();
            video.onerror = () => reject(new Error("The video stopped playing partway"));
        });
        await video.play();
        await ended;
        finished = true;
        recorder.stop();
        await stopped;
        stream.getTracks().forEach(t => t.stop());

        const recorded = new Blob(chunks, { type: "video/webm" });
        const out = await addWebmDuration(recorded, duration * 1000);
        if (out.size >= blob.size) return null;
        return { blob: out, reachedTarget: out.size <= targetBytes };
    } finally {
        video.ontimeupdate = null;
        video.onerror = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
        void audioContext?.close();
    }
}

// ---- "Best quality" video: WebCodecs encoder + a small WebM writer ----
//
// MediaRecorder (fast mode) uses the real-time encoder settings. WebCodecs'
// VideoEncoder with latencyMode "quality" spends more effort per frame for the same
// bitrate, and since the sound is encoded separately and the file is written here,
// the size can be measured and the video re-encoded at a corrected bitrate so the
// result lands close to the size asked for instead of well under it.

interface EncodedPacket {
    data: Uint8Array;
    timestampUs: number;
    key: boolean;
}

/* Minimal WebCodecs typings (not in every TypeScript DOM lib this builds with) */
interface WCEncodedChunk { byteLength: number; timestamp: number; type: "key" | "delta"; copyTo(dest: Uint8Array): void; }
interface WCVideoEncoder { encodeQueueSize: number; configure(c: object): void; encode(frame: unknown, opts?: { keyFrame?: boolean; }): void; flush(): Promise<void>; close(): void; }
interface WCAudioEncoder { configure(c: object): void; encode(data: unknown): void; flush(): Promise<void>; close(): void; }
interface WebCodecsGlobals {
    VideoEncoder?: { new(init: { output: (chunk: WCEncodedChunk) => void; error: (e: unknown) => void; }): WCVideoEncoder; isConfigSupported(c: object): Promise<{ supported?: boolean; }>; };
    AudioEncoder?: { new(init: { output: (chunk: WCEncodedChunk, meta?: { decoderConfig?: { description?: ArrayBuffer | ArrayBufferView; }; }) => void; error: (e: unknown) => void; }): WCAudioEncoder; isConfigSupported(c: object): Promise<{ supported?: boolean; }>; };
    VideoFrame?: new (source: CanvasImageSource | OffscreenCanvas, init: { timestamp: number; }) => { close(): void; };
    AudioData?: new (init: { format: "f32-planar"; sampleRate: number; numberOfFrames: number; numberOfChannels: number; timestamp: number; data: Float32Array; }) => { close(): void; };
}
type FrameCallbackVideo = HTMLVideoElement & { requestVideoFrameCallback(cb: (now: number, meta: { mediaTime: number; }) => void): number; webkitAudioDecodedByteCount?: number; };

const copyChunk = (chunk: WCEncodedChunk, key = chunk.type === "key"): EncodedPacket => {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    return { data, timestampUs: chunk.timestamp, key };
};

/** The whole sound track as Opus packets, or null when the file has no sound */
async function encodeOpusTrack(blob: Blob, bitrate: number): Promise<{ packets: EncodedPacket[]; channels: number; head: Uint8Array; } | null> {
    const wc = window as unknown as WebCodecsGlobals;
    let buffer: AudioBuffer;
    try {
        // Decoding through an offline context resamples to 48 kHz (Opus' native rate) and never plays anything
        buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await blob.arrayBuffer());
    } catch {
        return null;
    }
    if (!buffer.length) return null;
    const channels = Math.min(2, buffer.numberOfChannels);
    const config = { codec: "opus", sampleRate: 48000, numberOfChannels: channels, bitrate: Math.round(bitrate) };
    if (!(await wc.AudioEncoder!.isConfigSupported(config)).supported) throw new Error("unsupported");

    const packets: EncodedPacket[] = [];
    let description: Uint8Array | null = null;
    let failure: unknown = null;
    const encoder = new wc.AudioEncoder!({
        output: (chunk, meta) => {
            packets.push(copyChunk(chunk, true));
            const d = meta?.decoderConfig?.description;
            if (d && !description) description = d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
        },
        error: e => { failure = e; }
    });
    encoder.configure(config);
    const step = 48000; // one second at a time
    for (let offset = 0; offset < buffer.length && !failure; offset += step) {
        const n = Math.min(step, buffer.length - offset);
        const data = new Float32Array(n * channels);
        for (let c = 0; c < channels; c++) data.set(buffer.getChannelData(c).subarray(offset, offset + n), c * n);
        const audioData = new wc.AudioData!({ format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: channels, timestamp: Math.round(offset / 48 * 1000), data });
        encoder.encode(audioData);
        audioData.close();
        if (offset % (step * 10) === 0) await yieldToDiscord();
    }
    await encoder.flush();
    encoder.close();
    if (failure) throw failure;

    // The Opus header WebM needs (the encoder normally provides it; built by hand otherwise)
    let head: Uint8Array = description ?? new Uint8Array(0);
    if (head.length < 19 || String.fromCharCode(...head.subarray(0, 8)) !== "OpusHead") {
        head = new Uint8Array(19);
        head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
        const view = new DataView(head.buffer);
        view.setUint16(10, 312, true); // pre-skip: libopus' usual encoder delay at 48 kHz
        view.setUint32(12, 48000, true);
    }
    return { packets, channels, head };
}

/** Plays the video once (muted) and encodes every frame it shows */
async function encodeVideoPass(
    video: FrameCallbackVideo, w: number, h: number, codec: string, bitrate: number, onTime: (seconds: number) => void
): Promise<EncodedPacket[]> {
    const wc = window as unknown as WebCodecsGlobals;
    const packets: EncodedPacket[] = [];
    let failure: unknown = null;
    const encoder = new wc.VideoEncoder!({ output: chunk => packets.push(copyChunk(chunk)), error: e => { failure = e; } });
    encoder.configure({ codec, width: w, height: h, bitrate: Math.round(bitrate), bitrateMode: "variable", latencyMode: "quality", framerate: 30 });
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;

    if (video.currentTime !== 0) {
        await new Promise<void>(resolve => {
            video.onseeked = () => resolve();
            video.currentTime = 0;
        });
        video.onseeked = null;
    }
    let lastTimestamp = -1, lastKey = -Infinity, ended = false, waiting = false;
    try {
        // The frame already on screen before playback starts never gets a frame
        // callback, so the very first frame is encoded by hand
        if (video.readyState < 2) {
            await new Promise<void>(resolve => {
                video.onloadeddata = () => resolve();
            });
            video.onloadeddata = null;
        }
        {
            ctx.drawImage(video, 0, 0, w, h);
            const timestamp = Math.round(video.currentTime * 1e6);
            const frame = new wc.VideoFrame!(canvas, { timestamp });
            encoder.encode(frame, { keyFrame: true });
            frame.close();
            lastTimestamp = timestamp;
            lastKey = timestamp;
        }
        await new Promise<void>((resolve, reject) => {
            const onFrame = (_now: number, meta: { mediaTime: number; }) => {
                if (ended) return;
                if (failure) { reject(failure); return; }
                const timestamp = Math.round(meta.mediaTime * 1e6);
                if (timestamp > lastTimestamp) {
                    ctx.drawImage(video, 0, 0, w, h);
                    const frame = new wc.VideoFrame!(canvas, { timestamp });
                    const keyFrame = timestamp - lastKey >= 2e6; // a keyframe every ~2s keeps seeking quick
                    if (keyFrame) lastKey = timestamp;
                    encoder.encode(frame, { keyFrame });
                    frame.close();
                    lastTimestamp = timestamp;
                    onTime(meta.mediaTime);
                }
                // The encoder is slower than playback: pause until it catches up, so no frame is skipped
                if (encoder.encodeQueueSize > 4 && !video.paused && !waiting) {
                    waiting = true;
                    video.pause();
                    const resume = () => {
                        if (failure) { reject(failure); return; }
                        if (encoder.encodeQueueSize > 1) { setTimeout(resume, 10); return; }
                        waiting = false;
                        video.play().catch(reject);
                    };
                    setTimeout(resume, 10);
                }
                video.requestVideoFrameCallback(onFrame);
            };
            video.requestVideoFrameCallback(onFrame);
            video.onended = () => {
                ended = true;
                // The last frame can end playback before its frame callback runs
                const timestamp = Math.round(video.currentTime * 1e6);
                if (timestamp > lastTimestamp + 1000 && !failure) {
                    try {
                        ctx.drawImage(video, 0, 0, w, h);
                        const frame = new wc.VideoFrame!(canvas, { timestamp });
                        encoder.encode(frame, { keyFrame: false });
                        frame.close();
                    } catch { /* the end of the video simply stays on the frame before */ }
                }
                resolve();
            };
            video.onerror = () => reject(new Error("The video stopped playing partway"));
            video.play().catch(reject);
        });
        await encoder.flush();
    } finally {
        ended = true;
        video.onended = null;
        video.onerror = null;
        try { encoder.close(); } catch { /* already closed after an error */ }
    }
    if (failure) throw failure;
    return packets;
}

/** Writes VP9/VP8 (+ Opus) packets as a WebM file, with duration and seek points */
function muxWebm(options: {
    width: number; height: number; codecId: string; video: EncodedPacket[];
    audio: { packets: EncodedPacket[]; channels: number; head: Uint8Array; } | null; durationMs: number;
}): Blob {
    interface Node { parts: Uint8Array[]; size: number; }
    const idBytes = (id: number) => {
        const out: number[] = [];
        for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v & 255);
        return out;
    };
    const sizeBytes = (n: number, fixed?: number) => {
        let len = fixed ?? 1;
        if (!fixed) while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
        const out = new Uint8Array(len);
        for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v % 256;
        out[0] |= 0x80 >> (len - 1);
        return out;
    };
    const el = (id: number, children: Array<Uint8Array | Node>, fixedSize?: number): Node => {
        const parts: Uint8Array[] = [];
        let size = 0;
        for (const c of children) {
            if (c instanceof Uint8Array) { parts.push(c); size += c.length; } else { for (const p of c.parts) parts.push(p); size += c.size; }
        }
        const head = new Uint8Array([...idBytes(id), ...sizeBytes(size, fixedSize)]);
        return { parts: [head, ...parts], size: head.length + size };
    };
    const uint = (id: number, value: number, fixedLength?: number) => {
        const b: number[] = [];
        for (let v = value; v > 0 || b.length === 0; v = Math.floor(v / 256)) b.unshift(v % 256);
        while (fixedLength && b.length < fixedLength) b.unshift(0);
        return el(id, [Uint8Array.from(b)]);
    };
    const float = (id: number, value: number) => {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, value);
        return el(id, [b]);
    };
    const str = (id: number, value: string) => el(id, [new TextEncoder().encode(value)]);

    const { width, height, codecId, video, audio } = options;
    const header = el(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, "webm"), uint(0x4287, 4), uint(0x4285, 2)]);

    // Packets of both tracks in time order
    const blocks = [
        ...video.map(p => ({ ...p, track: 1, ms: Math.max(0, Math.round(p.timestampUs / 1000)) })),
        ...(audio?.packets ?? []).map(p => ({ ...p, track: 2, ms: Math.max(0, Math.round(p.timestampUs / 1000)) }))
    ].sort((a, b) => a.ms - b.ms || a.track - b.track);
    const lastMs = blocks.length ? blocks[blocks.length - 1].ms : 0;
    const durationMs = Math.max(options.durationMs, lastMs);

    const info = el(0x1549a966, [uint(0x2ad7b1, 1000000), str(0x4d80, "GIF Folders"), str(0x5741, "GIF Folders"), float(0x4489, durationMs)]);
    const trackEntries: Node[] = [el(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), uint(0x9c, 0), str(0x86, codecId), el(0xe0, [uint(0xb0, width), uint(0xba, height)])])];
    if (audio) {
        const preSkip = audio.head[10] | (audio.head[11] << 8);
        trackEntries.push(el(0xae, [
            uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 2), uint(0x9c, 0), str(0x86, "A_OPUS"), el(0x63a2, [audio.head]),
            uint(0x56aa, Math.round(preSkip * 1e9 / 48000)), uint(0x56bb, 80000000), el(0xe1, [float(0xb5, 48000), uint(0x9f, audio.channels)])
        ]));
    }
    const tracks = el(0x1654ae6b, trackEntries);

    // Clusters: a new one at every video keyframe (so seeking can jump straight to it)
    const clusters: Node[] = [];
    const clusterStarts: Array<{ ms: number; index: number; }> = [];
    let current: Node[] = [], clusterMs = 0;
    const closeCluster = () => {
        if (current.length) clusters.push(el(0x1f43b675, [uint(0xe7, clusterMs), ...current]));
        current = [];
    };
    for (const b of blocks) {
        const videoKey = b.track === 1 && b.key;
        if (current.length === 0 || videoKey || b.ms - clusterMs > 30000) {
            closeCluster();
            clusterMs = b.ms;
            if (videoKey) clusterStarts.push({ ms: b.ms, index: clusters.length });
        }
        const rel = b.ms - clusterMs;
        current.push(el(0xa3, [new Uint8Array([0x80 | b.track, (rel >> 8) & 255, rel & 255, b.key ? 0x80 : 0]), b.data]));
    }
    closeCluster();

    // Positions are measured from the start of the Segment's contents
    const seekEntry = (id: number, position: number) => el(0x4dbb, [el(0x53ab, [Uint8Array.from(idBytes(id))]), uint(0x53ac, position, 8)]);
    const seekHeadSize = el(0x114d9b74, [seekEntry(0x1549a966, 0), seekEntry(0x1654ae6b, 0), seekEntry(0x1c53bb6b, 0)]).size;
    const clustersStart = seekHeadSize + info.size + tracks.size;
    const clusterPositions: number[] = [];
    let position = clustersStart;
    for (const c of clusters) { clusterPositions.push(position); position += c.size; }
    const cues = el(0x1c53bb6b, clusterStarts.map(c => el(0xbb, [uint(0xb3, c.ms), el(0xb7, [uint(0xf7, 1), uint(0xf1, clusterPositions[c.index])])])));
    const seekHead = el(0x114d9b74, [seekEntry(0x1549a966, seekHeadSize), seekEntry(0x1654ae6b, seekHeadSize + info.size), seekEntry(0x1c53bb6b, position)]);
    const segment = el(0x18538067, [seekHead, info, tracks, ...clusters, cues], 8);
    return new Blob([...header.parts, ...segment.parts] as BlobPart[], { type: "video/webm" });
}

/**
 * "Best quality" video. Plays the video (muted) through WebCodecs' quality-tuned
 * encoder, up to 3 times, adjusting the bitrate so the file comes out just under the
 * size asked for. Falls back to the fast way if this Discord version can't do it.
 */
async function createSmallerVideoBest(blob: Blob, targetBytes: number, onProgress?: (text: string) => void): Promise<{ blob: Blob; reachedTarget: boolean; detail?: string; } | null> {
    const result = await videoBestAttempt(blob, targetBytes, onProgress);
    if (result !== "fallback") return result;
    logger.info("Best-quality video encoding isn't available for this file - using the fast way");
    return createSmallerVideo(blob, targetBytes, onProgress);
}

async function videoBestAttempt(blob: Blob, targetBytes: number, onProgress?: (text: string) => void): Promise<{ blob: Blob; reachedTarget: boolean; detail?: string; } | null | "fallback"> {
    const wc = window as unknown as WebCodecsGlobals;
    if (!wc.VideoEncoder || !wc.VideoFrame || !wc.AudioEncoder || !wc.AudioData) return "fallback";

    const url = URL.createObjectURL(blob);
    const video = document.createElement("video") as FrameCallbackVideo;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("This video format can't be played here, so it can't be compressed"));
        });
        video.onerror = null;
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("Couldn't read this video's length");
        const srcW = video.videoWidth, srcH = video.videoHeight;
        if (!srcW || !srcH) throw new Error("Couldn't read this video's size");
        if (duration > 20 * 60) return "fallback";

        onProgress?.("Best quality: encoding the sound…");
        const totalBps = targetBytes * 8 / duration;
        let audio: Awaited<ReturnType<typeof encodeOpusTrack>> = null;
        try {
            audio = await encodeOpusTrack(blob, Math.max(32000, Math.min(128000, totalBps * 0.1)));
        } catch {
            return "fallback";
        }
        const audioBytes = audio ? audio.packets.reduce((n, p) => n + p.data.length, 0) : 0;
        // Container overhead: a few bytes per packet plus headers and seek points
        const overhead = 8192 + (audio?.packets.length ?? 0) * 8 + duration * 60 * 8;
        const videoBudget = Math.max(targetBytes * 0.15, targetBytes * 0.985 - audioBytes - overhead);

        let bitrate = Math.max(50000, videoBudget * 8 / duration);
        // VP9 in quality mode holds up at fewer bits per pixel than the real-time recorder
        const scale = Math.min(1, Math.sqrt(bitrate / (30 * 0.05) / (srcW * srcH)));
        const w = Math.max(64, Math.round(srcW * scale / 2) * 2);
        const h = Math.max(64, Math.round(srcH * scale / 2) * 2);

        let codec: { codec: string; id: string; } | null = null;
        for (const [c, id] of [["vp09.00.41.08", "V_VP9"], ["vp09.00.51.08", "V_VP9"], ["vp8", "V_VP8"]]) {
            try {
                const support = await wc.VideoEncoder.isConfigSupported({ codec: c, width: w, height: h, bitrate: Math.round(bitrate), bitrateMode: "variable", latencyMode: "quality", framerate: 30 });
                if (support.supported) { codec = { codec: c, id }; break; }
            } catch { /* try the next one */ }
        }
        if (!codec) return "fallback";

        const maxPasses = duration > 90 ? 2 : 3;
        let fitting: Blob | null = null, smallest: Blob | null = null;
        let passes = 0;
        // Why the current pass is running, shown in the progress text
        let reason = maxPasses > 1 ? "another pass only if this one isn't within 90-100% of the size picked" : "";
        for (let pass = 0; pass < maxPasses; pass++) {
            passes = pass + 1;
            const why = reason;
            const packets = await encodeVideoPass(video, w, h, codec.codec, bitrate,
                t => onProgress?.(`Best quality, pass ${pass + 1}: ${Math.floor(t)}s of ${Math.round(duration)}s (${w}\u00d7${h})${why ? ` - ${why}` : ""}. Keep Discord open.`));
            if (packets.length === 0) throw new Error("The video didn't play, so it couldn't be compressed");
            // Sound that couldn't be decoded separately must not just go missing
            if (pass === 0 && !audio && (video.webkitAudioDecodedByteCount ?? 0) > 0) return "fallback";
            const file = muxWebm({ width: w, height: h, codecId: codec.id, video: packets, audio, durationMs: duration * 1000 });
            if (!smallest || file.size < smallest.size) smallest = file;
            if (file.size <= targetBytes && (!fitting || file.size > fitting.size)) fitting = file;
            // Within 90-100% of the target: as good as it gets, no more passes needed
            if (file.size <= targetBytes && file.size >= targetBytes * 0.9) break;
            reason = file.size > targetBytes
                ? `pass ${pass + 1} came out ${Math.round(file.size / targetBytes * 100)}% of the size picked - too big, so trying again a bit smaller`
                : `pass ${pass + 1} came out only ${Math.floor(file.size / targetBytes * 100)}% of the size picked - trying again with more quality`;
            const videoBytes = packets.reduce((n, p) => n + p.data.length, 0);
            bitrate = Math.max(30000, bitrate * (videoBudget / videoBytes) * (file.size > targetBytes ? 0.96 : 0.98));
        }
        const out = fitting ?? smallest!;
        if (out.size >= blob.size) return null;
        const detail = passes === 1 ? "1 pass - it landed right on target, so no more were needed" : `${passes} passes to get close to the target`;
        return { blob: out, reachedTarget: out.size <= targetBytes, detail };
    } finally {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.onended = null;
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
    }
}

/**
 * Browser-recorded WebM files don't say how long they are (they're written while
 * recording), which leaves players without a working seek bar. This adds the
 * Duration element to the file's Segment Info.
 */
async function addWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
    try {
        const b = new Uint8Array(await blob.arrayBuffer());
        const vintLen = (first: number) => { let len = 1, mask = 0x80; while (len <= 8 && !(first & mask)) { len++; mask >>= 1; } return len; };
        const readSize = (pos: number) => {
            const len = vintLen(b[pos]);
            let value = b[pos] & ((0x80 >> (len - 1)) - 1);
            let allOnes = value === (0x80 >> (len - 1)) - 1;
            for (let i = 1; i < len; i++) { value = value * 256 + b[pos + i]; if (b[pos + i] !== 0xff) allOnes = false; }
            return { len, value: allOnes ? -1 : value };
        };
        const readId = (pos: number) => {
            const len = vintLen(b[pos]);
            let id = 0;
            for (let i = 0; i < len; i++) id = id * 256 + b[pos + i];
            return { len, id };
        };

        let pos = 0;
        // EBML header
        let el = readId(pos);
        if (el.id !== 0x1a45dfa3) return blob;
        let size = readSize(pos + el.len);
        pos += el.len + size.len + size.value;
        // Segment
        el = readId(pos);
        if (el.id !== 0x18538067) return blob;
        size = readSize(pos + el.len);
        const segmentStart = pos + el.len + size.len;
        // Find Info among the first Segment children
        let p = segmentStart;
        for (let guard = 0; guard < 16 && p < b.length; guard++) {
            const child = readId(p);
            const childSize = readSize(p + child.len);
            const contentStart = p + child.len + childSize.len;
            if (child.id === 0x1549a966 && childSize.value >= 0) {
                const contentEnd = contentStart + childSize.value;
                // Already has a Duration?
                for (let q = contentStart; q < contentEnd;) {
                    const inner = readId(q);
                    const innerSize = readSize(q + inner.len);
                    if (inner.id === 0x4489) return blob;
                    q += inner.len + innerSize.len + innerSize.value;
                }
                const duration = new Uint8Array(11);
                duration.set([0x44, 0x89, 0x88]);
                new DataView(duration.buffer).setFloat64(3, durationMs);
                const newSize = childSize.value + duration.length;
                const sizeBytes = new Uint8Array(8);
                sizeBytes[0] = 0x01;
                for (let i = 7, v = newSize; i >= 1; i--, v = Math.floor(v / 256)) sizeBytes[i] = v & 255;
                return new Blob([
                    b.subarray(0, p + child.len) as BlobPart,
                    sizeBytes,
                    b.subarray(contentStart, contentEnd) as BlobPart,
                    duration,
                    b.subarray(contentEnd) as BlobPart
                ], { type: blob.type });
            }
            if (childSize.value < 0) break; // unknown-size child (a Cluster) - Info would have come before it
            p = contentStart + childSize.value;
        }
        return blob;
    } catch {
        return blob;
    }
}

const MAX_BYTES_FOR_COMPRESSION = 200 * 1024 * 1024;

/** The file to compress: the cached copy, or a one-off download (files over the 20 MB cache limit too) */
async function loadForCompression(entry: GifEntry): Promise<{ blob: Blob; mimeType: string; } | null> {
    if (isCachedSrc(entry.mediaSrc)) {
        const blob = await requestBlob(entry.mediaSrc);
        if (blob) return { blob, mimeType: getCacheEntry(entry.mediaSrc)?.mimeType || blob.type };
    }
    if (isLocalSrc(entry.mediaSrc)) return null;
    let downloaded = await downloadBytes(entry.mediaSrc, MAX_BYTES_FOR_COMPRESSION);
    if (!downloaded && isDiscordCdnUrl(entry.mediaSrc)) {
        const fresh = await refreshAttachmentUrl(entry.mediaSrc); // expired signed link
        if (fresh) downloaded = await downloadBytes(fresh, MAX_BYTES_FOR_COMPRESSION);
    }
    if (!downloaded || downloaded.bytes.length === 0) return null;
    let { mimeType } = downloaded;
    if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) {
        mimeType = isVideoUrl(entry.mediaSrc) ? `video/${videoUrlExt(entry.mediaSrc) === "mov" ? "quicktime" : videoUrlExt(entry.mediaSrc) ?? "mp4"}` : GifExtRegex.test(entry.mediaSrc) ? "image/gif" : mimeType;
    }
    return { blob: new Blob([downloaded.bytes as BlobPart], { type: mimeType }), mimeType };
}

let compressionRunning = false;

/**
 * Makes a smaller copy (about `fraction` of the original size) and adds it right
 * after the original. Returns what happened, for the dialog to show.
 */
async function makeSmallerCopy(folder: string, entry: GifEntry, fraction: number, onProgress?: (text: string) => void, mode: CompressMode = "fast"): Promise<{ ok: boolean; message: string; }> {
    if (compressionRunning) return { ok: false, message: "Already making a smaller copy - wait for that one to finish" };
    compressionRunning = true;
    try {
        onProgress?.("Loading the file…");
        const source = await loadForCompression(entry);
        if (!source) return { ok: false, message: "Couldn't load this file to make a smaller copy (dead link, or over 200 MB)" };
        const { blob, mimeType } = source;
        if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/")) return { ok: false, message: "This kind of file can't be made smaller" };

        const started = Date.now();
        const result = await createSmallerFile(blob, mimeType, Math.floor(blob.size * fraction), onProgress, mode);
        logger.info(`Smaller copy (${mode}) made in ${((Date.now() - started) / 1000).toFixed(1)}s: ${blob.size} -> ${result?.blob.size ?? "none"} bytes`);
        if (!result) return { ok: false, message: "Couldn't make this one any smaller" };

        onProgress?.("Saving…");
        const ext = result.blob.type === "image/webp" ? "webp" : result.blob.type.startsWith("video/") ? "webm" : "gif";
        const base = entry.name.replace(/\.(gif|webp|png|jpe?g|avif|mp4|mov|webm|m4v|mkv)$/i, "").trim() || "gif";
        const src = `${LOCAL_SRC_PREFIX}${makeId()}/${encodeURIComponent(base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80))}.${ext}`;
        const key = hashUrl(src);
        const outBytes = new Uint8Array(await result.blob.arrayBuffer());
        const meta: MediaCacheEntry = {
            cachedAt: Date.now(),
            size: result.blob.size,
            mimeType: result.blob.type,
            loopsForever: detectLoopsForever(outBytes, result.blob.type),
            src,
            pinned: true
        };
        const stored = await writeCacheEntry(key, meta, result.blob);
        if (!stored) return { ok: false, message: "Couldn't save the smaller copy (storage error)" };
        mediaCache[key] = meta;
        storeCachedBlob(key, stored);

        const list = cache[folder] ?? (cache[folder] = []);
        const index = list.findIndex(g => g.id === entry.id);
        list.splice(index < 0 ? 0 : index + 1, 0, { id: makeId(), shareSrc: src, mediaSrc: src, name: `${base} (${formatMB(result.blob.size)})`, addedAt: Date.now() });
        await persist();
        return {
            ok: true,
            message: `Smaller copy added: ${formatMB(blob.size)} → ${formatMB(result.blob.size)}${result.reachedTarget ? "" : " (as small as it could get)"}${result.detail ? ` - ${result.detail}` : ""}`
        };
    } catch (e) {
        logger.error("Making a smaller copy failed", e);
        return { ok: false, message: e instanceof Error && e.message ? e.message : "Couldn't make a smaller copy - see console for details" };
    } finally {
        compressionRunning = false;
    }
}

// The quality choice is remembered for the rest of the session
let lastCompressMode: CompressMode = "fast";

function CompressModal({ modalProps, folder, entry }: { modalProps: RenderModalProps; folder: string; entry: GifEntry; }) {
    const [percent, setPercent] = useState(50);
    const [mode, setMode] = useState<CompressMode>(lastCompressMode);
    const [running, setRunning] = useState(false);
    const [status, setStatus] = useState<{ text: string; error?: boolean; } | null>(null);
    const knownSize = getCacheEntry(entry.mediaSrc)?.size;
    const isVideo = isVideoUrl(entry.mediaSrc) || !!getCacheEntry(entry.mediaSrc)?.mimeType.startsWith("video/");

    function pickMode(next: CompressMode) {
        lastCompressMode = next;
        setMode(next);
    }

    async function run() {
        setRunning(true);
        setStatus({ text: "Starting…" });
        const result = await makeSmallerCopy(folder, entry, percent / 100, text => setStatus({ text }), mode);
        setRunning(false);
        if (result.ok) {
            showToast({ text: result.message, variant: "success" });
            modalProps.onClose();
        } else {
            setStatus({ text: result.message, error: true });
        }
    }

    const modeHint = mode === "fast"
        ? isVideo
            ? "Re-encoded once as it plays, so it takes about as long as the video. Comes out as a WebM file."
            : "Shrinks the picture until it fits. Takes a few seconds."
        : isVideo
            ? "Uses a slower, sharper encoder - if the first pass misses the size picked, it re-encodes (up to 3 passes in total), so it takes 1-4× the video's length. Comes out as a WebM file."
            : "Tries many settings and keeps the one closest to the original, keeping full size whenever it can - often 5-20× slower than Fast.";

    return (
        <Modal {...modalProps} title="Make Smaller Copy" size="sm">
            <div>
                <Paragraph style={{ marginBottom: 12 }}>
                    {`"${entry.name}"`}{knownSize ? ` is ${formatMB(knownSize)}.` : "."} A copy is added right after it - the original stays as it is.
                </Paragraph>
                <Heading tag="h5" defaultColor={false} style={{ color: "var(--text-strong)", lineHeight: "20px", marginBottom: 8 }}>
                    {`New size: about ${percent}% of the original${knownSize ? ` (≈${formatMB(knownSize * percent / 100)})` : ""}`}
                </Heading>
                <Slider
                    disabled={running}
                    initialValue={percent}
                    minValue={10}
                    maxValue={90}
                    markers={[10, 20, 30, 40, 50, 60, 70, 80, 90]}
                    stickToMarkers={false}
                    onValueChange={(v: number) => setPercent(Math.round(v))}
                    onValueRender={(v: number) => `${Math.round(v)}%`}
                />
                <Heading tag="h5" defaultColor={false} style={{ color: "var(--text-strong)", lineHeight: "20px", marginTop: 16, marginBottom: 8 }}>
                    Quality
                </Heading>
                <div style={{ display: "flex", gap: 8 }}>
                    <Button variant={mode === "fast" ? "primary" : "secondary"} size="small" disabled={running} onClick={() => pickMode("fast")} style={{ flex: 1 }}>
                        Fast
                    </Button>
                    <Button variant={mode === "best" ? "primary" : "secondary"} size="small" disabled={running} onClick={() => pickMode("best")} style={{ flex: 1 }}>
                        Best quality (slower)
                    </Button>
                </div>
                {!running && (
                    <Paragraph style={{ marginTop: 8, opacity: 0.7 }}>
                        {modeHint}
                    </Paragraph>
                )}
                <Button variant="primary" size="medium" disabled={running} onClick={run} style={{ width: "100%", marginTop: 16 }}>
                    {running ? "Compressing…" : isVideo ? "Compress Video" : "Compress GIF"}
                </Button>
                {status && (
                    <Paragraph style={{ marginTop: 8, ...(status.error ? { color: "var(--text-feedback-critical, var(--text-danger))" } : { opacity: 0.8 }) }}>
                        {status.text}
                    </Paragraph>
                )}
            </div>
        </Modal>
    );
}

function openCompressModal(folder: string, entry: GifEntry) {
    openModal(modalProps => <CompressModal modalProps={modalProps} folder={folder} entry={entry} />);
}

/** A smaller copy's file is only kept while some folder still has it */
async function forgetLocalFilesIfUnused(srcs: string[]) {
    const stillUsed = new Set(Object.values(cache).flatMap(entries => entries.map(e => e.mediaSrc)));
    const unused = [...new Set(srcs)].filter(src => isLocalSrc(src) && !stillUsed.has(src));
    if (unused.length === 0) return;
    const keys = unused.map(hashUrl);
    for (const key of keys) {
        releaseBlobUrl(key);
        delete mediaCache[key];
    }
    await deleteMediaCacheEntries(keys);
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
                <Heading tag="h5" defaultColor={false} style={{ color: "var(--text-strong)", lineHeight: "20px", marginBottom: 8 }}>{title}</Heading>
                <TextInput
                    value={value}
                    onChange={(v: string) => { setValue(v); setError(""); }}
                    placeholder={placeholder}
                    autoFocus
                    onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter") submit(); }}
                />
                {error && (
                    <Paragraph style={{ color: "var(--text-feedback-critical, var(--text-danger))", marginTop: 8 }}>{error}</Paragraph>
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
 * Same as setGridMaxHeight, but keeps the grid's own scroll position sane
 * across the change - see INVESTIGATION.md Part 26. Whenever max-height
 * changes, the grid's clientHeight changes with it, and the browser
 * automatically clamps scrollTop down if it would otherwise scroll past the
 * (new, shorter) end of the content - completely normal scroll behavior,
 * but it fires on *every* max-height change this file makes, including
 * settleGridHeight's own deliberately oversized probe step (see its
 * comment). Once clientHeight shrinks back down afterward, scrollTop does
 * NOT un-clamp back to where it was - browsers only ever pull scrollTop
 * down to stay legal, never push it back up once room reopens - so a
 * person scrolled to the bottom before a settle would land noticeably
 * short of the bottom after one, confirmed via a real repro.
 *
 * Records whether the grid was scrolled to its bottom (or a specific
 * scrollTop, if not) before the change, and restores that intent
 * afterward - "was at the bottom" re-scrolls to the *new* bottom (which
 * may differ slightly from the old one) rather than replaying a stale
 * pixel value that may no longer mean the same thing.
 */
/**
 * Creates a temporary, invisible stand-in for the grid - a plain div
 * matching just enough of its box model (box-sizing, padding) to make
 * contentWrapper react the same way it would to the real grid being that
 * tall - inserted as the grid's next sibling. See settleGridHeight's own
 * comment and INVESTIGATION.md Part 27 for why: contentWrapper needs
 * *something* oversized to react to in order to reveal its true ceiling
 * (Part 23), but that something no longer has to be the real, visible grid
 * itself. The real grid's own tiles never move or disappear, because the
 * real grid's own size is never touched until the final, correct value is
 * already known - only this disposable probe does the oversized dance, and
 * it's invisible (`visibility: hidden`) the entire time by design, so
 * there's nothing to flash.
 *
 * Caller is responsible for removing it (`.remove()`) once done measuring.
 */
function createSizingProbe(grid: HTMLElement, contentHeightPx: number): HTMLElement {
    const probe = document.createElement("div");
    probe.setAttribute("data-vc-gif-folders-probe", "true");
    probe.setAttribute("aria-hidden", "true");
    const gridStyles = getComputedStyle(grid);
    probe.style.boxSizing = gridStyles.boxSizing;
    probe.style.paddingTop = gridStyles.paddingTop;
    probe.style.paddingBottom = gridStyles.paddingBottom;
    probe.style.margin = "0";
    probe.style.visibility = "hidden";
    probe.style.height = `${Math.round(contentHeightPx)}px`;
    grid.insertAdjacentElement("afterend", probe);
    return probe;
}

/**
 * Root-cause fix for INVESTIGATION.md Part 20 (the bottom row + scrollbar
 * clipping bug) - live-measures how much room is actually available for the
 * grid, instead of assuming it via a delta formula.
 *
 * The delta formula this replaces - `GRID_DEFAULT_MAX_HEIGHT_PX + (targetHeight
 * - baseModalHeightRef.current)` - assumed dialog-height growth always hands
 * the grid the same number of extra px 1:1. Confirmed via a real console dump
 * (see INVESTIGATION.md Part 20) that this doesn't hold: the modal's content
 * wrapper (Discord's own body/scroller element between header and footer, set
 * to overflow:hidden by tightenModalChrome to kill a redundant second
 * scrollbar) has its own clientHeight, and the delta formula has no way to
 * know whether that clientHeight actually grew by the same amount the dialog
 * did. In the confirmed repro it didn't - the grid ended up 56px taller than
 * the wrapper had room for, and since the wrapper's overflow is hidden, that
 * 56px (bottom row + the grid's own scrollbar riding along it) was silently
 * clipped regardless of the grid's own internal scrollTop.
 *
 * This sidesteps the whole class of "assumed a fixed relationship that turned
 * out not to hold" bug by not assuming anything - it measures the wrapper's
 * real bottom edge and the grid's real top edge directly, right now, and
 * returns exactly how much box height (content + this plugin's own padding)
 * the grid can occupy without exceeding that. contentWrapper is re-derived
 * with the same walk tightenModalChrome uses, independently rather than
 * shared, for the same reason the diagnostics above do that: a bug in
 * tightenModalChrome's own logic shouldn't also silently break this.
 *
 * Returns null if the grid or its content wrapper aren't in the DOM right
 * now (modal not open, or not on a view that renders a grid) - callers fall
 * back to the old delta formula in that case rather than fail outright.
 */
function computeAvailableGridContentHeight(dialog: HTMLElement): number | null {
    const grid = document.querySelector<HTMLElement>(".vc-gif-folders-grid");
    if (!grid) return null;

    let contentWrapper: HTMLElement | null = document.querySelector<HTMLElement>(".vc-gif-folders-search-row");
    while (contentWrapper && contentWrapper.parentElement && contentWrapper.parentElement !== dialog) {
        contentWrapper = contentWrapper.parentElement;
    }
    if (!contentWrapper) return null;

    const wrapperBottom = contentWrapper.getBoundingClientRect().bottom;
    const gridTop = grid.getBoundingClientRect().top;
    const gridStyles = getComputedStyle(grid);
    const verticalPadding = (parseFloat(gridStyles.paddingTop) || 0) + (parseFloat(gridStyles.paddingBottom) || 0);

    // gridTop is only affected by whatever sits above the grid in normal
    // document flow (search row, tabs, toolbar) - contentWrapper is a plain
    // display:block box (confirmed via the diagnostic dump), not a flex/grid
    // container whose own children's sizes could feed back into each
    // other's position, so this is safe to measure in one pass rather than
    // needing to re-measure after applying the result. The sizing probe
    // (see createSizingProbe) sits *after* the grid in the DOM, so its
    // presence doesn't affect gridTop either.
    const availableBoxHeight = wrapperBottom - gridTop;
    // grid's own CSS max-height applies to the content box only (confirmed
    // content-box via the diagnostic dump), so subtract padding to convert
    // from "available rendered box height" to "the number to hand
    // setGridMaxHeight".
    return Math.max(GRID_MIN_MAX_HEIGHT_PX, Math.round(availableBoxHeight - verticalPadding));
}

/**
 * Grows a temporary, invisible probe (not the grid itself - see
 * createSizingProbe) to a deliberately oversized value, waits for
 * contentWrapper to stop changing size, then sets the real grid's final
 * precise max-height once - see INVESTIGATION.md Part 23 for the real repro
 * and numbers that showed why this replaced Part 22's continuous
 * ResizeObserver-based correction, and Part 27 for why the probe is a
 * separate element rather than the grid itself.
 *
 * contentWrapper (Discord's own body/scroller wrapper) turns out to be
 * CONTENT-DRIVEN - it shrinks to fit whatever's inside it, up to some
 * ceiling from its own ancestor - not simply a fixed space handed down that
 * the grid can measure and fill. computeAvailableGridContentHeight, called
 * directly against contentWrapper's *current* bottom edge, is only
 * trustworthy when contentWrapper is actually being clamped by that ceiling
 * (content >= ceiling). If a correction ever undershoots even slightly,
 * contentWrapper shrinks to match (being content-driven), and the next
 * correction reads that now-smaller size as if it were the true ceiling and
 * shrinks the grid to match it too - confirmed via a real repro as a
 * genuine downward spiral, worse with every additional resize interaction,
 * not just a one-off measurement error.
 *
 * Deliberately oversizing *something* inside contentWrapper first
 * guarantees content exceeds the ceiling, forcing contentWrapper into its
 * clamped regime, where reading its bottom edge is actually meaningful -
 * then computeAvailableGridContentHeight gets called once, and its result
 * gets set once, as a single deliberate step rather than an ongoing
 * automatic reaction to every resize (which is what could spiral in the
 * first place). Originally that "something" was the real grid itself
 * (Part 23), hidden via visibility:hidden to avoid a visible flash while
 * oversized (Part 25) - Part 27 replaced it with a disposable probe
 * element instead, so the real grid's own size only ever changes once,
 * directly to its final correct value, and its scroll position never has
 * to survive passing through an oversized intermediate state at all.
 * `targetDialogHeight` is passed in rather than re-read from the dialog
 * here specifically because the dialog itself may not have finished
 * reacting to a height change yet either - the value the caller just told
 * the dialog to become is the reliable one, not whatever a live read might
 * catch mid-transition.
 *
 * "Wait for contentWrapper to stop changing" is itself done via a debounced
 * ResizeObserver rather than a fixed delay, for the same reason Part 22
 * moved off a fixed frame count in the first place: however long Discord's
 * own reaction actually takes, this waits for actual quiet (200ms with no
 * further size change) rather than guessing a number and risking being
 * wrong again. A hard 1.5s ceiling exists only as a backstop against a
 * contentWrapper that (for whatever reason) never goes quiet, so the probe
 * can't be left in place indefinitely.
 *
 * Scroll position (INVESTIGATION.md Part 26, refined in Part 27): captured
 * *once*, right here at the very top, before anything - probe included -
 * has touched contentWrapper or the grid at all, and restored only once,
 * at the very end, against that single captured value. Part 26's first
 * attempt restored scroll around each individual max-height write instead,
 * which broke for scroll positions close to (but not exactly at) the
 * bottom: the oversized probe's own still-finite legal scrollTop range
 * could silently re-clamp a "nearly at the bottom" position during the
 * probe step, and that already-clamped value then got mistaken for the
 * original intent by the time the final step ran. Capturing once up front,
 * before the real grid's legal range ever changes, sidesteps that
 * entirely - the real grid's clientHeight now only ever changes once
 * (directly to its final value), so there's exactly one moment where the
 * captured intent needs to still be legal, and by then the grid is back to
 * (or already at) its correct, full-range size.
 *
 * Returns a cancel function - callers should invoke it from their own
 * effect's cleanup (or before starting a replacement call), so this can't
 * finish and write a value after the modal's closed or a newer resize has
 * superseded it.
 */
function settleGridHeight(dialog: HTMLElement, targetDialogHeight: number): () => void {
    const grid = document.querySelector<HTMLElement>(".vc-gif-folders-grid");
    if (!grid) return () => {};

    let contentWrapper: HTMLElement | null = document.querySelector<HTMLElement>(".vc-gif-folders-search-row");
    while (contentWrapper && contentWrapper.parentElement && contentWrapper.parentElement !== dialog) {
        contentWrapper = contentWrapper.parentElement;
    }
    if (!contentWrapper) return () => {};
    const wrapperEl = contentWrapper;

    const scrollTopBeforeSettle = grid.scrollTop;
    const wasAtBottomBeforeSettle = scrollTopBeforeSettle >= grid.scrollHeight - grid.clientHeight - 1;

    const probe = createSizingProbe(grid, targetDialogHeight);

    let done = false;
    let settleTimer = 0;
    let maxWaitTimer = 0;

    const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        window.clearTimeout(settleTimer);
        window.clearTimeout(maxWaitTimer);
        // Measure while the probe is still in place (it's what's currently
        // holding contentWrapper open to its true ceiling) - removing it
        // first would let contentWrapper immediately shrink back to fit
        // only the still-unchanged real grid, reintroducing exactly the
        // content-driven measurement problem Part 23 fixed.
        const available = computeAvailableGridContentHeight(dialog);
        probe.remove();
        if (available !== null) {
            setGridMaxHeight(available);
            // See REMEMBERED_GRID_CONTENT_HEIGHT_KEY's own comment and
            // INVESTIGATION.md Part 29 - this is the one place a real,
            // precisely-measured value (as opposed to a formula guess) ever
            // becomes available, so it's the only place worth persisting it
            // from.
            void persistRememberedGridContentHeight(available);
        }
        grid.scrollTop = wasAtBottomBeforeSettle
            ? grid.scrollHeight - grid.clientHeight
            : scrollTopBeforeSettle;
    };

    const observer = new ResizeObserver(() => {
        window.clearTimeout(settleTimer);
        settleTimer = window.setTimeout(finish, 200);
    });
    observer.observe(wrapperEl);
    settleTimer = window.setTimeout(finish, 200);
    maxWaitTimer = window.setTimeout(finish, 1500);

    return () => {
        if (done) return;
        done = true;
        observer.disconnect();
        window.clearTimeout(settleTimer);
        window.clearTimeout(maxWaitTimer);
        probe.remove();
    };
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
                    if (!next && (Object.keys(mediaCache).length > 0 || pendingLegacy.size > 0)) {
                        showToast({ text: 'Cache disabled. Use "Clear Cache" to free up existing space.', variant: "default" });
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
                            action={() => {
                                s.maxCacheSize = opt;
                                applyCacheBudget();
                            }}
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
    displayWidth?: number;
    displayHeight?: number;
    close(): void;
}

/**
 * Which part of a frame the tile actually shows, and at what size to keep it.
 * Tiles use object-fit: cover, so only the centered region with the tile's aspect
 * ratio is ever visible - decoding just that region, at the tile's on-screen size
 * (in device pixels), looks identical but needs far less memory than keeping every
 * frame at the GIF's full resolution. Never upscales: a GIF smaller than the tile
 * keeps its native resolution and CSS scales it up exactly as before.
 */
function coverCrop(srcW: number | undefined, srcH: number | undefined, box: { w: number; h: number; }) {
    if (!srcW || !srcH || srcW <= 0 || srcH <= 0) return null;
    const boxRatio = box.w / box.h;
    let sw = srcW;
    let sh = srcH;
    if (srcW / srcH > boxRatio) sw = Math.max(1, Math.round(srcH * boxRatio));
    else sh = Math.max(1, Math.round(srcW / boxRatio));
    const sx = Math.floor((srcW - sw) / 2);
    const sy = Math.floor((srcH - sh) / 2);
    const scale = Math.min(1, box.w / sw);
    return { sx, sy, sw, sh, rw: Math.max(1, Math.round(sw * scale)), rh: Math.max(1, Math.round(sh * scale)) };
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

function AnimatedCanvasImage({ label, blob, mimeType, className, onClick, onLoad, onError }: {
    label: string;
    /** The cached file, already loaded by the tile (see requestBlob) */
    blob: Blob;
    mimeType: string;
    className?: string;
    onClick?: (e: React.MouseEvent) => void;
    onLoad?: () => void;
    onError?: () => void;
}) {
    const canvasRef = React.useRef<HTMLCanvasElement>(null);

    // The tile's on-screen size in device pixels - frames are decoded at this size
    // (see coverCrop). Re-measured when the tile grows noticeably (window resize,
    // column setting); shrinking keeps the already-decoded, sharper frames.
    const [targetBox, setTargetBox] = useState<{ w: number; h: number; } | null>(null);
    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        let current: { w: number; h: number; } | null = null;
        let growTimer: ReturnType<typeof setTimeout> | null = null;
        const measure = () => {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.ceil(canvas.clientWidth * dpr);
            const h = Math.ceil(canvas.clientHeight * dpr);
            return w > 0 && h > 0 ? { w, h } : null;
        };
        const apply = (box: { w: number; h: number; }) => {
            current = box;
            setTargetBox(box);
        };

        const initial = measure();
        if (initial) apply(initial);

        const observer = new ResizeObserver(() => {
            const box = measure();
            if (!box) return;
            if (!current) {
                apply(box);
                return;
            }
            if (box.w <= current.w * 1.25 && box.h <= current.h * 1.25) return;
            // Debounced so dragging the window edge doesn't re-decode on every frame of the drag
            if (growTimer) clearTimeout(growTimer);
            growTimer = setTimeout(() => {
                const settled = measure();
                if (settled && current && (settled.w > current.w * 1.25 || settled.h > current.h * 1.25)) apply(settled);
            }, 300);
        });
        observer.observe(canvas);
        return () => {
            observer.disconnect();
            if (growTimer) clearTimeout(growTimer);
        };
    }, []);

    React.useEffect(() => {
        if (!targetBox) return;
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
                // Worked out from the first frame and reused for every frame, so they all
                // come out the same size. null = keep frames at full size (also the
                // fallback if this Chromium can't crop/resize while converting).
                let crop: ReturnType<typeof coverCrop> | undefined;
                for (let i = 0; i < frameCount; i++) {
                    if (cancelled) break;
                    const { image } = await dec.decode({ frameIndex: i });
                    try {
                        const source = image as unknown as ImageBitmapSource;
                        let bitmap: ImageBitmap | null = null;
                        if (crop === undefined) crop = coverCrop(image.displayWidth, image.displayHeight, targetBox);
                        if (crop) {
                            try {
                                bitmap = await createImageBitmap(source, crop.sx, crop.sy, crop.sw, crop.sh, {
                                    resizeWidth: crop.rw,
                                    resizeHeight: crop.rh,
                                    resizeQuality: "high"
                                });
                            } catch (e) {
                                if (i !== 0) throw e;
                                logger.warn("Canvas player: couldn't decode at tile size, using full size", label, e);
                                crop = null;
                            }
                        }
                        bitmap ??= await createImageBitmap(source);
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
    }, [blob, mimeType, targetBox]);

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

// ---------- Retry-all for tiles stuck on "Couldn't load" ----------
//
// Every tile currently showing "Couldn't load - tap to retry", keyed by entry.id
// - not mediaSrc/hashUrl, since two different saved entries (even across two
// different folders) can point at the same underlying URL and are still two
// independently-broken *tiles*, each needing its own retry. A tile adds itself
// the moment it enters the broken state and removes itself the moment it leaves
// it, for any reason - see the registration effect on GifTile below. Only one
// grid (the open folder, or search results) is ever mounted at a time (see
// ManagerModal), so this never accumulates entries for a view the person has
// since navigated away from - same shape of lifetime as sharedVisibilityObservers
// just above.
const brokenTileRetries = new Map<string, () => Promise<unknown>>();

// Deliberately smaller than EXPORT_BATCH_SIZE (8 - see exportAllFoldersToDisk):
// a batch here is a *forced* re-fetch (bypassCircuit) of files that just failed
// to load at all, not files the export flow already expects to mostly be cache
// hits, so it's worth staying more conservative about how much simultaneous work
// (bytes in flight, base64 conversions - see cacheGif) this throws at the process
// at once. Matches ensureCached's own existing concurrency default (4) for a
// similar workload, without actually reusing ensureCached here: that helper
// skips anything already cached and never bypasses the circuit breaker, both
// wrong for retrying files that just failed. See INVESTIGATION.md Part 19.
const RETRY_ALL_BATCH_SIZE = 4;

let retryAllInProgress = false;

async function retryOneBrokenTile(id: string) {
    try {
        await brokenTileRetries.get(id)?.();
    } catch {
        // A single tile failing to retry shouldn't derail the rest of the batch -
        // it just stays on the "Couldn't load" placeholder, same as if this had
        // been the only tile retried at all.
    }
}

/**
 * Fired from a single tile's "Couldn't load - tap to retry" button (see
 * handleRetryClick on GifTile) - that tile has already retried itself by the
 * time this runs (handleRetryClick calls retry() directly, unconditionally, so
 * the tile someone actually tapped never waits on a batch). This handles every
 * *other* tile currently stuck on the same message, a few at a time rather than
 * all at once, so retrying a folder with a couple dozen dead links can't spike
 * memory the way firing every retry simultaneously could. See INVESTIGATION.md
 * Part 19 for the full writeup, including why this needed to be a real batch
 * boundary (awaiting each slice before starting the next) rather than just a
 * concurrency-limited pool like ensureCached.
 *
 * Re-reads the registry fresh for every tile - not a snapshot of retry functions
 * taken once up front - so a tile that's already recovered or unmounted by the
 * time its turn comes up (another click, a folder switch, a background refresh
 * succeeding first) is skipped rather than retried pointlessly.
 */
async function retryAllOtherBrokenTiles(excludeId: string) {
    if (retryAllInProgress) return;
    const ids = Array.from(brokenTileRetries.keys()).filter(id => id !== excludeId);
    if (ids.length === 0) return;

    retryAllInProgress = true;
    try {
        let index = 0;
        while (index < ids.length) {
            const slice = ids.slice(index, index + RETRY_ALL_BATCH_SIZE);
            index += slice.length;
            // Awaited before the next slice starts - this is what actually bounds
            // peak concurrency to RETRY_ALL_BATCH_SIZE, not just a cosmetic pause.
            await Promise.all(slice.map(retryOneBrokenTile));
        }
    } finally {
        retryAllInProgress = false;
    }
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

    // Whether there's a local copy of this file (in either storage format), and the
    // copy itself once it's loaded. The file is only loaded while the tile is visible
    // (see the effect below) and released again when it scrolls away, so a folder
    // with hundreds of entries only ever has the visible ones' files loaded.
    const hasCachedBytes = isCachedSrc(entry.mediaSrc);
    const [heldBlob, setHeldBlob] = useState<Blob | null>(null);
    // An already-loaded copy can be used on this very render - no placeholder flash
    const blob = hasCachedBytes && isVisible ? (heldBlob ?? peekLoadedBlob(entry.mediaSrc)) : null;
    const waitingForBlob = hasCachedBytes && isVisible && !blob;

    React.useEffect(() => {
        if (!isVisible || !hasCachedBytes) {
            setHeldBlob(null);
            return;
        }
        if (heldBlob) return;
        let cancelled = false;
        requestBlob(entry.mediaSrc).then(b => {
            if (!cancelled && b) setHeldBlob(b);
        });
        return () => { cancelled = true; };
    }, [isVisible, hasCachedBytes, heldBlob, entry.mediaSrc]);

    // Played from a blob: URL rather than a data: URI - see getPlayableSrc for why.
    // isVideo/isDirectMediaUrl are computed from entry.mediaSrc (the real URL), never
    // from displaySrc, since a blob: URL has no host or file extension to look at.
    // Canvas-played tiles (cached GIF/WebP) read the Blob directly, so only the
    // <img>/<video> players get a blob: URL - each URL keeps its file alive until revoked
    const blobMimeType = getCacheEntry(entry.mediaSrc)?.mimeType || blob?.type || "";
    const playsOnCanvas = !!blob && !canvasFailed && !isVideoUrl(entry.mediaSrc) && (blobMimeType === "image/gif" || blobMimeType === "image/webp");
    const cachedSrc = blob && !playsOnCanvas ? getPlayableSrc(entry.mediaSrc, blob, restartTick) : null;
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
    const isUnpreviewable = !hasCachedBytes && !isVideo && !isDirectMediaUrl(entry.mediaSrc);

    // Prefer the canvas player (see AnimatedCanvasImage above) whenever we actually
    // have cached bytes for a gif/webp - the only formats that need frame-accurate
    // looping at all (video loops natively via the <video loop> attribute, and a
    // static image has nothing to loop). This is what actually guarantees correct
    // looping now; the <img>-based restart-tick system below only remains as the
    // fallback for uncached entries, where we don't have bytes to decode from yet.
    const cachedEntry = getCacheEntry(entry.mediaSrc);
    const cachedMimeType = cachedEntry?.mimeType || blob?.type || null;
    const canUseCanvas = !canvasFailed && !isVideo && !!blob && (cachedMimeType === "image/gif" || cachedMimeType === "image/webp");

    React.useEffect(() => {
        setBroken(false);
        setLoaded(false);
        setRestartTick(0);
        setBustBroken(false);
        setCanvasFailed(false);
        setHeldBlob(null);
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
        // canUseCanvas is a dep because the cached copy now loads a moment after the
        // tile appears - once it's playing on the canvas, these restarts aren't needed
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entry.mediaSrc, isVideo, broken, isUnpreviewable, canUseCanvas]);

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
        // Returned (not fired-and-forgotten) so retryAllOtherBrokenTiles can await
        // it - that's what actually bounds how many of these run at once when a
        // lot of tiles get retried together. onClick={handleRetryClick} below
        // doesn't care about the return value either way.
        return cacheGif(entry.mediaSrc, /* bypassCircuit */ true);
    }

    // Exposes this tile's retry() to retryAllOtherBrokenTiles (above), but only
    // for as long as this tile is actually showing the "Couldn't load" placeholder
    // - added the moment `broken` becomes true, removed the moment it stops being
    // true for any reason (this retry succeeding, entry.mediaSrc changing out from
    // under it via refreshEntryMediaUrl, which itself forces broken back to false -
    // see the mount effect above - or unmounting outright). retry is a new
    // function every render, but it's safe to leave out of this effect's own deps:
    // entry.mediaSrc can't change without broken also going false first (see
    // above), so the closure captured here can never actually go stale while it's
    // still registered.
    React.useEffect(() => {
        if (!broken) return;
        brokenTileRetries.set(entry.id, retry);
        return () => { brokenTileRetries.delete(entry.id); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [broken, entry.id]);

    // The actual click handler for the "Couldn't load" placeholder below: retries
    // this tile immediately and unconditionally (same as always), then separately
    // kicks off a bounded, batched retry of every other tile currently stuck on
    // the same message. See INVESTIGATION.md Part 19.
    function handleRetryClick() {
        retry();
        void retryAllOtherBrokenTiles(entry.id);
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
                {/* A smaller copy has no link - it can only be sent (uploaded) */}
                {!isLocalSrc(entry.shareSrc) && (
                    <Menu.MenuItem
                        id="gif-tile-insert"
                        label="Insert into Chat Box"
                        action={() => {
                            insertTextIntoChatInputBox(entry.shareSrc + " ");
                            showToast({ text: "Inserted into chat box", variant: "success" });
                        }}
                    />
                )}
                {!isLocalSrc(entry.shareSrc) && (
                    <Menu.MenuItem
                        id="gif-tile-copy"
                        label="Copy Link"
                        action={() => {
                            navigator.clipboard?.writeText(entry.shareSrc);
                            showToast({ text: "Copied link to clipboard", variant: "success" });
                        }}
                    />
                )}
                <Menu.MenuItem
                    id="gif-tile-rename"
                    label="Rename"
                    action={() => openGifRenamePrompt(folder, entry)}
                />
                <Menu.MenuItem
                    id="gif-tile-compress"
                    label={cachedEntry ? `Make Smaller Copy\u2026 (now ${formatMB(cachedEntry.size)})` : "Make Smaller Copy\u2026"}
                    action={() => openCompressModal(folder, entry)}
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
                    onClick={() => { if (!isLocalSrc(entry.shareSrc)) VencordNative.native.openExternal(entry.shareSrc); }}
                >
                    <OpenExternalIcon width={18} height={18} />
                    <span>No preview — open original</span>
                </div>
            ) : broken ? (
                <div className="vc-gif-folders-tile-broken" role="button" onClick={handleRetryClick}>
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
            ) : waitingForBlob ? (
                // Cached, and the local copy is being loaded (usually a few ms) -
                // the live link isn't needed for that
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
            ) : canUseCanvas && blob && cachedMimeType ? (
                <AnimatedCanvasImage
                    key={entry.mediaSrc}
                    label={entry.name}
                    blob={blob}
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

    // Holding Ctrl (e.g. for instant send) or Shift normally stops the wheel from
    // scrolling the grid: Discord uses Ctrl+wheel for zoom, and Chromium turns
    // Shift+wheel into sideways scrolling. Over the grid, scroll it vertically instead.
    React.useEffect(() => {
        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey && !e.shiftKey) return;
            const grid = (e.target as Element | null)?.closest?.(".vc-gif-folders-grid") as HTMLElement | null;
            if (!grid) return;
            // Shift+wheel may arrive as horizontal movement - use whichever axis moved
            let delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
            if (e.deltaMode === 1) delta *= 40; // lines
            else if (e.deltaMode === 2) delta *= grid.clientHeight; // pages
            if (!delta) return;
            e.preventDefault();
            e.stopPropagation();
            grid.scrollTop += delta;
        };
        // Capture + non-passive, so this runs before Discord's zoom handler and can cancel it
        window.addEventListener("wheel", onWheel, { capture: true, passive: false });
        return () => window.removeEventListener("wheel", onWheel, { capture: true });
    }, []);

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
    // afterward. Also grows/shrinks .vc-gif-folders-grid's own max-height to
    // match - see GRID_MAXHEIGHT_STYLE_ID's comment for why - so reopening at
    // a remembered height actually shows the right number of rows instead of
    // just reserving blank space for them.
    //
    // The same-frame first-paint guess prefers rememberedGridContentHeight
    // (a real, precisely-*measured* value from the last successful settle -
    // see its own comment and INVESTIGATION.md Part 29) over the delta
    // formula (see INVESTIGATION.md Part 20 for why that formula alone is
    // only ever approximate - it doesn't know how tall the chrome above the
    // grid currently happens to be). In the common case - nothing about the
    // chrome has changed since last time - this makes the guess exactly
    // right already, so settleGridHeight's own correction below finds
    // nothing to change and there's no visible jump at all. The delta
    // formula remains as a fallback for a case rememberedGridContentHeight
    // can't cover: the very first open ever (or after clearing data), where
    // no prior measurement exists yet to remember.
    React.useLayoutEffect(() => {
        const el = findModalDialogElement();
        if (!el) return;
        baseModalHeightRef.current = el.getBoundingClientRect().height;
        if (rememberedHeight) {
            const targetHeight = Math.round(rememberedHeight);
            setDialogHeight(el, targetHeight);
            setGridMaxHeight(rememberedGridContentHeight ?? (GRID_DEFAULT_MAX_HEIGHT_PX + (targetHeight - baseModalHeightRef.current)));
            return settleGridHeight(el, targetHeight);
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
        //
        // pendingSettleCancel is shared across both handles (top and bottom
        // can't both be mid-drag at once, but tracking it outside the loop
        // means a second drag's settle cleanly supersedes an unfinished
        // first one's, and the outer cleanup below can always cancel
        // whatever's still pending when the modal closes) - see
        // settleGridHeight's own comment, and INVESTIGATION.md Part 23, for
        // why onPointerUp needs this rather than a live measurement or a
        // persistent ResizeObserver.
        let pendingSettleCancel: (() => void) | null = null;
        for (const edge of ["top", "bottom"] as const) {
            const handle = document.createElement("div");
            handle.className = `vc-gif-folders-resize-handle-horizontal vc-gif-folders-resize-handle-${edge}`;
            dialog.appendChild(handle);

            let drag: { startY: number; startHeight: number; startGridMaxHeight: number; lastAppliedHeight: number; } | null = null;
            const onPointerDown = (e: PointerEvent) => {
                e.preventDefault();
                const grid = document.querySelector<HTMLElement>(".vc-gif-folders-grid");
                const startHeight = dialog.getBoundingClientRect().height;
                // grid.getBoundingClientRect().height is the OUTER (rendered)
                // box height, but setGridMaxHeight sets a CONTENT-box
                // max-height (grid is confirmed content-box - see
                // computeAvailableGridContentHeight's own comment) - so
                // subtract the grid's own padding to get a value that
                // actually matches what setGridMaxHeight expects, the same
                // way computeAvailableGridContentHeight already does. See
                // INVESTIGATION.md Part 28: left as a known, deliberately
                // unfixed ~28px (padding-sized) error since Part 20 - small
                // enough to go unnoticed against a normal drag's much
                // bigger changes, but stark and constant for the entire
                // hold in the "already at the height limit, still holding
                // the handle" case, where nothing else masks it - it grows
                // the grid's clientHeight by that same ~28px the instant
                // ANY drag starts, which forces the browser to clamp
                // scrollTop down by the same amount if scrolled near the
                // bottom (visible as content shifting down the screen, "as
                // if scrolled up slightly") and grows the scrollbar thumb
                // slightly too (proportional to clientHeight/scrollHeight) -
                // one root cause behind two separately-reported symptoms.
                let startGridMaxHeight = GRID_DEFAULT_MAX_HEIGHT_PX;
                if (grid) {
                    const gridStyles = getComputedStyle(grid);
                    const verticalPadding = (parseFloat(gridStyles.paddingTop) || 0) + (parseFloat(gridStyles.paddingBottom) || 0);
                    startGridMaxHeight = grid.getBoundingClientRect().height - verticalPadding;
                }
                drag = {
                    startY: e.clientY,
                    startHeight,
                    startGridMaxHeight,
                    lastAppliedHeight: startHeight
                };
                handle.setPointerCapture(e.pointerId);
            };
            const onPointerMove = (e: PointerEvent) => {
                if (!drag) return;
                const dy = e.clientY - drag.startY;
                const delta = edge === "bottom" ? dy : -dy;
                const newHeight = Math.max(MIN_MODAL_HEIGHT_PX, Math.min(window.innerHeight * 0.92, drag.startHeight + delta));
                const rounded = Math.round(newHeight);
                setDialogHeight(dialog, rounded);
                // appliedDelta (how much the dialog actually moved, after the
                // MIN_MODAL_HEIGHT_PX/0.92-of-viewport clamp above) rather
                // than the raw, unclamped `delta` (how far the cursor itself
                // moved) - see INVESTIGATION.md Part 24. Dragging past
                // either end of that clamp used to keep growing/shrinking
                // the grid's own live-tracked height using the cursor's raw
                // distance even once the dialog itself had stopped moving,
                // so the grid would end up taller than contentWrapper could
                // actually show - a transient version of the same clipping
                // this file has been chasing since Part 20, visible only
                // while still holding the drag past the limit (settleGridHeight
                // on release always corrected it, which is why letting go
                // fixed it).
                const appliedDelta = rounded - drag.startHeight;
                drag.lastAppliedHeight = rounded;
                // Same-frame approximate tracking during the drag itself,
                // for smoothness (avoids a getBoundingClientRect()
                // forced-reflow on every pointermove tick of a fast drag) -
                // see INVESTIGATION.md Part 20 for why this formula alone is
                // only ever approximate. settleGridHeight corrects this to
                // an exact value once, on release, below - not live during
                // the drag itself, since it needs a moment to settle (see
                // its own comment).
                //
                // Deliberately no scroll-position bookkeeping here either
                // (INVESTIGATION.md Part 27) - settleGridHeight captures
                // scrollTop once, at its own start (i.e. right when the
                // drag ends), and restores it once at the very end. That
                // doesn't protect against *this* live tracking itself
                // clamping scrollTop sometime during the drag, before
                // settleGridHeight ever runs - a known, accepted gap (see
                // Part 27's own notes) rather than something this line
                // could fix by also reading scrollTop on every tick, since
                // that would just be the same per-tick forced-reflow cost
                // this comment already avoids above.
                setGridMaxHeight(drag.startGridMaxHeight + appliedDelta);
            };
            const onPointerUp = () => {
                if (drag) {
                    void persistRememberedHeight(drag.lastAppliedHeight);
                    pendingSettleCancel?.();
                    pendingSettleCancel = settleGridHeight(dialog, drag.lastAppliedHeight);
                }
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
        cleanups.push(() => pendingSettleCancel?.());

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

    // Drag-to-reorder for the folder tabs themselves - see reorderFolder.
    // Exact same plain-pointer-event approach as the GIF tile reordering just
    // above (and for the same reason: Discord's own global drag listeners
    // interfere with the native Drag and Drop API), just tracking folder
    // names via data-folder-name instead of GIF ids via data-gif-id. Kept as
    // fully separate state/refs/effect from the tile version above rather
    // than sharing one - each only ever looks at its own ref, so having both
    // mounted at once can't cross-fire, and it keeps this block copy-pastable
    // if the tile version's logic ever needs to diverge later.
    const [draggedFolder, setDraggedFolder] = useState<string | null>(null);
    const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null);
    const folderDragStartRef = React.useRef<{ x: number; y: number; name: string; } | null>(null);
    const isFolderDraggingRef = React.useRef(false);
    const overFolderRef = React.useRef<string | null>(null);

    function handleFolderTabPointerDown(e: React.PointerEvent) {
        if (e.button !== 0) return;
        const name = e.currentTarget.getAttribute("data-folder-name");
        if (!name) return;
        // Same belt-and-suspenders reasoning as handleTilePointerDown above.
        e.preventDefault();
        folderDragStartRef.current = { x: e.clientX, y: e.clientY, name };
    }

    React.useEffect(() => {
        function onPointerMove(e: PointerEvent) {
            const start = folderDragStartRef.current;
            if (!start) return;

            if (!isFolderDraggingRef.current) {
                const dx = e.clientX - start.x;
                const dy = e.clientY - start.y;
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
                isFolderDraggingRef.current = true;
                setDraggedFolder(start.name);
            }

            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
            const tabEl = el?.closest<HTMLElement>("[data-folder-name]");
            const overName = tabEl?.getAttribute("data-folder-name") ?? null;
            const resolved = overName && overName !== start.name ? overName : null;
            overFolderRef.current = resolved;
            setDropTargetFolder(resolved);
        }

        function endDrag() {
            const start = folderDragStartRef.current;
            if (start && isFolderDraggingRef.current && overFolderRef.current) {
                void reorderFolder(start.name, overFolderRef.current);
            }
            folderDragStartRef.current = null;
            isFolderDraggingRef.current = false;
            overFolderRef.current = null;
            setDraggedFolder(null);
            setDropTargetFolder(null);
        }

        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", endDrag);
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
            showToast({ text: "Couldn't find the current channel", variant: "critical" });
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
                    showToast({ text: "Couldn't send GIF - see console for details", variant: "critical" });
                });
            } else {
                // Always (re)send the original share link, never the internally-
                // resolved preview media url - see the shareSrc/mediaSrc split on
                // GifEntry for why.
                sendMessage(channel.id, { content: entry.shareSrc });
            }
        }

        if (isLocalSrc(entry.shareSrc)) {
            // A smaller copy only exists here, so it's always uploaded as a file
            sendAsFreshAttachment(channel.id, entry, replyReference, allowedMentions).then(sent => {
                if (sent) clearPendingReply();
                else showToast({ text: "Couldn't upload the smaller copy - see console for details", variant: "critical" });
            });
        } else if (isDiscordAttachmentUrl(entry.shareSrc)) {
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
            showToast({ text: "Sent to chat", variant: "success" });
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
            showToast({ text: "This needs the desktop app - not available here", variant: "critical" });
            return;
        }

        const totalCount = getFolderNames().reduce((sum, name) => sum + (cache[name]?.length ?? 0), 0);
        if (totalCount === 0) {
            showToast({ text: "No GIFs saved yet", variant: "critical" });
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
            showToast({ text: `Exported ${result.written} GIF(s) to ${basePath}${skippedNote}`, variant: "success" });
        } catch (e) {
            logger.error("Export to disk failed", e);
            showToast({ text: "Couldn't export - see console for details", variant: "critical" });
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
                        <Paragraph style={{ margin: "16px 0" }}>
                            No folders yet. Create one to start saving GIFs.
                        </Paragraph>
                    )}
                    {folderNames.map(name => (
                        <div
                            key={name}
                            className={
                                "vc-gif-folders-tab"
                                + (name === currentFolder ? " vc-gif-folders-tab-active" : "")
                                + (draggedFolder === name ? " vc-gif-folders-tab-dragging" : "")
                                + (dropTargetFolder === name ? " vc-gif-folders-tab-drop-target" : "")
                            }
                            data-folder-name={name}
                            onPointerDown={handleFolderTabPointerDown}
                            onClick={() => setActive(name)}
                        >
                            {name} <span className="vc-gif-folders-tab-count">{cache[name].length}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="vc-gif-folders-toolbar">
                <Paragraph style={{ flexGrow: 1, opacity: 0.7 }}>
                    {isSearching && (
                        debouncedQuery !== trimmedQuery
                            ? "Searching\u2026"
                            : hiddenResultCount > 0
                                ? `${allSearchResults.length} result(s) for "${debouncedQuery}" - showing first ${searchResults.length}, refine your search to narrow it down`
                                : `${allSearchResults.length} result(s) for "${debouncedQuery}"`
                    )}
                </Paragraph>
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
                        onClick={() => void exportFolderToJson(currentFolder)}
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
                    <Paragraph style={EMPTY_STATE_TEXT_STYLE}>
                        No GIFs match "{debouncedQuery}". Try renaming a GIF so it's easier to find later.
                    </Paragraph>
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
                        <Paragraph style={EMPTY_STATE_TEXT_STYLE}>
                            No GIFs saved in "{currentFolder}" yet. Right click a GIF in chat and choose
                            "Save GIF to" → "{currentFolder}".
                        </Paragraph>
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
        // Converts old-format cached files in the background - see runLegacyMigration
        void runLegacyMigration();
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
        // Free the in-memory copy of the media cache (it can be hundreds of MB) instead
        // of holding it until Discord restarts. Only memory is dropped - nothing is
        // deleted from storage, and start() loads it all back if the plugin is re-enabled.
        migrationRun++; // stops a conversion in progress (it continues next start)
        for (const key of [...blobUrlCache.keys()]) releaseBlobUrl(key);
        clearCachedBlobs();
        mediaCache = {};
        pendingLegacy = new Map();
    }
});
