#!/usr/bin/env node
/**
 * Storyblok Assets Audit
 * Node >= 18 (fetch builtin)
 *
 * Env:
 *  STORYBLOK_OAUTH_TOKEN=...
 *  STORYBLOK_SPACE_ID=12345
 * Optional:
 *  STORYBLOK_REGION=eu   // default eu (use "us", "cn" if needed)
 *  MAX_SIZE_KB=300       // default 300
 *  INCLUDE_DRAFTS=true   // default true
 */

const {
    STORYBLOK_OAUTH_TOKEN,
    STORYBLOK_CDN_TOKEN,
    STORYBLOK_PREVIEW_TOKEN,
    STORYBLOK_DELIVERY_TOKEN,
    STORYBLOK_SPACE_ID,
    STORYBLOK_REGION = 'eu',
    MAX_SIZE_KB = '300',
    INCLUDE_DRAFTS = 'true',
    DEBUG = 'false',
    HUMAN_REPORT = 'false',
    HUMAN_REPORT_FILE = 'storyblok-assets-audit-report.txt',
    ASSET_TYPES = 'image,doc,video'
} = process.env;

const CDN_TOKEN = STORYBLOK_CDN_TOKEN || STORYBLOK_PREVIEW_TOKEN || STORYBLOK_DELIVERY_TOKEN;

if (!STORYBLOK_OAUTH_TOKEN || !STORYBLOK_SPACE_ID || !CDN_TOKEN) {
    console.error(
        'Missing env. Set STORYBLOK_OAUTH_TOKEN, STORYBLOK_SPACE_ID, and a CDN token (STORYBLOK_CDN_TOKEN or STORYBLOK_PREVIEW_TOKEN).'
    );
    process.exit(1);
}

const MAX_SIZE_BYTES = Number(MAX_SIZE_KB) * 1024;
const debugEnabled = DEBUG === 'true' || DEBUG === '1';
const debug = (...args) => {
    if (debugEnabled) console.log('[debug]', ...args);
};
const allowedTypes = new Set(
    ASSET_TYPES.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
);
const allowAllTypes = allowedTypes.size === 0 || allowedTypes.has('all');

// Storyblok Management API base URLs differ by region.
// For many setups, api.storyblok.com works fine; region-specific hosts exist.
const API_BASE =
    STORYBLOK_REGION === 'eu' ? 'https://api.storyblok.com/v1' : `https://${STORYBLOK_REGION}.api.storyblok.com/v1`;
// CDN (content) API uses a slightly different host pattern
const CDN_BASE =
    STORYBLOK_REGION === 'eu' ? 'https://api.storyblok.com/v2' : `https://api-${STORYBLOK_REGION}.storyblok.com/v2`;

const headers = {
    Authorization: STORYBLOK_OAUTH_TOKEN,
    'Content-Type': 'application/json'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(path, params = {}) {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    // simple retry (rate limits / transient)
    for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(url, { headers });
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
            const backoff = 400 * Math.pow(2, attempt);
            await sleep(backoff);
            continue;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}\n${body}`);
        }
        return res.json();
    }
    throw new Error(`GET ${url} failed after retries.`);
}

async function cdnGet(path, params = {}) {
    const url = new URL(CDN_BASE + path);
    url.searchParams.set('token', CDN_TOKEN);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    for (let attempt = 0; attempt < 4; attempt++) {
        const res = await fetch(url);
        if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
            const backoff = 400 * Math.pow(2, attempt);
            await sleep(backoff);
            continue;
        }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}\n${body}`);
        }
        return res.json();
    }
    throw new Error(`GET ${url} failed after retries.`);
}

async function fetchAllStories() {
    const per_page = 100;
    let page = 1;
    const stories = [];

    while (true) {
        const data = await cdnGet(`/cdn/stories`, {
            page,
            per_page,
            // CDN needs the version flag to include draft content
            version: INCLUDE_DRAFTS === 'true' ? 'draft' : 'published'
        });

        const batch = data?.stories ?? [];
        stories.push(...batch);
        debug(`Fetched stories page ${page}, batch size ${batch.length}, total so far ${stories.length}`);

        if (batch.length < per_page) break;
        page++;
    }

    return stories;
}

async function fetchAllAssets(spaceId) {
    const per_page = 100;
    let page = 1;
    const assets = [];

    while (true) {
        const data = await apiGet(`/spaces/${spaceId}/assets`, { page, per_page });
        const batch = data?.assets ?? [];
        assets.push(...batch);
        debug(`Fetched assets page ${page}, space ${spaceId}, batch size ${batch.length}, total so far ${assets.length}`);

        if (batch.length < per_page) break;
        page++;
    }

    return assets;
}

function isAssetObject(v) {
    return v && typeof v === 'object' && typeof v.filename === 'string' && v.filename.includes('a.storyblok.com');
}

function extractAssetIdFromUrl(url) {
    // common pattern: https://a.storyblok.com/f/{space}/{asset_id}/...
    // Not guaranteed; if it fails we still keep filename-based match.
    const m = String(url).match(/a\.storyblok\.com\/f\/\d+\/(\d+)\//);
    return m ? Number(m[1]) : null;
}

function extractSpaceIdFromUrl(url) {
    const m = String(url).match(/a\.storyblok\.com\/f\/(\d+)\//);
    return m ? Number(m[1]) : null;
}

function collectAssetsFromNode(node, out = []) {
    if (node == null) return out;

    if (Array.isArray(node)) {
        for (const item of node) collectAssetsFromNode(item, out);
        return out;
    }

    if (typeof node === 'object') {
        // direct asset object
        if (isAssetObject(node)) {
            const spaceId = extractSpaceIdFromUrl(node.filename);
            out.push({
                id: typeof node.id === 'number' ? node.id : extractAssetIdFromUrl(node.filename),
                filename: node.filename,
                spaceId
            });
        }

        for (const v of Object.values(node)) {
            if (typeof v === 'string' && v.includes('a.storyblok.com')) {
                out.push({
                    id: extractAssetIdFromUrl(v),
                    filename: v,
                    spaceId: extractSpaceIdFromUrl(v)
                });
            } else {
                collectAssetsFromNode(v, out);
            }
        }
    }

    return out;
}

function dedupeAssets(list) {
    const byKey = new Map();
    for (const a of list) {
        const key =
            a.id != null
                ? `space:${a.spaceId ?? 'unknown'}:id:${a.id}`
                : `space:${a.spaceId ?? 'unknown'}:fn:${a.filename}`;
        if (!byKey.has(key)) byKey.set(key, a);
    }
    return [...byKey.values()];
}

function humanBytes(bytes) {
    if (!Number.isFinite(bytes)) return 'n/a';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function pickMeta(asset) {
    const meta =
        asset.meta ??
        asset.meta_data ??
        asset.metaData ??
        asset.metadata ??
        (typeof asset.get === 'function' ? asset.get('meta') : undefined) ??
        {};
    // management asset objects typically include these; if your payload differs, adjust here
    // Storyblok assets often expose the raw bytes as content_length; use that as primary.
    const filenameDims = String(asset.filename ?? meta.filename ?? '').match(/\/(\d+)x(\d+)\//);
    return {
        id: asset.id ?? meta.id,
        filename: asset.filename ?? meta.filename,
        content_type: asset.content_type ?? meta.content_type ?? meta.mime_type ?? meta.mimeType,
        filesize: asset.content_length ?? asset.filesize ?? meta.filesize ?? meta.size ?? meta.file_size,
        width: meta.width ?? asset.width ?? (filenameDims ? Number(filenameDims[1]) : undefined),
        height: meta.height ?? asset.height ?? (filenameDims ? Number(filenameDims[2]) : undefined)
    };
}

function detectAssetKind(filename, contentType) {
    const ct = String(contentType || '').toLowerCase();
    if (ct.startsWith('image/')) return 'image';
    if (ct.startsWith('video/')) return 'video';
    if (
        ct === 'application/pdf' ||
        ct === 'application/msword' ||
        ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        ct === 'application/vnd.ms-excel' ||
        ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        ct === 'application/vnd.ms-powerpoint' ||
        ct === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
        return 'doc';

    const name = String(filename || '').toLowerCase();
    if (name.match(/\.(png|jpe?g|webp|gif|svg|avif|heic)$/)) return 'image';
    if (name.match(/\.(mp4|mov|m4v|webm|avi|mkv)$/)) return 'video';
    if (name.match(/\.(pdf|docx?|xlsx?|pptx?)$/)) return 'doc';
    return 'unknown';
}

async function main() {
    console.log(`Fetching stories…`);
    const stories = await fetchAllStories();
    console.log(`Stories: ${stories.length}`);
    debug(
        `Stories missing content: ${stories.filter((s) => !s?.content).length}/${stories.length}`,
        'sample keys:',
        Object.keys(stories[0] ?? {})
    );

    console.log(`Collecting referenced assets…`);
    const allRefs = [];
    // also keep which story referenced what (useful for “who embedded this 12MB PNG?”)
    const refsByAssetKey = new Map();

    for (const s of stories) {
        if (!s?.content) {
            debug(`Story ${s.id} (${s.full_slug ?? s.slug ?? '(no-slug)'}) has no content field.`);
        } else {
            debug(
                `Story ${s.id} (${s.full_slug ?? s.slug ?? '(no-slug)'}) content keys:`,
                Object.keys(s.content)
            );
        }

        const refs = collectAssetsFromNode(s?.content ?? {});
        debug(
            `Story ${s.id} (${s.full_slug ?? s.slug ?? '(no-slug)'}) referenced assets: ${refs.length}`,
            refs.slice(0, 5)
        );

        for (const r of refs) {
            const key =
                r.id != null
                    ? `space:${r.spaceId ?? 'unknown'}:id:${r.id}`
                    : `space:${r.spaceId ?? 'unknown'}:fn:${r.filename}`;
            allRefs.push(r);
            if (!refsByAssetKey.has(key)) refsByAssetKey.set(key, new Set());
            refsByAssetKey.get(key).add(`${s.full_slug ?? s.slug ?? '(no-slug)'} (${s.id})`);
        }
    }

    const used = dedupeAssets(allRefs);
    const usedFiltered = used.filter((u) => allowAllTypes || allowedTypes.has(detectAssetKind(u.filename)));
    debug('Unique referenced assets (sample up to 10):', usedFiltered.slice(0, 10));
    console.log(
        `Unique referenced assets (by id/url): ${usedFiltered.length}${usedFiltered.length !== used.length ? ` (filtered from ${used.length})` : ''}`
    );

    console.log(`Fetching assets metadata…`);
    const spaceIds = new Set(
        used.map((u) => u.spaceId).filter(Boolean).concat([Number(STORYBLOK_SPACE_ID)])
    );
    debug('Spaces referenced:', [...spaceIds]);

    const assetsBySpace = new Map();
    for (const spaceId of spaceIds) {
        const assets = await fetchAllAssets(spaceId);
        console.log(`Assets in space ${spaceId}: ${assets.length}`);

        const byId = new Map(assets.map((a) => [a.id, pickMeta(a)]));
        const byFilename = new Map(assets.map((a) => [a.filename, pickMeta(a)]));
        assetsBySpace.set(spaceId, { list: assets, byId, byFilename });

        debug(
            `Space ${spaceId} assets sample (first 5):`,
            assets.slice(0, 5).map((a, i) => ({
                i,
                keys: Object.keys(a ?? {}),
                meta: pickMeta(a),
                meta_data: a?.meta_data
            }))
        );
        debug(
            `Space ${spaceId} assets missing filesize: ${
                assets.filter((a) => {
                    const m = pickMeta(a);
                    return !Number.isFinite(m.filesize);
                }).length
            }/${assets.length}`
        );
    }

    const resolved = usedFiltered.map((u) => {
        const spaceId = u.spaceId ?? Number(STORYBLOK_SPACE_ID);
        const spaceAssets = assetsBySpace.get(spaceId);
        const meta =
            spaceAssets &&
            ((u.id != null && spaceAssets.byId.get(u.id)) || spaceAssets.byFilename.get(u.filename) || null);
        const kind = detectAssetKind(u.filename, meta?.content_type);

        return {
            ref_id: u.id ?? null,
            ref_filename: u.filename,
            space_id: spaceId,
            kind,
            meta
        };
    });
    const resolvedFiltered = resolved.filter((r) => allowAllTypes || allowedTypes.has(r.kind));

    const unresolved = resolvedFiltered.filter((r) => !r.meta);
    const resolvedOk = resolvedFiltered.filter((r) => r.meta);

    // Aggregate per space
    const spaceStats = new Map();
    const ensureSpace = (spaceId) => {
        if (!spaceStats.has(spaceId)) {
            spaceStats.set(spaceId, {
                resolved: 0,
                unresolved: 0,
                oversize: [],
                totalBytes: 0
            });
        }
        return spaceStats.get(spaceId);
    };

    const oversize = [];
    for (const r of resolvedOk) {
        const space = ensureSpace(r.space_id);
        space.resolved += 1;
        space.totalBytes += r.meta.filesize ?? 0;

        if (Number.isFinite(r.meta.filesize) && r.meta.filesize > MAX_SIZE_BYTES) {
            oversize.push(r);
            space.oversize.push(r);
        }
    }

    for (const r of unresolved) {
        const space = ensureSpace(r.space_id);
        space.unresolved += 1;
    }

    oversize.sort((a, b) => (b.meta?.filesize ?? 0) - (a.meta?.filesize ?? 0));

    // Summary
    const totalBytes = resolvedOk.reduce((sum, r) => sum + (r.meta.filesize ?? 0), 0);

    console.log('');
    console.log('=== SUMMARY ===');
    console.log(`Resolved:   ${resolvedOk.length}`);
    console.log(`Unresolved: ${unresolved.length}`);
    console.log(`Total size (resolved): ${humanBytes(totalBytes)}`);
    console.log(`Threshold: ${humanBytes(MAX_SIZE_BYTES)}`);
    console.log(`Oversize: ${oversize.length}`);

    if (unresolved.length) {
        console.log('');
        console.log('=== UNRESOLVED (first 20) ===');
        for (const r of unresolved.slice(0, 20)) {
            console.log(`- [space ${r.space_id}] ${r.ref_filename}`);
        }
        if (unresolved.length > 20) console.log(`… +${unresolved.length - 20} more`);
    }

    if (spaceStats.size > 1) {
        console.log('');
        console.log('=== PER SPACE ===');
        for (const [spaceId, stats] of spaceStats.entries()) {
            console.log(
                `Space ${spaceId}: resolved ${stats.resolved}, unresolved ${stats.unresolved}, oversize ${stats.oversize.length}, total ${humanBytes(stats.totalBytes)}`
            );
        }
    }

    console.log('');
    console.log('=== TOP OVERSIZE ASSETS (up to 30) ===');
    for (const r of oversize.slice(0, 30)) {
        const key =
            r.meta.id != null
                ? `space:${r.space_id ?? 'unknown'}:id:${r.meta.id}`
                : `space:${r.space_id ?? 'unknown'}:fn:${r.meta.filename}`;
        const storiesList = refsByAssetKey.get(key) ? [...refsByAssetKey.get(key)] : [];
        console.log(
            `- [space ${r.space_id}] ${humanBytes(r.meta.filesize)} | ${r.meta.content_type ?? 'unknown'} | ${r.meta.filename}`
        );
        // show up to 5 stories that reference it
        for (const s of storiesList.slice(0, 5)) {
            console.log(`    ↳ ${s}`);
        }
        if (storiesList.length > 5) console.log(`    ↳ … +${storiesList.length - 5} more`);
    }

    // Optional: output machine-readable JSON
    const jsonOut = {
        threshold_bytes: MAX_SIZE_BYTES,
        counts: {
            stories: stories.length,
            referenced_unique: resolvedFiltered.length,
            resolved: resolvedOk.length,
            unresolved: unresolved.length,
            oversize: oversize.length
        },
        spaces: Object.fromEntries(
            [...spaceStats.entries()].map(([spaceId, stats]) => [
                spaceId,
                {
                    resolved: stats.resolved,
                    unresolved: stats.unresolved,
                    oversize: stats.oversize.length,
                    total_bytes: stats.totalBytes,
                    oversize_assets: stats.oversize.map((r) => ({
                        ...r.meta,
                        referenced_in:
                            refsByAssetKey.get(
                                r.meta.id != null
                                    ? `space:${spaceId}:id:${r.meta.id}`
                                    : `space:${spaceId}:fn:${r.meta.filename}`
                            ) ?? []
                    }))
                }
            ])
        )
    };

    await BunWriteFallback('./storyblok-assets-audit.json', JSON.stringify(jsonOut, null, 2));
    if (HUMAN_REPORT === 'true' || HUMAN_REPORT === '1') {
        const lines = [];
        lines.push('Storyblok Oversized Assets Report');
        lines.push(`Threshold: ${humanBytes(MAX_SIZE_BYTES)}`);
        lines.push(`Generated: ${new Date().toISOString()}`);
        lines.push('');

        if (!oversize.length) {
            lines.push('No assets above threshold.');
        } else {
            const list = oversize.slice(0, 30);
            lines.push(`Top ${list.length} oversized assets:`);
            lines.push('');
            list.forEach((r, idx) => {
                const storiesList = refsByAssetKey.get(
                    r.meta.id != null
                        ? `space:${r.space_id ?? 'unknown'}:id:${r.meta.id}`
                        : `space:${r.space_id ?? 'unknown'}:fn:${r.meta.filename}`
                )
                    ? [...refsByAssetKey.get(
                          r.meta.id != null
                              ? `space:${r.space_id ?? 'unknown'}:id:${r.meta.id}`
                              : `space:${r.space_id ?? 'unknown'}:fn:${r.meta.filename}`
                      )]
                    : [];
                const refsShort =
                    storiesList.length === 0
                        ? 'No story reference found'
                        : storiesList.join(', ');
                lines.push(
                    `${idx + 1}. ${humanBytes(r.meta.filesize)} – ${r.meta.filename} (space ${r.space_id}, ${r.meta.content_type ?? 'unknown type'})`
                );
                lines.push(`    Used in: ${refsShort}`);
            });
        }

        await BunWriteFallback(HUMAN_REPORT_FILE, lines.join('\n'));
        console.log(`Human-readable report written to: ${HUMAN_REPORT_FILE}`);
    }
    console.log('');
    console.log('Wrote: storyblok-assets-audit.json');
}

// Node write helper (works without extra deps)
async function BunWriteFallback(path, content) {
    // no Bun assumed; use fs
    const fs = await import('node:fs/promises');
    await fs.writeFile(path, content, 'utf8');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
