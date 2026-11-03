# GIF Folders – developer notes

Notes for whoever (person or AI) works on this plugin next. Repo: https://github.com/thundeiv/Thunde-s-GIF-Folders-for-Vencord

The last update was 3 November 2026, built against **Vencord 1.15.15** (Vencord `main` as of 30 Oct 2026). The GitHub version before this update was the commit from 28 Aug 2026.

---

## 1. Why it stopped building (fixed in this update)

After updating Vencord, `pnpm build` failed with:

```
No matching export in "src/webpack/common/index.ts" for import "Forms"
No matching export in "src/webpack/common/index.ts" for import "Toasts"
```

Vencord removed both from `@webpack/common` in October 2026:

| Removed | Vencord commit | Replacement |
|---|---|---|
| `Toasts` (and the old `showToast(text, Toasts.Type.X)` form) | 14 Oct 2026, "Update to new Toasts API" (#4689) | `showToast({ text, variant })` with `variant` `"default"`, `"success"` or `"critical"` |
| `Forms.FormTitle`, `Forms.FormText` (also `Button`, `Text` from common) | 25 Oct 2026, "Finish migration to new components" (#3802) | `Heading` from `@components/Heading`, `Paragraph` from `@components/Paragraph` |

What changed in `index.tsx`:
- 23 `showToast(...)` calls were converted:
  - `MESSAGE` → `"default"`
  - `SUCCESS` → `"success"`
  - `FAILURE` → `"critical"`
- 1 `Forms.FormTitle` → `<Heading tag="h5">`. Inline styles copy the old look: colour `--text-strong`, line height 20 px, 8 px margin below. The old `FormTitle` used Vencord's legacy heading styles, and the new `Heading` defaults differ slightly.
- 5 `Forms.FormText` → `<Paragraph>`. Right before it was removed, `Forms.FormText` *was* `Paragraph`, so these look identical.
- The imports were updated to match.

`Button` was already imported from `@components/Button` with the new `variant` / `size` props, so it needed no change.

## 2. Other fixes in this update

1. **Error text colour.** Vencord's own code moved from `--text-danger` to Discord's newer `--text-feedback-critical`. The prompt's error text ("That name is already taken") now uses the newer variable, with `--text-danger` kept as a fallback. It is still red either way; this just keeps working if Discord drops the old name.
2. **`native.ts`: downloads could hang forever.** When a request was destroyed by the size limit or the timeout, neither `end` nor `error` was guaranteed to fire, so the promise never settled. A `close` handler now resolves `null`. It is guarded with `handedOff` so it doesn't cut off redirects.
3. **`native.ts`: export file names.**
   - A folder or GIF named `..` could write into the parent of the chosen export folder.
   - Windows device names (`CON`, `NUL`, `COM1`, …) failed to write.
   - Trailing dots or spaces got silently stripped by Windows, so names could collide.
   - `sanitizeName` now handles all three.
4. **GIFs that don't loop forever re-decoded their whole file every 4 seconds.** `getPlayableSrc` ran `atob` and copied the bytes into a new Blob on every restart tick (up to 20 MB per tile, per visible tile). A restart now only creates a new URL for an already-decoded Blob. This is now part of the shared Blob cache, see section 2b.
5. **Disabling the plugin kept the media cache in memory** until Discord restarted. `stop()` now releases the blob URLs and drops the in-memory cache. Nothing is deleted from storage, and `start()` loads it again.

## 2b. Performance update (3 Nov 2026)

### Canvas player decodes frames at tile size

**Before:** `AnimatedCanvasImage` decoded every frame (up to `MAX_DECODED_FRAMES` = 300) at the GIF's full resolution and kept all of them as `ImageBitmap`s for every visible tile.
- A 498×280 Tenor GIF costs 0.56 MB per frame; 60 frames ≈ 33 MB for one tile.
- A large 800×800 GIF with 150 frames ≈ 380 MB for one tile.

**Now:**
- The canvas measures its on-screen size (`clientWidth/Height × devicePixelRatio`).
- `coverCrop()` works out the centered region that `object-fit: cover` actually shows. Each frame is converted with `createImageBitmap(frame, sx, sy, sw, sh, { resizeWidth, resizeHeight, resizeQuality: "high" })`.
- Frames are never upscaled.
- If the tile grows more than 25% (window resize, column setting), it re-decodes after a 300 ms debounce. Shrinking keeps the existing frames.
- If cropping or resizing throws on the first frame, it falls back to full-size frames.

**Result:**
- Memory per frame for that Tenor GIF in a 200 px tile: 558 KB → 160 KB (3.5×).
- Bigger GIFs save far more, e.g. 800×800 → 16× less.
- Tested in headless Chromium 153 with a real animated GIF: average pixel difference 0.01/255 compared to the full-size render, and the cropped-away edges match `object-fit: cover`.

### Fewer base64 conversions

- **`native.ts` `downloadMedia`** returns `{ bytes: Uint8Array, mimeType }` instead of base64. Electron IPC copies typed arrays directly, which avoids 33% extra size plus an encode and a decode. `downloadBytes()` still accepts the old `{ base64 }` shape.
- **`base64ToBytes` / `bytesToBase64`** use the browser's built-in `Uint8Array.fromBase64` / `.toBase64()` when available, which is much faster than a per-character JS loop. The old loops are kept as a fallback.
- **Shared Blob cache** (an LRU, `blobCache`, capped at `BLOB_CACHE_MAX_BYTES` = 150 MB, keyed like `mediaCache`) so a file is decoded or loaded once instead of on every tile mount, restart or send. In 2c this became the in-memory layer in front of `requestBlob`.

## 2c. Storage update: cache no longer held in memory (3 Nov 2026)

### What changed

**Before:** every cached file was a base64 `data:` URL string in its own DataStore record (`GifFolders_media_cache_entry_v1:<hash>`), and `loadCache()` read *all* of them into `mediaCache` at startup. That kept ~1.33× the cache size in the renderer's JS heap for the whole session (e.g. an 872 MB cache ≈ 1.16 GB of strings), even if GIF Folders was never opened.

**Now:** each cached file has two records:

| Record | Key | Contents | When it's read |
|---|---|---|---|
| Info | `GifFolders_media_meta_v1:<hash>` | `{ cachedAt, size, mimeType, loopsForever? }` | At startup (tiny) |
| File | `GifFolders_media_data_v1:<hash>` | The file as a `Blob` (an `ArrayBuffer` if this Chromium can't store Blobs in IndexedDB) | Only when needed |

- `mediaCache` holds only the info records.
- A Blob read back from IndexedDB is a handle to data the browser keeps on disk, so holding one costs next to no memory until it's decoded.
- **Measured** in headless Chromium with a 180 MB cache: the old startup put 240 MB into the JS heap, the new one about 0 MB (4 MB after conversion and a restart).

### Loading files

- `requestBlob(mediaSrc)` → `Promise<Blob | null>`:
  - Checks the in-memory LRU (`blobCache`, 150 MB), then reads the file record.
  - Converts an old-format entry first if needed.
  - Requests for the same file are de-duplicated.
- If the stored copy is **missing**, the entry is dropped (records deleted) so the tile falls back to the live link and re-caches.
- If **reading fails**, the entry is only dropped from memory; nothing on disk is deleted.
- `peekLoadedBlob(mediaSrc)` is a synchronous LRU lookup that never starts a load.
- `isCachedSrc` / `isCachedId` treat old-format entries that haven't been converted yet as cached, so nothing gets re-downloaded during conversion.

### Writing files

`writeCacheEntry(key, meta, blob)` writes the file and the info record in one `setMany` transaction, file first. If the file can't be stored, no info record is left behind. It then reads the file back (checks size, and reads 16 bytes) and returns the stored, disk-backed Blob.
- `DataCloneError` → switches to ArrayBuffer storage (`storeFilesAsBuffers`) and retries.
- `cacheGif` swaps its in-memory Blob for the stored one, so freshly downloaded files stop occupying memory.

### Tiles (`GifTile`)

- A tile only asks for its file while it's visible, holds it in `heldBlob`, and releases it when scrolled away.
- While the file loads (usually a few ms) the tile shows the placeholder, not the live link.
- `AnimatedCanvasImage` takes the `blob` directly.
- `getPlayableSrc(mediaSrc, blob, tick)` mints blob: URLs for `<img>` / `<video>`.

### Other code paths

- **Sending** (`sendAsFreshAttachment`) and **export to disk** use `requestBlob`.
- **Export to disk** sends raw bytes to `native.ts`, which still accepts the old `base64` field.
- **Folder JSON export** (`serializeFolder`, now async) builds the file as a Blob one entry at a time, so it no longer needs one giant string. The format is the same, just not pretty-printed.
- **Import** stores embedded files through `writeCacheEntry`. It respects the 20 MB per-file limit and the cache budget, and records the size in bytes (this fixes old item D).

### One-time conversion (`runLegacyMigration`)

Runs in the background from `start()`, one file at a time.

- **Per file** (`convertLegacyEntry`): read the old record → decode the data URL → work out `loopsForever` if it was missing → `writeCacheEntry` (verified) → **only then** delete the old record.
- **Unreadable old records** are left untouched.
- **Interrupted** (Discord closed, plugin disabled via `migrationRun`): the next start continues. Startup deletes old records whose new copy already exists, and cleans up half-written new records.
- **A failed write** (e.g. disk/quota) sets `migrationBroken`. Conversion stops for the session, nothing is deleted, and remaining files are served straight from their old records (`legacy: true`, in memory only). It retries next start.
- **Tiles can convert on demand:** a tile can request an unconverted file, and it's converted on the spot. A limiter (3 at a time) bounds memory.
- **The oldest single-record format** (`MEDIA_CACHE_KEY`) is converted too, and deleted only if every file in it made it.
- **Progress:** a toast at start and end when there are 20 or more files. The cache size label shows "converting…" while it runs.
- `migrateLoopDetection` was removed; loop detection now happens during conversion, caching and import.
- **Measured:** 180 MB converted in 1.3 s in headless Chromium.

### Tests run

51 automated checks, run against real IndexedDB in headless Chromium 153, using the plugin's actual code extracted from `index.tsx`. All passed. Covered:
- conversion of each file type with byte-for-byte comparison, loop info kept or detected, unreadable entries left alone, other plugins' data untouched;
- interrupted conversion resuming, both formats present, on-demand conversion;
- write failure (nothing deleted, files still load), no-Blob-support fallback, damaged/half-written records, missing files;
- new downloads moving to disk, budget eviction, folder export/import round trip, Clear Cache removing every format;
- the oldest single-record format.

**Not tested:** inside Discord itself.

### Rolling back

An older plugin version only knows the old format. After conversion it would see an empty cache and re-download previews from their links; folders aren't affected. Files whose links have died would need an export/import to come back.

## 2d. Small update (3 Nov 2026)

- **Ctrl/Shift + mouse wheel scrolls the grid.** Before, holding Ctrl (e.g. for instant send) or Shift blocked scrolling: Discord uses Ctrl+wheel for zoom, and Chromium turns Shift+wheel into sideways scrolling.
  - `ManagerModal` adds a window `wheel` listener (capture, non-passive). When Ctrl or Shift is held over `.vc-gif-folders-grid`, it cancels the event and scrolls the grid vertically itself.
  - It uses whichever axis moved and handles line/page `deltaMode`.
  - Outside the grid nothing changes.
  - Tested in Chromium 153 with real key presses.
- **Lowering the cache size limit applies right away** (`applyCacheBudget`, from the cog menu and the setting's `onChange`), instead of only at the next download.
- **Canvas-played tiles no longer create a blob: URL** they never use. Each URL keeps its file alive until revoked.

## 2e. Smaller copies, stronger cache keys, crash logging removed (3 Nov 2026)

### "Make Smaller Copy" (tile right-click menu)

**How it works**
- The submenu offers about half, a quarter, or a tenth of the current size, each showing the size it aims for.
- `makeSmallerCopy` loads the file (`requestBlob`, or `cacheGif` first) and calls `createSmallerFile`. The result is added to the same folder, right after the original, named `<name> (<size>)`.
- One compression runs at a time (`compressionRunning`), with toasts at the start and end.

**`createSmallerFile(blob, mimeType, targetBytes)`**
- **Animated images and any GIF → GIF.** The first attempt uses `scale = √(target/size)`. Each further attempt rescales by `√(target/result)`. Below ~50% scale it drops every other frame (with each kept frame lasting twice as long, so speed is unchanged) instead of shrinking further. At most 5 attempts; the smallest result is kept if the target can't be reached.
- **Still non-GIF images → WebP** (`convertToBlob`), starting at full size with quality 0.9, then shrinking.
- **Videos:** see the update below (they're supported now).
- The loop count of the original is preserved: forever, N times, or play once.

**`encodeGif`: the plugin's own GIF encoder, since browsers can't encode GIFs**
- **Frames** come from WebCodecs `ImageDecoder` (already composited) and are scaled with `createImageBitmap(resize, "high")`.
- **Palette:** median cut over a 15-bit histogram of up to 16 sampled frames, giving 255 colors. Each color is the average of the real pixels in its box. Index 255 is transparent. No dithering.
- **Opaque animations:** each frame stores only the rectangle that changed, with unchanged pixels transparent (disposal 1), like most GIF optimizers.
- **Animations with see-through pixels:** whole frames with disposal 2.
- **LZW** (`writeLzw`): 8-bit minimum code size, generation-stamped dictionary, clear code at 4096. The code-width switch timing matches the decoder's one-code lag (see the comments).
- **Responsiveness:** it yields to Discord between frames.

**Tested** in Chromium 153 on generated GIFs. The output was decoded by both Chromium's `ImageDecoder` and Python Pillow:

| Input | Target | Result | Time |
|---|---|---|---|
| 13 MB, 640×360, 80 frames | ½ | 5.9 MB (400×225, all frames) | ~1.0 s |
| 13 MB, 640×360, 80 frames | ¼ | 2.8 MB (390×219, 40 frames) | ~0.7 s |
| 13 MB, 640×360, 80 frames | 1/10 | 1.0 MB (228×128, 40 frames) | ~0.4 s |

- Average color difference from the original was 7–10/255, which is GIF palette quantization.
- Transparency was exact, loop counts were kept, and frame timing was kept.

**Smaller copies are plugin-made files:**
- `mediaSrc`/`shareSrc` is `gif-folders-local://<id>/<name>.<ext>` (`isLocalSrc`).
- The file is stored with `pinned: true`. Pinned files don't count toward the cache budget, are never evicted, and are kept by Clear Cache.
- `cacheGif` never tries to download them.
- **Sending** always uploads the file (`sendAsFreshAttachment`), with a toast if that fails.
- "Insert into Chat Box" and "Copy Link" are hidden for them, since they have no link.
- **The file is deleted** once no folder contains the entry (`forgetLocalFilesIfUnused`, called from `removeGifFromFolder` and `deleteFolder`).
- **JSON folder export** embeds the file, and **import** re-pins it.

### Update: slider dialog, big files, videos (3 Nov 2026)

**Dialog.** The right-click item "Make Smaller Copy…" now opens `CompressModal`: a 10–90% slider (target = that share of the original size), a blue "Compress GIF" / "Compress Video" button, and live progress text. It closes with a toast on success and shows the reason on failure. This replaces the three fixed presets.

**Big files.**
- **The bug:** files over 20 MB couldn't be compressed. `cacheGif` and `native.ts` both refuse files over the 20 MB cache limit, so `loadForCompression` got nothing ("Couldn't load this GIF…").
- **The fix:** it now does a one-off download of up to 200 MB just for compressing (`downloadBytes(url, maxBytes)` → native `downloadMedia(url, maxBytes)`, capped at `MAX_BYTES_FOR_COMPRESSION`). It retries once with a refreshed signed URL for Discord links. These downloads are never cached.
- **Tested** on the user's real 26 MB GIF (720×720, 137 frames): 70% → 14.7 MB in 3.0 s, 50% → 10.2 MB, 25% → 4.8 MB, 10% → 1.7 MB in 1.3 s. All frames, the loop count and the exact frame timing (4.56 s) were kept. Output was verified with Pillow and ffprobe.

**Videos** (`createSmallerVideo`, MP4/MOV/WebM, anything Discord's Chromium can play).
- **How it works:** the video plays in a hidden `<video>`. Frames are drawn to a canvas at a resolution suited to the bitrate (about 0.08 bits/pixel/frame), and the sound is routed through Web Audio into the recording only, never the speakers. A `MediaRecorder` (VP9, or VP8, + Opus WebM) records at a bitrate worked out from the target size and duration.
- **Real time:** browsers only encode video in real time, so it **takes as long as the video**. Discord must stay open and visible, since a minimized window can stall frame capture.
- **Duration fix:** `addWebmDuration` writes the missing Duration element into the WebM Segment Info. Browser-recorded WebM has no duration, which breaks seeking.
- **Output:** a `.webm` smaller copy that plays as a `<video>` tile and is uploaded when sent.
- **Tested** with 8 s 1280×720 VP9/Opus MP4 and WebM inputs at a 30% target: 2.6 MB → 0.36 MB, duration 8.02 s, VP9+Opus according to ffprobe. VP8/VP9 tends to land under the target on simple content.
- **Not tested here:** H.264 MP4/MOV decoding. Headless test Chromium has no H.264, but Discord's Electron plays H.264 natively.

### Update: "Best quality (slower)" mode (3 Nov 2026)

`CompressModal` has a **Quality** choice: **Fast** (everything above, unchanged) or **Best quality (slower)**. The choice is remembered for the session (`lastCompressMode`). It's passed as `mode` through `makeSmallerCopy` → `createSmallerFile(blob, mime, target, onProgress, mode)`.

**Why fast mode looks blurry.** Fast mode only shrinks the picture. On cartoon-style GIFs with sharp outlines, *any* downscale is expensive: on the user's 26 MB GIF, 720 → 509 px costs about 20 dB PSNR against the original, while the lossy settings below cost a few dB for the same size saving. Best mode therefore keeps full size whenever it can.

**GIF encoder additions** (both modes share `encodeGif` / `writeLzw`; fast mode passes no options):
- **Lossy LZW** (`LzwLossy`, `writeLzw`'s `substitute`). When the next pixel would end the current dictionary string, try another palette index that continues it, if that color is within `lossy` (per channel) of the pixel's **real** color. Candidates come from `paletteNeighbors` (up to 24 nearest colors per index). It never touches see-through pixels. This is the idea behind gifsicle's `--lossy`.
- **Invisible swaps (all modes).** In delta frames, "transparent = keep" and "draw the color already on screen" look identical, so LZW may pick either. This makes slightly smaller files at no quality cost. `shown` tracks what's on screen after each frame (it replaced `previous`).
- **Unchanged threshold.** A pixel within `threshold` of what's already on screen is left as "keep". The error is measured against the real pixel each frame, so it can't build up.
- **`fineColors`**: 18-bit color→palette lookup instead of 15-bit (slightly better).
- **`abortAbove`**: stops once the file is bigger than the target. It returns `{ blob: null, size: projected }`, so too-big tries are cheap. `encodeGif` now returns `{ blob, size }`.
- Tested and rejected: sampling 48 frames for the palette made smaller files but lower quality.

**Best-mode search (`smallerGifBest`).** One strength knob `q` sets lossy = q and threshold = 0.6 q.
1. At full size, `gentlestFit` finds the smallest `q` that fits (log-size interpolation, ≤ 5 encodes).
2. Fast mode's approach (q = 0, smaller picture, `largestFit`) is always a candidate too, so best never scores worse than fast. If step 1 needed q > 24 or nothing fit, a gentler q at a smaller size is tried as well.
3. Every candidate is scored by PSNR against original frames at the original size (`imageError`, `scoringSize` caps it at about 0.6 MP; 4 sample frames), so blur from shrinking counts. The highest score wins.
4. Frame dropping is a last resort (best scale < 0.4).
5. At most 16 encodes. A log line in the console lists every candidate and its score.

**Stills (`smallerStillBest`).** Binary search for the highest WebP quality that fits at full size, then at 0.8× steps (up to 5 sizes), stopping once quality ≥ 0.85. The best PSNR wins.

**Videos (`createSmallerVideoBest` → `videoBestAttempt`).**
- **Video:** WebCodecs `VideoEncoder` (VP9 `vp09.00.41.08`/`51.08`, else VP8; `latencyMode: "quality"`, VBR). Frames come from a muted `<video>` via `requestVideoFrameCallback`, are drawn to an OffscreenCanvas, and become a `VideoFrame`. The first and last frames are captured by hand. Playback pauses whenever `encodeQueueSize > 4`, so no frame is skipped. A keyframe goes in every 2 s.
- **Sound:** decoded once (`OfflineAudioContext` at 48 kHz) and encoded with `AudioEncoder` Opus (`encodeOpusTrack`). It takes about 10% of the budget (32–128 kbps). OpusHead comes from the encoder, or is built by hand with pre-skip 312.
- **`muxWebm`:** a minimal Matroska writer. EBML header, Segment (known size), SeekHead, Info with Duration, Tracks (CodecDelay/SeekPreRoll for Opus), one Cluster per video keyframe, Cues.
- **Passes:** up to 3 (2 for videos over 90 s). Each re-encode corrects the bitrate from the measured size, aiming for 90–100% of the target. It stops as soon as a pass lands in that window, so **finishing after 1 pass is normal**. The progress text says why each extra pass runs, and the final toast says how many passes it took (`detail` on the result). Resolution uses about 0.05 bits/pixel/frame.
- **Falls back to fast mode** if WebCodecs is missing, the codec is unsupported, the video is longer than 20 min, or the sound couldn't be decoded but the video has sound (`webkitAudioDecodedByteCount`).

**Measured** (headless Chromium; PSNR vs the original at the original size; ffmpeg for video, in RGB because the files tag different color ranges):

| Input | Target | Fast | Best |
|---|---|---|---|
| User's 26 MB cartoon GIF, 720×720, 137 frames | 70% | 15.0 MB, 602 px, 30.7 dB, 4 s | 18.5 MB, **720 px**, 38.9 dB, 30 s |
| same | 50% | 10.4 MB, 509 px, 29.9 dB, 3 s | 12.1 MB, **720 px**, 33.9 dB, 16 s |
| same | 25% | 4.9 MB, 360 px, 29.6 dB, 2 s | 6.3 MB, **720 px**, 30.0 dB, 19 s (visibly sharper) |
| same | 10% | 1.8 MB, 228 px, 27.1 dB, 1.5 s | 2.1 MB, 476 px, 29.0 dB, 20 s |
| 9 s 720×720 cartoon WebM (VP9+Opus) | 30% | 1.6 MB, 35.1 dB, 9 s | 2.6 MB, 36.0 dB, 18 s (2 passes) |
| 8 s 1280×720 VP9 MP4 | 30% | 0.36 MB, 694×390, **dropped half the frames** | 0.73 MB, 908×510, all frames, 16 s |

- Best-mode WebM had 0 ffmpeg decode errors, versus 13 for MediaRecorder output. Sound, duration and seeking were all fine.
- Transparency and loop counts were kept. The storage tests (68/68) and fast-mode compression results were unchanged.

### Stronger cache keys (fixes item I)

- `hashUrl` is now djb2 + FNV-1a (~64 bits, e.g. `1xcnxot_153sn5z`). The old 32-bit djb2 is kept as `oldHashUrl`, only for conversion.
- Records moved to v2 prefixes (`GifFolders_media_meta_v2:` / `GifFolders_media_data_v2:`), and the info record now stores `src`, the media URL.
- **Old records can't be turned back into URLs**, so `loadCache` maps them through your folders: `oldHashUrl(entry.mediaSrc)` for every saved GIF. This covers all three older formats: data-URL records, v1 Blob records, and the single-record `MEDIA_CACHE_KEY`.
  - **Exactly one saved GIF uses the old key:** queued in `pendingLegacy` (`Map<newKey, LegacySource>`) and converted by `convertLegacyEntry` (read → write v2 → verify → delete old).
  - **No saved GIF uses it** (removed GIF or changed link), **or two do** (a real collision, so it's impossible to tell whose file it is): the old record is deleted. It's only a cached copy, and those GIFs are cached again. This only happens if the folders themselves loaded fine (`foldersLoadedOk`).
- `clearMediaCache` deletes every `GifFolders_media_*` record in any format except pinned files.
- **Tested:** 68 automated checks in Chromium, including a real old-key collision found by brute force (both GIFs end up with their own file), v1 conversion, and pinned files surviving budget eviction, Clear Cache and restarts.

### Crash logging removed

The process-wide `uncaughtException` / `unhandledRejection` handlers are gone from `native.ts` (fixes item C). The removed code, what it did, and where its log file is are in **CRASH_LOGGING_REMOVED.md**. The log file itself (`%APPDATA%\discord\gif-folders-crash.log`) wasn't deleted.

---

## 3. Known problems NOT fixed yet (in priority order)

### A. ~~The whole media cache is held in memory as base64 strings~~ (fixed 3 Nov 2026, see 2c)

This was the main remaining risk behind the README's old "rare crash when saving". The cache no longer lives in memory.

### B. "MP4 sometimes gets sent with a blue link above it"

- **How sending works:** for files whose `shareSrc` is a Discord attachment, `insert()` first tries `sendAsFreshAttachment()`, which re-uploads the cached bytes as a new attachment. If that fails for any reason, it falls back to `sendAsLink()`, which posts the raw `cdn.discordapp.com` link. That is the blue link text.
- **Likely reasons the re-upload fails:**
  - The file is bigger than the upload limit. Discord raised the free limit from 10 MB to 20 MB in August 2026, so files of 10–20 MB failed before that. Files right at the plugin's 20 MB cap can still fail.
  - The cached copy was evicted and the original signed link has expired, so `cacheGif` couldn't re-download it.
  - A network or API error.
- **Suggested fix:**
  - Log *why* it failed (the HTTP status from `RestAPI.post`).
  - Call `refreshAttachmentUrl()` and retry the download before giving up.
  - Show a toast when it falls back to a link.
  - Optionally skip the re-upload when the file is known to be over the user's limit.

### C. ~~`native.ts` installs process-wide crash handlers~~ (removed 3 Nov 2026, see 2e and CRASH_LOGGING_REMOVED.md)

### D. ~~Import ignores the cache limits~~ (fixed 3 Nov 2026, see 2c)

### I. ~~Cache keys are a 32-bit hash~~ (fixed 3 Nov 2026, see 2e)

### E. Comments point to files that aren't in the repo

Many comments say "see INVESTIGATION.md Part N" or "see the chat investigation". Neither is in the repo, so another developer or AI can't follow them. Either add `INVESTIGATION.md` to the repo, or shorten those comments to the actual reason.

### F. One 4,650-line file

Everything is in `index.tsx`. Vencord plugin folders can contain any number of files. A natural split:

- `storage.ts` – DataStore keys, load, persist, migrations
- `mediaCache.ts` – cacheGif, eviction, blob URLs, loop detection
- `urls.ts` – URL detection and resolution, attachment refresh
- `send.ts` – insert / sendAsFreshAttachment / sendAsLink / replies
- `exportImport.ts`
- `components/` – ManagerModal, GifTile, prompts, settings menu, icons
- `sizing.ts` – the dialog and grid sizing code

### G. Old CSS variable names

`styles.css` and some inline styles use `--background-secondary`, `--background-secondary-alt`, `--interactive-normal`, `--button-danger-background` and `--scrollbar-thin-*`. Current Vencord's own code no longer uses any of these. They still render today, but if colours or backgrounds disappear after a Discord update, start here. Vencord's newer code uses names like `--text-default`, `--text-muted`, `--text-feedback-critical`, `--background-base-lower` and `--background-mod-subtle`.

### H. Optional modernization

Vencord now supports a `chatBarButton: { icon, render }` property on `definePlugin`, in place of calling `addChatBarButton` / `removeChatBarButton` in `start` / `stop`. Both work today.

---

## 4. How the plugin works (map for a new developer)

**Data model**
- `cache: FolderMap`: folder name → `GifEntry[]`, stored under `GifFolders_data_v3`.
  - `shareSrc` is the link that gets sent (a Tenor page, or a Discord attachment).
  - `mediaSrc` is the playable asset, used for preview and cache only.
- `mediaCache`: `hashUrl(mediaSrc)` → `{ cachedAt, size, mimeType, loopsForever, src, pinned? }` (info only). The file itself is a Blob in `GifFolders_media_data_v2:<key>`, loaded with `requestBlob`. Older formats are converted in the background; see 2c and 2e.

**Saving**
- Context-menu patches for `message`, `image-context` and `video-context` call `isAnyGifLike`, then `resolveShareUrl` / `resolveMediaUrl`, then `buildGifMenuGroup` (the "Save GIF to…" items).

**Caching**
- `cacheGif(url)` first tries the native `downloadMedia`, which avoids the renderer's CSP. It then falls back to `fetch`, and finally to just showing the live link.
- After 5 consecutive network failures, a circuit breaker stops caching for the rest of the session.
- Eviction is LRU, based on `cachedAt`. `touchMediaCacheEntry` refreshes it on each cache hit.

**Non-looping GIFs and WebPs**
- `getGifLoopCount` / `getWebpLoopCount` read the loop count from the file.
- For cached GIF/WebP tiles, the canvas player loops by itself.
- Uncached tiles (`<img>` fallback) whose file doesn't loop forever are restarted every 4 s (`RESTART_INTERVAL_MS`) by changing a `tick`, which creates a new URL.

**Sending**
- Everything goes through `insert()` in `ManagerModal`.
- Replies: `PendingReplyModule.getPendingReply`, then `message_reference`, then `DELETE_PENDING_REPLY`.
- Discord attachments are re-uploaded with `sendAsFreshAttachment`. Everything else is sent as a link with `sendMessage`.
- Ctrl-click (configurable) sends without closing the window.

**Expired Discord links**
- `refreshAttachmentUrl` batches calls to `POST /attachments/refresh-urls`.

**Export and import**
- JSON export/import, with an optional embedded cache.
- "Export to disk" uses native `pickExportFolder` plus `exportGifFileBatch`, writing in small batches.

**Window sizing**
- `findModalDialogElement`, `settleGridHeight`, `tightenModalChrome` and friends are DOM-measurement code that depends on Discord's modal markup. Discord UI updates are most likely to break this part.

## 5. Install and test

1. Copy the `gifFolders` folder (`index.tsx`, `native.ts`, `styles.css`) into `Vencord/src/userplugins/gifFolders`. If the folder name starts with `_`, Vencord skips it.
2. Run `pnpm build`, then `pnpm inject` (with Discord fully closed), then start Discord.
3. Quick smoke test:
   - Open the manager from the chat bar.
   - Create, rename and delete a folder.
   - Right-click a GIF in chat → Save GIF to → folder.
   - Send one by clicking it, and several in a row with Ctrl-click.
   - Rename a GIF and search for it.
   - Export to JSON and import it again.
   - Use Clear Cache.
   - Trigger an error toast, e.g. by importing a non-JSON file.
4. The changes in this update weren't run inside Discord before release. The build-level fixes were checked against Vencord 1.15.15's source: every import now resolves.

## 6. Rules of thumb for future changes

- Vencord's `@webpack/common` keeps losing old Discord components. For UI, prefer Vencord's own `@components/*` (`Button`, `Heading`, `Paragraph`, `Text`, `Divider`, `Card`, …).
- Toasts: `showToast({ text, variant })`.
- Anything in `native.ts` runs in Discord's main process. An uncaught throw there can take down all of Discord, so every callback must catch its own errors.
- Keep large binary data out of JS strings and out of memory: files belong in Blob records, loaded on demand with `requestBlob` (see 2c).
