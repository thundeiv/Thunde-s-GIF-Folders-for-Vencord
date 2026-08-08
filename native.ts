/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, dialog, BrowserWindow } from "electron";
import fs from "fs/promises";
import { appendFileSync } from "fs";
import path from "path";

import http from "http";
import https from "https";

const MAX_BYTES = 20 * 1024 * 1024; // matches the sanity guard in index.tsx
const TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

// ---------- Crash-safe diagnostic logging ----------
//
// Temporary instrumentation for the still-unconfirmed main-process crash
// documented in INVESTIGATION.md (Parts 3-4). An uncaught exception in this
// file's raw http callbacks can kill the whole Electron main process before
// any of the plugin's own error handling ever gets a chance to run - so if
// that happens again, there's nothing else that writes it down anywhere.
// console.error alone isn't enough here: this is the main process, not the
// renderer, so nothing shows up in Discord's own DevTools console during a
// normal installed session. Writing synchronously to a file is the only way
// to guarantee the message survives a process that's about to die.
//
// This is a safety net for diagnosis, not a fix, and it's intentionally
// broad - every uncaught exception in the main process, not just this
// plugin's own code - since narrowing it down before a real stack trace is
// in hand risks missing whatever the next occurrence actually turns out to
// be. Worth removing (or narrowing to specific spots) once this has either
// confirmed a cause or gone quiet for a good while.
function logCrash(kind: string, err: unknown) {
    try {
        const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
        const logPath = path.join(app.getPath("userData"), "gif-folders-crash.log");
        appendFileSync(logPath, `[${new Date().toISOString()}] ${kind}: ${detail}\n\n`);
    } catch {
        // If even this fails, there's genuinely nothing left to do - the
        // process is already on its way down.
    }
}

process.on("uncaughtException", err => logCrash("uncaughtException", err));
process.on("unhandledRejection", err => logCrash("unhandledRejection", err));

interface DownloadResult {
    base64: string;
    mimeType: string;
}

/**
 * Downloads a URL from Node's main process, entirely outside the renderer's
 * Content-Security-Policy. Some Discord clients' CSP allows loading media via
 * <img>/<video> tags (governed by img-src/media-src) but blocks fetch()/XHR to the
 * same origins outright (connect-src) - since that's a renderer-only restriction,
 * running the request here sidesteps it completely. Only used for local caching;
 * the plugin falls back to the renderer's own fetch() (and ultimately to just
 * displaying the live link) if this isn't available or fails, so nothing depends on
 * this working.
 */
export function downloadMedia(_event: unknown, url: string): Promise<DownloadResult | null> {
    return downloadWithRedirects(url, 0);
}

function downloadWithRedirects(url: string, redirectCount: number): Promise<DownloadResult | null> {
    return new Promise(resolve => {
        let target: URL;
        try {
            target = new URL(url);
        } catch {
            resolve(null);
            return;
        }
        if (target.protocol !== "https:" && target.protocol !== "http:") {
            resolve(null);
            return;
        }

        const client = target.protocol === "https:" ? https : http;
        const req = client.get(
            target,
            {
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8"
                }
            },
            res => {
                // Everything in this callback runs from Node's http machinery, not
                // from this Promise's executor - unlike the new URL(url) call above,
                // a throw in here (e.g. new URL() below rejecting a malformed
                // redirect Location header) has no try/catch or promise sitting
                // above it to catch it. An uncaught exception at this level can
                // crash the whole Electron main process - not just fail this one
                // download - so every exit path here must go through resolve(),
                // never a throw. (See INVESTIGATION.md, Part 4.)
                try {
                    const status = res.statusCode ?? 0;

                    if (status >= 300 && status < 400 && res.headers.location) {
                        res.resume();
                        if (redirectCount >= MAX_REDIRECTS) {
                            resolve(null);
                            return;
                        }
                        const nextUrl = new URL(res.headers.location, target).toString();
                        downloadWithRedirects(nextUrl, redirectCount + 1).then(resolve);
                        return;
                    }

                    if (status !== 200) {
                        res.resume();
                        resolve(null);
                        return;
                    }

                    const chunks: Buffer[] = [];
                    let total = 0;
                    let tooBig = false;

                    res.on("data", (chunk: Buffer) => {
                        // Same reasoning as 'end' below and the outer try above: this
                        // callback also runs later, straight from Node's own stream
                        // internals, so the outer try can't reach it - without its own
                        // guard, a throw here is an uncaught exception with nothing
                        // above it to catch it. (This was the one exit path in this
                        // function that never got that treatment - see the chat
                        // investigation that found this, following on from Part 4.)
                        try {
                            total += chunk.length;
                            if (total > MAX_BYTES) {
                                tooBig = true;
                                req.destroy();
                                return;
                            }
                            chunks.push(chunk);
                        } catch {
                            resolve(null);
                        }
                    });
                    res.on("end", () => {
                        if (tooBig) {
                            resolve(null);
                            return;
                        }
                        // Same reasoning as the outer try: this is yet another
                        // separate, later callback invocation the outer try can't
                        // reach, so it needs its own guard.
                        try {
                            const buffer = Buffer.concat(chunks);
                            const mimeType = res.headers["content-type"]?.split(";")[0]?.trim() || "application/octet-stream";
                            resolve({ base64: buffer.toString("base64"), mimeType });
                        } catch {
                            resolve(null);
                        }
                    });
                    res.on("error", () => resolve(null));
                } catch {
                    resolve(null);
                }
            }
        );

        req.on("error", () => resolve(null));
        // destroy() is documented not to throw in normal operation, but this was the
        // last remaining unguarded exit path in this function - guarding it costs
        // nothing and closes the gap completely.
        req.setTimeout(TIMEOUT_MS, () => {
            try {
                req.destroy();
            } catch {
                resolve(null);
            }
        });
    });
}

interface ExportBatchItem {
    dirName: string;
    filename: string;
    base64: string;
}
interface ExportResult {
    written: number;
    skipped: number;
}

/**
 * Shows a native "choose a folder" dialog and returns the chosen path, or null if
 * the person cancelled. Split out from exportGifFileBatch (below) so the renderer
 * can offer this choice - and let the person back out for free - *before* paying
 * the cost of downloading/gathering any saved GIF's bytes, rather than only
 * after all of that work is already done. (See INVESTIGATION.md, Part 4.)
 */
export async function pickExportFolder(_event: unknown): Promise<string | null> {
    const win = BrowserWindow.getFocusedWindow() ?? undefined;
    const result = await dialog.showOpenDialog(win as any, {
        title: "Choose a location to export your GIF Folders",
        buttonLabel: "Export here",
        // "createDirectory" (macOS) and "promptToCreate" (Windows) both mean
        // roughly "let the person make a new folder from within this dialog" -
        // Electron silently ignores whichever one doesn't apply to this OS.
        properties: ["openDirectory", "createDirectory", "promptToCreate"]
    });
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

/**
 * Writes one small batch of already-named files to real files under basePath
 * (already chosen via pickExportFolder above) - e.g. basePath ~/Desktop plus
 * dirName "Favorites 1" creates ~/Desktop/Favorites 1/whatever.gif. Runs here
 * (the main process) rather than the renderer because writing arbitrary files
 * to an arbitrary disk location isn't something browser JS can do at all.
 *
 * Called repeatedly by the renderer, once per small batch of files, instead
 * of once for an entire export - see the chat investigation this follows on
 * from. Export used to gather every saved GIF's bytes into one giant
 * in-memory structure and hand the whole thing to a single IPC call; for a
 * large enough collection that meant holding a second near-complete copy of
 * the cache in memory (on top of the one already resident - see mediaCache)
 * and cloning all of it across the IPC boundary at once, which is exactly the
 * kind of single-huge-operation this plugin's other fixes were about
 * avoiding. This version only ever holds one batch's worth of base64 (a
 * handful of files) in memory at a time, on either side of the boundary.
 *
 * dirName/filename arrive already sanitized and deduped *globally* across the
 * whole export by the renderer, which sees every file up front and can
 * guarantee uniqueness - this function only ever sees one small slice of that
 * at a time, so it deliberately does NOT re-deduplicate here. Re-running
 * dedupeName per-batch, each with its own fresh, empty "used names" set,
 * would silently reintroduce collisions across batches (batch 2 has no idea
 * batch 1 already wrote "cat.gif"), overwriting an earlier batch's file
 * without any error. sanitizeName is still applied here too - defense in
 * depth, since these strings are about to become real filesystem paths - but
 * only as a no-op-if-already-clean re-check, never as a source of new names.
 */
export async function exportGifFileBatch(_event: unknown, basePath: string, items: ExportBatchItem[]): Promise<ExportResult> {
    let written = 0;
    let skipped = 0;
    const madeDirs = new Set<string>();

    for (const item of items) {
        try {
            const dirName = sanitizeName(item.dirName);
            const folderPath = path.join(basePath, dirName);
            if (!madeDirs.has(folderPath)) {
                await fs.mkdir(folderPath, { recursive: true });
                madeDirs.add(folderPath);
            }
            const filename = sanitizeName(item.filename);
            const buffer = Buffer.from(item.base64, "base64");
            await fs.writeFile(path.join(folderPath, filename), buffer);
            written++;
        } catch {
            skipped++;
        }
    }

    return { written, skipped };
}

/** Strips characters that are invalid in file/folder names on Windows - the
 * strictest common case; macOS/Linux tolerate most of these, but there's no harm
 * in being conservative everywhere. */
function sanitizeName(name: string): string {
    const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : "unnamed";
}

