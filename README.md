# CollaNote .cnote to PDF Converter

A local script for converting CollaNote `.cnote` files into PDFs. It also extracts the original package contents, embedded image attachments, thumbnails, and audio recordings into the local `cnote_exports/` folder.

## Requirements

- macOS, Windows, or Linux
- Node.js 22 or later
- Sharp (installed by the command below; required at startup on every platform)

Install dependencies in this repository's directory before running the script:

```sh
npm ci
```

Keep npm optional dependencies enabled so Sharp can install the native binaries
for your operating system and CPU. Run installation on each target machine;
do not copy `node_modules` between operating systems.

## Usage

Convert every `.cnote` file in this workspace:

```sh
node batch-convert-cnotes.mjs
```

Convert one `.cnote` file:

```sh
node batch-convert-cnotes.mjs "/path/to/Example.cnote"
```

Convert a folder of `.cnote` files recursively:

```sh
node batch-convert-cnotes.mjs "/Users/jc/collanote_backup"
```

The script creates `cnote_exports/` in the workspace directory if it does not already exist.

When a folder is passed, the script preserves that folder and subfolder structure under `cnote_exports/`. For example:

```text
/Users/jc/collanote_backup/2025_notes/folder1/Example.cnote
```

becomes:

```text
cnote_exports/collanote_backup/2025_notes/folder1/Example/
```

## Output

Each converted note gets its own folder:

```text
cnote_exports/
  Note Name/
    Note Name.pdf
    manifest.txt
    extracted/
      original package entries
    media/
      thumbnail.jpg
      audio-1.m4a
      attachments/
        page-00-attachment-1.png
```

`manifest.txt` records what was found and rendered. For stroke-based notes, it also includes per-page stroke counts, such as:

```text
Page 2: 500 rendered stroke(s) (0 DrawingKit, 500 legacy)
```

## Supported Content

- ZIP-style CollaNote `.cnote` packages, including large ZIP64 packages.
- Newer CollaNote page strokes stored in `_dkDrawing`.
- Older CollaNote legacy strokes stored in `drawing`, including multi-page notes that use document-global coordinates.
- Embedded image attachments.
- Embedded audio recordings, recovered as `.m4a` files.
- Embedded PDFs, copied out when present.
- JPEG image previews, assembled into a fallback PDF when no stroke pages are available.
- CollaNote lined paper backgrounds, including the `Gray Notelined L` spacing used by the sample notes.
- Highlighter strokes with translucent multiply blending.

## Notes

PNG attachments are converted sequentially before PDF rendering. Attachment order
is preserved, and transparent pixels are flattened onto white for the existing
JPEG-based PDF renderer; full alpha transparency is not preserved.

If a supported image cannot be converted, that note is marked failed in its
`manifest.txt` and no new PDF is written for it. The batch continues with later
notes and exits with status 1 if any note fails. Previously generated files are
not removed, so check the current manifest when retrying a failed note.
Unrecognized image formats are recovered as `.bin` files and recorded as skipped
in the manifest.

Generated note and PDF names avoid Windows reserved device names and trailing
dots. Original archive entry names are preserved during extraction, so an archive
containing names that are invalid on the target filesystem can still fail.

The stroke renderer was built by inspecting real CollaNote files. Because `.cnote` is proprietary, this converter is best-effort. If a note contains no page data, embedded PDF, or page image, the script still creates a folder and `manifest.txt` explaining what was found. Zero-byte `.cnote` files cannot be converted.

## Tests

```sh
npm test
```

The regression suite runs the CLI against synthetic notes with real Sharp image
conversion, including deliberately delayed PNGs, mixed image order across pages,
transparent PNGs, unsupported attachments, conversion failures, and write errors.
