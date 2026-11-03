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
4. **GIFs that don't loop forever re-decoded their whole file every 4 seconds.** `getPlayableSrc` ran `atob` and copied the bytes into a new Blob on every restart tick (up to 20 MB per tile, per visible tile). The Blob is now kept next to its object URL, and a restart only creates a new URL for the same bytes.
5. **Disabling the plugin kept the media cache in memory** until Discord restarted. `stop()` now releases the blob URLs and drops the in-memory cache. Nothing is deleted from storage, and `start()` loads it again.

---

## 3. Known problems NOT fixed yet (in priority order)

### A. The whole media cache is held in memory as base64 strings (remaining crash risk)

The README mentions a rare crash when saving a GIF. As of November 2026 that crash hasn't been seen for months, so earlier changes probably fixed it: per-entry cache storage, the cache budget, guarded `native.ts` callbacks, and batched export. What's described below is the main *remaining* risk for a similar crash, not a confirmed active bug.

- **What happens:** `loadCache()` loads *every* cached file at startup with `DataStore.getMany`. Each file is kept in `mediaCache` as a `data:` URL string.
  - The default budget is **2 GB**, and there is also an "Unlimited" option.
  - Base64 is about 1.33× the file size, and it all lives in the renderer's JS heap.
  - Showing a tile then makes another copy as a Blob.
- **Why saving triggers it:** saving a large file adds a 20 MB download, a base64 conversion and a string concatenation on top of that. At that moment the renderer can run out of memory, which looks like Discord crashing.
- **The setting description is wrong:** it says a bigger cache costs "startup time and memory, not stability", but past a point memory *is* stability.
- **Suggested fix** (a larger refactor):
  - Store `Blob`s in IndexedDB instead of data-URL strings. `@api/DataStore` is idb-keyval, which stores Blobs natively.
  - Only keep the **keys** and sizes in memory at startup.
  - Load a file's Blob when its tile becomes visible.
  - Keep a small in-memory LRU (e.g. 100–200 MB).
  - Migration: read each old data-URL entry once, convert it to a Blob, write it back, and drop the string.
- **Quick mitigation** if the refactor is too big: lower the default `maxCacheSize` to 500 MB and reword the description.

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

### C. `native.ts` installs process-wide crash handlers

`process.on("uncaughtException")` and `process.on("unhandledRejection")` were added as temporary instrumentation. They write to `%appdata%\discord\gif-folders-crash.log`. Registering them also **disables Node's default "crash on uncaught exception" for all of Discord's main process**, not just this plugin. Errors from anything in the main process get swallowed into the log, and Discord keeps running in an unknown state.
- If the log has caught nothing useful, remove these handlers.
- Otherwise narrow them, e.g. only log errors whose stack mentions this plugin.
- Note: a renderer out-of-memory crash (see A) never reaches these handlers at all.

### D. Import ignores the cache limits

`importFromJson` adds every `dataUrl` in the file to `mediaCache` without:
- checking the 20 MB per-file cap,
- running eviction against the total budget,
- recording `size` in bytes. It stores `dataUrl.length`, which is characters, about 1.33× bytes.

A big import can push the cache far past the budget, which makes A worse.

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
- `mediaCache`: `hashUrl(mediaSrc)` → `{ dataUrl, cachedAt, size, loopsForever }`. There is one DataStore key per entry, prefixed `GifFolders_media_cache_entry_v1:`. Older single-blob formats are migrated in `loadCache()`.

**Saving**
- Context-menu patches for `message`, `image-context` and `video-context` call `isAnyGifLike`, then `resolveShareUrl` / `resolveMediaUrl`, then `buildGifMenuGroup` (the "Save GIF to…" items).

**Caching**
- `cacheGif(url)` first tries the native `downloadMedia`, which avoids the renderer's CSP. It then falls back to `fetch`, and finally to just showing the live link.
- After 5 consecutive network failures, a circuit breaker stops caching for the rest of the session.
- Eviction is LRU, based on `cachedAt`. `touchMediaCacheEntry` refreshes it on each cache hit.

**Non-looping GIFs and WebPs**
- `getGifLoopCount` / `getWebpLoopCount` read the loop count from the file.
- Tiles whose file doesn't loop forever are restarted every 4 s (`RESTART_INTERVAL_MS`) by changing a `tick`, which creates a new blob URL.

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
- Keep large binary data out of JS strings (see A).
