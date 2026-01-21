# Storyblok Unused Components CLI

Find unused Storyblok components in a space using the Management API.

## Setup

1) Install dependencies:

```bash
npm install
```

2) Create a `.env` file:

```bash
STORYBLOK_OAUTH_TOKEN=your_oauth_token
STORYBLOK_SPACE_ID=your_space_id
```

## Build

```bash
npm run build
```

## Usage

Quick list wrapper (auto-builds if needed):

```bash
./find-unused --space-id 12345 --output txt
```

List unused components (stdout output):

```bash
node dist/index.js --list
```

Override space ID and write to a txt file:

```bash
node dist/index.js --list --space-id 12345 --output txt
```

Force stdout:

```bash
node dist/index.js --list --output stdout
```

Show help:

```bash
node dist/index.js --help
```

## Delete components

Deletion is opt-in and requires an input list of component names. Each name is rechecked for usage before deletion. If a component is still in use, the CLI prompts to skip, cancel, or force delete (interactive only).

From a file (newline-separated names):

```bash
node dist/index.js --delete --input-file ./components.txt
```

From a comma-separated list:

```bash
node dist/index.js --delete --components header,footer,hero
```

Dry run (no prompts, no deletions):

```bash
node dist/index.js --delete --input-file ./components.txt --dry-run
```

## Output

- `--output stdout` prints unused component names to stdout (one per line).
- `--output txt` writes `unused-components-<spaceId>.txt` in the current directory and overwrites any existing file with that name.

Progress messages and summary counts are printed to stderr so stdout stays clean.
