import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../batch-convert-cnotes.mjs", import.meta.url));
const tracer = new URL("./support/trace-conversions.mjs", import.meta.url).href;

async function image(format, width, height, background = "red") {
  return sharp({ create: { width, height, channels: 4, background } })
    .toFormat(format).toBuffer();
}

function attachment(bytes) {
  return {
    type: "image", imageInData: bytes.toString("base64"),
    center: [0.5, 0.5], bound: [[0, 0], [0.5, 0.5]],
  };
}

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cnote regression "));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

function writeNote(cwd, name, attachments) {
  const file = path.join(cwd, `${name}.cnote`);
  fs.writeFileSync(file, JSON.stringify({ _dkDrawing: [], attachments }));
  return file;
}

// A small standards-compliant, uncompressed ZIP fixture; no ZIP dependency.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(bytes), 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    locals.push(header, filename, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    header.copy(central, 16, 14, 26);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

async function run(cwd, files = [], trace = false) {
  const tracePath = path.join(cwd, "trace.txt");
  const args = [...(trace ? ["--import", tracer] : []), script, ...files];
  const options = { cwd, env: { ...process.env, CNOTE_TEST_TRACE: tracePath }, timeout: 15000 };
  let result;
  try {
    result = { ...(await exec(process.execPath, args, options)), code: 0 };
  } catch (error) {
    result = { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
  result.events = fs.existsSync(tracePath) ? fs.readFileSync(tracePath, "utf8").trim().split("\n") : [];
  return result;
}

function pdfPath(cwd, name) {
  return path.join(cwd, "cnote_exports", name, `${name}.pdf`);
}

function embeddedImages(pdf) {
  const text = pdf.toString("latin1");
  const pattern = /\/Subtype \/Image \/Width (\d+) \/Height (\d+)[^\n]*?\/Length (\d+) >>\nstream\n/g;
  return [...text.matchAll(pattern)].map((match) => ({
    width: Number(match[1]), height: Number(match[2]),
    bytes: pdf.subarray(match.index + match[0].length, match.index + match[0].length + Number(match[3])),
  }));
}

test("all delayed PNGs finish before PDF/manifest, preserving mixed attachment order across pages", async (t) => {
  const cwd = fixture(t);
  const a = await image("png", 11, 13);
  const b = await image("jpeg", 17, 19, "blue");
  const c = await image("png", 23, 29, "green");
  const file = path.join(cwd, "mixed pages.cnote");
  fs.writeFileSync(file, zip([
    ["note.json", { name: "mixed pages", size: [100, 120] }],
    ["page0.cpage", { _dkDrawing: [], attachments: [attachment(a), attachment(b), attachment(c)] }],
    ["page1.cpage", { _dkDrawing: [], attachments: [attachment(c)] }],
  ]));
  const result = await run(cwd, [file], true);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.events, ["start:1", "done:1", "start:2", "done:2", "start:3", "done:3", "pdf", "manifest"]);
  const pdf = fs.readFileSync(pdfPath(cwd, "mixed pages"));
  const images = embeddedImages(pdf);
  assert.deepEqual(images.map(({ width, height }) => [width, height]), [[11, 13], [17, 19], [23, 29], [23, 29]]);
  assert.deepEqual(images[1].bytes, b, "JPEG must be embedded unchanged");
  assert.equal((pdf.toString("latin1").match(/\/Im\d+ Do/g) || []).length, 4);
  assert.match(pdf.toString("latin1"), /\/Type \/Pages \/Count 2/);
  assert.deepEqual(fs.readFileSync(path.join(cwd, "cnote_exports", "mixed pages", "media", "attachments", "page-00-attachment-1.png")), a);
});

test("empty, missing, non-image and unsupported attachments do not stop later valid images", async (t) => {
  const cwd = fixture(t);
  const jpeg = await image("jpeg", 7, 9);
  writeNote(cwd, "empty", []);
  writeNote(cwd, "missing", undefined);
  writeNote(cwd, "skipped", [null, { type: "text" }, { type: "image" }, attachment(Buffer.from("unknown")), attachment(jpeg)]);
  const result = await run(cwd);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Converted 3 .cnote file\(s\); 0 failed/);
  assert.equal(embeddedImages(fs.readFileSync(pdfPath(cwd, "empty"))).length, 0);
  assert.equal(embeddedImages(fs.readFileSync(pdfPath(cwd, "missing"))).length, 0);
  assert.equal(embeddedImages(fs.readFileSync(pdfPath(cwd, "skipped"))).length, 1);
  const base = path.join(cwd, "cnote_exports", "skipped");
  assert.ok(fs.existsSync(path.join(base, "media", "attachments", "page-page-attachment-5.jpg")));
  assert.match(fs.readFileSync(path.join(base, "manifest.txt"), "utf8"), /Skipped unsupported image attachment/);
});

test("transparent PNGs are flattened onto white for the existing RGB JPEG renderer", async (t) => {
  const cwd = fixture(t);
  const png = await image("png", 8, 8, { r: 0, g: 0, b: 0, alpha: 0 });
  const note = writeNote(cwd, "transparent", [attachment(png)]);
  assert.equal((await run(cwd, [note])).code, 0);
  const images = embeddedImages(fs.readFileSync(pdfPath(cwd, "transparent")));
  assert.equal(images.length, 1);
  const { data, info } = await sharp(images[0].bytes).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 3);
  assert.ok(data.every((value) => value >= 250), "transparent black pixels must become white, not black");
});

test("a corrupt PNG is handled before rendering, records a failure, and allows the next note", async (t) => {
  const cwd = fixture(t);
  const bad = writeNote(cwd, "bad-png", [attachment(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))]);
  const good = writeNote(cwd, "good", [attachment(await image("jpeg", 7, 9))]);
  const result = await run(cwd, [bad, good], true);
  assert.equal(result.code, 1);
  assert.deepEqual(result.events, ["start:1", "failed:1", "manifest", "pdf", "manifest"]);
  assert.ok(!fs.existsSync(pdfPath(cwd, "bad-png")));
  assert.ok(fs.existsSync(pdfPath(cwd, "good")));
  const manifest = fs.readFileSync(path.join(cwd, "cnote_exports", "bad-png", "manifest.txt"), "utf8");
  assert.match(manifest, /Conversion error: Could not convert PNG attachment/);
  assert.match(result.stdout, /Converted 1 .cnote file\(s\); 1 failed/);
});

test("a rejected JPEG conversion reaches the per-note catch without an unhandled rejection", async (t) => {
  const cwd = fixture(t);
  const bad = writeNote(cwd, "bad-jpeg", [attachment(Buffer.from([0xff, 0xd8, 0xff]))]);
  const good = writeNote(cwd, "good", []);
  const result = await run(cwd, [bad, good]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Converted 1 .cnote file\(s\); 1 failed/);
  assert.doesNotMatch(result.stderr, /unhandled|ERR_OUT_OF_RANGE/);
  assert.ok(!fs.existsSync(pdfPath(cwd, "bad-jpeg")));
  assert.match(fs.readFileSync(path.join(cwd, "cnote_exports", "bad-jpeg", "manifest.txt"), "utf8"), /Conversion error:/);
});

test("attachment write errors are caught by the note job and prevent PDF creation", async (t) => {
  const cwd = fixture(t);
  const note = writeNote(cwd, "blocked", [attachment(await image("jpeg", 7, 9))]);
  const media = path.join(cwd, "cnote_exports", "blocked", "media");
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, "attachments"), "file blocking directory creation");
  const result = await run(cwd, [note]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Converted 0 .cnote file\(s\); 1 failed/);
  assert.ok(!fs.existsSync(pdfPath(cwd, "blocked")));
  assert.match(fs.readFileSync(path.join(cwd, "cnote_exports", "blocked", "manifest.txt"), "utf8"), /Conversion error:/);
});

test("a nonexistent input is reported through the CLI rejection handler", async (t) => {
  const cwd = fixture(t);
  const result = await run(cwd, [path.join(cwd, "not-found.cnote")]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Conversion failed:.*ENOENT/);
});

test("generated names avoid Windows reserved devices and trailing dots", async (t) => {
  const cwd = fixture(t);
  const cases = [["CON", "_CON"], ["nul.txt", "_nul.txt"], ["COM¹", "_COM¹"], ["LPT9", "_LPT9"], ["meeting. ", "meeting"], ["...", "note"]];
  const files = cases.map(([name], index) => {
    const file = path.join(cwd, `note-${index}.cnote`);
    fs.writeFileSync(file, zip([
      ["note.json", { name, size: [100, 100] }],
      ["page0.cpage", { _dkDrawing: [] }],
    ]));
    return file;
  });
  writeNote(cwd, "trailing.", []);
  const result = await run(cwd, [...files, path.join(cwd, "trailing..cnote")]);
  assert.equal(result.code, 0, result.stderr);
  for (const [, output] of cases) {
    const index = cases.findIndex((entry) => entry[1] === output);
    assert.ok(fs.existsSync(path.join(cwd, "cnote_exports", `note-${index}`, `${output}.pdf`)));
  }
  assert.ok(fs.existsSync(pdfPath(cwd, "trailing")));
});

test("JPEG preview and embedded-PDF fallback paths remain usable", async (t) => {
  const cwd = fixture(t);
  const jpeg = await image("jpeg", 7, 9);
  const previewNote = path.join(cwd, "preview.cnote");
  fs.writeFileSync(previewNote, zip([["preview.jpg", jpeg]]));
  const previewResult = await run(cwd, [previewNote]);
  assert.equal(previewResult.code, 0, previewResult.stderr);
  const pdf = fs.readFileSync(path.join(cwd, "cnote_exports", "preview", "preview-preview.pdf"));
  assert.deepEqual(embeddedImages(pdf).map(({ width, height }) => [width, height]), [[7, 9]]);
  const pdfNote = path.join(cwd, "embedded.cnote");
  fs.writeFileSync(pdfNote, zip([["original.pdf", pdf]]));
  const pdfResult = await run(cwd, [pdfNote]);
  assert.equal(pdfResult.code, 0, pdfResult.stderr);
  assert.deepEqual(fs.readFileSync(pdfPath(cwd, "embedded")), pdf);
});
