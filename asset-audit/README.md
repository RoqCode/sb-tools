# Storyblok Asset Audit

Node.js script to find referenced Storyblok assets, pull their metadata via the Management API, and highlight oversize assets. Supports multiple spaces automatically (space ID is parsed from each asset URL).

## Requirements
- Node 18+
- Storyblok Management API token (`STORYBLOK_OAUTH_TOKEN`)
- Storyblok CDN token (`STORYBLOK_CDN_TOKEN` or `STORYBLOK_PREVIEW_TOKEN` / `STORYBLOK_DELIVERY_TOKEN`)
- Primary space ID (`STORYBLOK_SPACE_ID`)

## Usage
```bash
# Minimal run (uses drafts by default, 300 KB threshold)
STORYBLOK_OAUTH_TOKEN=... \
STORYBLOK_CDN_TOKEN=... \
STORYBLOK_SPACE_ID=12345 \
node storyblok-assets-audit.mjs

# With debug logs and a human-readable report
DEBUG=1 \
HUMAN_REPORT=1 \
HUMAN_REPORT_FILE=storyblok-assets-audit-report.txt \
MAX_SIZE_KB=500 \
INCLUDE_DRAFTS=true \
STORYBLOK_OAUTH_TOKEN=... \
STORYBLOK_CDN_TOKEN=... \
STORYBLOK_SPACE_ID=12345 \
node storyblok-assets-audit.mjs
```

## Env vars
- `STORYBLOK_OAUTH_TOKEN` (required): Management API token.
- `STORYBLOK_CDN_TOKEN` / `STORYBLOK_PREVIEW_TOKEN` / `STORYBLOK_DELIVERY_TOKEN` (required): CDN token for fetching story content.
- `STORYBLOK_SPACE_ID` (required): Primary space ID (assets from other spaces are fetched automatically when referenced).
- `STORYBLOK_REGION` (optional, default `eu`): Region host (`eu`, `us`, `cn`).
- `MAX_SIZE_KB` (optional, default `300`): Size threshold for oversize detection.
- `INCLUDE_DRAFTS` (optional, default `true`): Include draft content when fetching stories.
- `DEBUG` (optional): `1`/`true` to print debug logs.
- `HUMAN_REPORT` (optional): `1`/`true` to generate a client-friendly text report.
- `HUMAN_REPORT_FILE` (optional): Path for the human report (default `storyblok-assets-audit-report.txt`).
- `ASSET_TYPES` (optional, default `image,doc,video`): Comma-separated filter. Use `all` to include everything.

## Outputs
- `storyblok-assets-audit.json`: Machine-readable summary (counts, per-space stats, oversize assets with references).
- `storyblok-assets-audit-report.txt` (when `HUMAN_REPORT=1`): Top 30 oversize assets with sizes, content types, space ID, and all story references.

## Notes
- The script parses asset URLs to discover space IDs (segment after `/f/`) and fetches assets for each referenced space using the same Management token.
- Resolution uses asset `id` first, then filename. Filesizes prefer `content_length`, falling back to `filesize`/`meta`.
