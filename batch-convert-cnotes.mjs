import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const workspace = process.cwd();
const outputRoot = path.join(workspace, "cnote_exports");

function main() {
  const sourceRoots = process.argv.slice(2).map((source) => path.resolve(source));
  const jobs = sourceRoots.length > 0
    ? sourceRoots.flatMap((sourceRoot) => discoverCnoteJobs(sourceRoot))
    : fs.readdirSync(workspace)
      .filter((name) => name.toLowerCase().endsWith(".cnote"))
      .map((fileName) => ({
        sourcePath: path.join(workspace, fileName),
        displayName: fileName,
        outputParent: outputRoot,
      }));

  fs.mkdirSync(outputRoot, { recursive: true });

  let converted = 0;
  let failed = 0;

  for (const job of jobs) {
    const fileName = path.basename(job.sourcePath);
    const noteName = fileName.replace(/\.cnote$/i, "");
    const noteDir = path.join(job.outputParent, safeName(noteName));
    const extractDir = path.join(noteDir, "extracted");
    const mediaDir = path.join(noteDir, "media");

    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(mediaDir, { recursive: true });

    const manifest = [`Source: ${job.displayName}`];

    try {
      const bytes = fs.readFileSync(job.sourcePath);
      manifest.push(`Bytes: ${bytes.length}`);

      const extracted = looksLikeZip(bytes)
        ? extractZipPackage(bytes, extractDir, manifest)
        : extractDirectJson(fileName, bytes, manifest);

      for (const note of extracted.noteFiles) {
        recoverNoteMedia(note.json, mediaDir, manifest);
      }
      recoverPageAttachments(extracted.cpageFiles, mediaDir, manifest);

      if (extracted.cpageFiles.length > 0) {
        const noteMeta = extracted.noteFiles.find((note) => Array.isArray(note.json.size))?.json ?? {};
        const pdfBytes = renderCpagesToPdf(extracted.cpageFiles, noteMeta, manifest);
        const pdfPath = path.join(noteDir, `${safeName(noteMeta.name || noteName)}.pdf`);
        fs.writeFileSync(pdfPath, pdfBytes);
        manifest.push(`Converted PDF: ${path.relative(noteDir, pdfPath)}`);
      } else if (extracted.pdfFiles.length > 0) {
        for (let index = 0; index < extracted.pdfFiles.length; index += 1) {
          const pdf = extracted.pdfFiles[index];
          const pdfPath = path.join(noteDir, `${safeName(noteName)}${index ? `-${index + 1}` : ""}.pdf`);
          fs.writeFileSync(pdfPath, pdf.bytes);
          manifest.push(`Extracted PDF: ${path.relative(noteDir, pdfPath)} (${pdf.name})`);
        }
      } else if (extracted.imageFiles.length > 0) {
        const pdfBytes = imagesToPdf(extracted.imageFiles);
        const pdfPath = path.join(noteDir, `${safeName(noteName)}-preview.pdf`);
        fs.writeFileSync(pdfPath, pdfBytes);
        manifest.push(`Preview PDF: ${path.relative(noteDir, pdfPath)}`);
      } else {
        manifest.push("Converted PDF: unavailable; no .cpage strokes, embedded PDF, or page images were found.");
      }

      manifest.push(`CollaNote pages: ${extracted.cpageFiles.length}`);
      manifest.push(`Note metadata files: ${extracted.noteFiles.length}`);
      manifest.push(`Embedded PDFs: ${extracted.pdfFiles.length}`);
      manifest.push(`Image/previews: ${extracted.imageFiles.length}`);
      manifest.push(`Image attachments: ${extracted.imageAttachmentCount}`);
      converted += 1;
    } catch (error) {
      failed += 1;
      manifest.push(`Conversion error: ${error.message || error}`);
    } finally {
      fs.writeFileSync(path.join(noteDir, "manifest.txt"), `${manifest.join("\n")}\n`);
    }

    console.log(`Created ${path.relative(workspace, noteDir)}`);
  }

  console.log(`Converted ${converted} .cnote file(s); ${failed} failed.`);
}

function discoverCnoteJobs(sourceRoot) {
  const stat = fs.statSync(sourceRoot);
  if (stat.isFile()) {
    if (!sourceRoot.toLowerCase().endsWith(".cnote")) return [];
    return [{
      sourcePath: sourceRoot,
      displayName: sourceRoot,
      outputParent: outputRoot,
    }];
  }

  const jobs = [];
  const rootOutputParent = path.join(outputRoot, safeName(path.basename(sourceRoot)));
  for (const sourcePath of walkCnoteFiles(sourceRoot)) {
    const relativeDir = path.relative(sourceRoot, path.dirname(sourcePath));
    const relativeFile = path.join(path.basename(sourceRoot), path.relative(sourceRoot, sourcePath));
    jobs.push({
      sourcePath,
      displayName: relativeFile,
      outputParent: path.join(rootOutputParent, ...safePathSegments(relativeDir)),
    });
  }
  return jobs.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function walkCnoteFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkCnoteFiles(entryPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cnote")) files.push(entryPath);
  }
  return files;
}

function safePathSegments(relativeDir) {
  if (!relativeDir || relativeDir === ".") return [];
  return relativeDir.split(path.sep).filter(Boolean).map(safeName);
}

function extractZipPackage(zipBytes, extractDir, manifest) {
  const entries = parseZip(zipBytes);
  const result = emptyResult();
  manifest.push(`Archive entries: ${entries.length}`);

  for (const entry of entries) {
    const entryBytes = inflateEntry(zipBytes, entry);
    const outputPath = safeJoin(extractDir, entry.name);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, entryBytes);

    classifyEntry(entry.name, entryBytes, result, manifest);
  }

  return result;
}

function extractDirectJson(name, bytes, manifest) {
  const result = emptyResult();
  classifyEntry(name, bytes, result, manifest);
  return result;
}

function classifyEntry(name, bytes, result, manifest) {
  const ext = extensionOf(name);
  if (ext === "pdf") {
    result.pdfFiles.push({ name, bytes });
    return;
  }

  if (["jpg", "jpeg", "png"].includes(ext)) {
    result.imageFiles.push({ name, bytes });
    return;
  }

  if (!["cnote", "cpage", "json"].includes(ext)) return;

  const text = bytes.toString("utf8");
  if (!text.trim().startsWith("{")) return;

  try {
    const json = JSON.parse(text);
    if (Array.isArray(json._dkDrawing) || (ext === "cpage" && typeof json.drawing === "string")) {
      result.cpageFiles.push({ name, json });
      result.imageAttachmentCount += countImageAttachments(json);
      manifest.push(`CollaNote page: ${name}`);
    } else {
      result.noteFiles.push({ name, json });
      manifest.push(`Note metadata: ${name}`);
      if (typeof json.thumbnail === "string") {
        const thumbnailBytes = Buffer.from(json.thumbnail, "base64");
        if (isJpeg(thumbnailBytes) || isPng(thumbnailBytes)) {
          result.imageFiles.push({ name: `${name}-thumbnail.jpg`, bytes: thumbnailBytes });
        }
      }
    }
  } catch {
    manifest.push(`Unreadable JSON-like entry: ${name}`);
  }
}

function recoverPageAttachments(cpageFiles, mediaDir, manifest) {
  const attachmentDir = path.join(mediaDir, "attachments");
  for (const page of cpageFiles) {
    const pageNumber = page.name.replace(/\D+/g, "") || "page";
    const attachments = Array.isArray(page.json.attachments) ? page.json.attachments : [];
    page.renderAttachments = [];

    attachments.forEach((attachment, index) => {
      if (attachment?.type !== "image" || typeof attachment.imageInData !== "string") return;
      const bytes = Buffer.from(attachment.imageInData, "base64");
      const ext = isPng(bytes) ? "png" : isJpeg(bytes) ? "jpg" : "bin";
      const fileName = `page-${String(pageNumber).padStart(2, "0")}-attachment-${index + 1}.${ext}`;
      fs.mkdirSync(attachmentDir, { recursive: true });
      const imagePath = path.join(attachmentDir, fileName);
      fs.writeFileSync(imagePath, bytes);
      manifest.push(`Recovered image attachment: ${path.relative(path.dirname(mediaDir), imagePath)}`);

      const jpeg = imageForPdf(bytes, ext, imagePath);
      if (jpeg) {
        page.renderAttachments.push({
          ...attachment,
          pdfImage: jpeg,
        });
      }
    });
  }
}

function imageForPdf(bytes, ext, sourcePath) {
  if (ext === "jpg") {
    const size = jpegSize(bytes);
    return { bytes, width: size.width, height: size.height };
  }

  if (ext !== "png") return null;

  const jpegPath = sourcePath.replace(/\.png$/i, ".pdf-render.jpg");
  try {
    execFileSync("sips", ["-s", "format", "jpeg", sourcePath, "--out", jpegPath], { stdio: "ignore" });
    const jpegBytes = fs.readFileSync(jpegPath);
    const size = jpegSize(jpegBytes);
    return { bytes: jpegBytes, width: size.width, height: size.height };
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(jpegPath)) fs.unlinkSync(jpegPath);
    } catch {
      // Best effort cleanup for temporary PDF render files.
    }
  }
}

function recoverNoteMedia(note, mediaDir, manifest) {
  if (typeof note.thumbnail === "string") {
    const bytes = Buffer.from(note.thumbnail, "base64");
    if (isJpeg(bytes) || isPng(bytes)) {
      const thumbPath = path.join(mediaDir, "thumbnail.jpg");
      fs.writeFileSync(thumbPath, bytes);
      manifest.push(`Recovered thumbnail: ${path.relative(path.dirname(mediaDir), thumbPath)}`);
    }
  }

  if (Array.isArray(note.audios)) {
    note.audios.forEach((audio, index) => {
      if (typeof audio.audioData !== "string") return;
      const audioPath = path.join(mediaDir, `audio-${index + 1}.m4a`);
      fs.writeFileSync(audioPath, Buffer.from(audio.audioData, "base64"));
      const duration = Number.isFinite(audio.duration) ? `, duration ${audio.duration}s` : "";
      manifest.push(`Recovered audio: ${path.relative(path.dirname(mediaDir), audioPath)}${duration}`);
    });
  }
}

function renderCpagesToPdf(cpageFiles, noteMeta, manifest = null) {
  const [width, height] = Array.isArray(noteMeta.size) ? noteMeta.size : [1050, 1485];
  const pages = [...cpageFiles].sort((a, b) => pageSortValue(a.name) - pageSortValue(b.name)).map((pageFile, pageIndex) => {
    const cpage = pageFile.json;
    const commands = [];
    const images = [];
    commands.push("1 1 1 rg 0 0 " + width + " " + height + " re f");
    commands.push("0.88 0.90 0.89 RG 1 w");
    if (/line/i.test(noteMeta.paperOrTemplate || "")) {
      const lineMetrics = paperLineMetrics(noteMeta.paperOrTemplate);
      for (let y = lineMetrics.offset; y < height; y += lineMetrics.spacing) {
        const pdfY = height - y;
        commands.push(`70 ${fmt(pdfY)} m ${width - 70} ${fmt(pdfY)} l S`);
      }
    }
    for (const [index, attachment] of (pageFile.renderAttachments || []).entries()) {
      const placement = attachmentPlacement(attachment, width, height);
      const name = `Im${index + 1}`;
      images.push({ name, ...attachment.pdfImage });
      commands.push(`q ${fmt(placement.width)} 0 0 ${fmt(placement.height)} ${fmt(placement.x)} ${fmt(placement.y)} cm /${name} Do Q`);
    }
    commands.push("1 J 1 j");

    const pageStrokes = [];
    let drawingKitCount = 0;
    let legacyCount = 0;
    for (const encodedDrawing of cpage._dkDrawing || []) {
      const strokes = parseDrawingKit(encodedDrawing);
      drawingKitCount += strokes.length;
      pageStrokes.push(...strokes);
    }
    if (typeof cpage.drawing === "string") {
      const strokes = parseLegacyDrawing(cpage.drawing, pageIndex * height, height);
      legacyCount += strokes.length;
      pageStrokes.push(...strokes);
    }
    const renderedStrokes = pageStrokes.filter((stroke) => !isPageFrameArtifact(stroke, width, height));
    manifest?.push(`Page ${pageSortValue(pageFile.name) + 1}: ${renderedStrokes.length} rendered stroke(s) (${drawingKitCount} DrawingKit, ${legacyCount} legacy)`);
    for (const stroke of strokeRenderOrder(renderedStrokes)) {
      if (!stroke.points.length) continue;
      commands.push(pdfStrokeCommand(stroke, height));
    }
    return { content: commands.join("\n") + "\n", images };
  });

  return buildPdf(pages, width, height);
}

function strokeRenderOrder(strokes) {
  return [...strokes].sort((a, b) => Number(b.isHighlighter) - Number(a.isHighlighter));
}

function paperLineMetrics(templateName = "") {
  if (/\bL\b/i.test(templateName)) return { offset: 90, spacing: 50 };
  return { offset: 92, spacing: 38 };
}

function isPageFrameArtifact(stroke, pageWidth, pageHeight) {
  if (!stroke.isHighlighter || stroke.points.length < 20) return false;
  const bounds = strokeBounds(stroke.points);
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const touchesPageEdge = bounds.minX < pageWidth * 0.02 || bounds.minY < pageHeight * 0.02;
  return touchesPageEdge && spanX > pageWidth * 0.65 && spanY > pageHeight * 0.65;
}

function strokeBounds(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function pdfStrokeCommand(stroke, pageHeight) {
  const color = stroke.pdfColor || [0.1, 0.1, 0.09];
  const colorCommand = `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} RG ${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg`;
  const commands = [stroke.isHighlighter ? `q /HL gs ${colorCommand} ${fmt(stroke.width)} w` : `${colorCommand} ${fmt(stroke.width)} w`];
  const first = stroke.points[0];
  if (stroke.points.length === 1) {
    const radius = Math.max(0.8, stroke.width / 2);
    commands.push(circlePath(first.x, pageHeight - first.y, radius));
    if (stroke.isHighlighter) commands.push("Q");
    return commands.join(" ");
  }

  const pathCommands = [`${fmt(first.x)} ${fmt(pageHeight - first.y)} m`];
  for (let index = 1; index < stroke.points.length - 1; index += 1) {
    const current = stroke.points[index];
    const next = stroke.points[index + 1];
    const midX = (current.x + next.x) / 2;
    const midY = (current.y + next.y) / 2;
    pathCommands.push(`${fmt(current.x)} ${fmt(pageHeight - current.y)} ${fmt(midX)} ${fmt(pageHeight - midY)} v`);
  }
  const last = stroke.points[stroke.points.length - 1];
  pathCommands.push(`${fmt(last.x)} ${fmt(pageHeight - last.y)} l S`);
  commands.push(pathCommands.join(" "));
  if (stroke.isHighlighter) commands.push("Q");
  return commands.join(" ");
}

function circlePath(x, y, radius) {
  const k = 0.5522847498 * radius;
  return [
    `${fmt(x + radius)} ${fmt(y)} m`,
    `${fmt(x + radius)} ${fmt(y + k)} ${fmt(x + k)} ${fmt(y + radius)} ${fmt(x)} ${fmt(y + radius)} c`,
    `${fmt(x - k)} ${fmt(y + radius)} ${fmt(x - radius)} ${fmt(y + k)} ${fmt(x - radius)} ${fmt(y)} c`,
    `${fmt(x - radius)} ${fmt(y - k)} ${fmt(x - k)} ${fmt(y - radius)} ${fmt(x)} ${fmt(y - radius)} c`,
    `${fmt(x + k)} ${fmt(y - radius)} ${fmt(x + radius)} ${fmt(y - k)} ${fmt(x + radius)} ${fmt(y)} c f`,
  ].join(" ");
}

function pageSortValue(name) {
  const match = /\d+/.exec(name);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function attachmentPlacement(attachment, pageWidth, pageHeight) {
  const center = Array.isArray(attachment.center) ? attachment.center : [0.5, 0.5];
  const bound = Array.isArray(attachment.bound) ? attachment.bound : [[0, 0], [1, 1]];
  const normalizedWidth = Number(bound[1]?.[0] ?? 1);
  const normalizedHeight = Number(bound[1]?.[1] ?? 1);
  const drawWidth = normalizedWidth * pageWidth;
  const drawHeight = normalizedHeight * pageHeight;
  const x = (Number(center[0] ?? 0.5) * pageWidth) - drawWidth / 2;
  const top = (Number(center[1] ?? 0.5) * pageHeight) - drawHeight / 2;
  return {
    x,
    y: pageHeight - top - drawHeight,
    width: drawWidth,
    height: drawHeight,
  };
}

function imagesToPdf(images) {
  const pages = images.filter((image) => isJpeg(image.bytes)).map((image) => ({
    imageBytes: image.bytes,
    width: jpegSize(image.bytes).width,
    height: jpegSize(image.bytes).height,
  }));

  if (!pages.length) {
    throw new Error("Only JPEG image previews can be converted by the batch script.");
  }

  return buildImagePdf(pages);
}

function buildPdf(pages, width, height) {
  const chunks = [];
  const offsets = [0];
  let position = 0;
  const write = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "binary");
    chunks.push(chunk);
    position += chunk.length;
  };
  const startObject = (id) => {
    offsets[id] = position;
    write(`${id} 0 obj\n`);
  };

  write("%PDF-1.4\n");
  startObject(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObject(2);
  const pageIds = [];
  let nextObjectId = 3;
  for (const page of pages) {
    page.pageId = nextObjectId++;
    page.contentId = nextObjectId++;
    page.imageIds = page.images.map(() => nextObjectId++);
    pageIds.push(page.pageId);
  }
  write(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>\nendobj\n`);

  pages.forEach((page) => {
    const xobjects = page.images.length
      ? ` /XObject << ${page.images.map((image, index) => `/${image.name} ${page.imageIds[index]} 0 R`).join(" ")} >>`
      : "";
    startObject(page.pageId);
    write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /ProcSet [/PDF /ImageC]${xobjects} /ExtGState << /HL << /Type /ExtGState /CA 0.35 /ca 0.35 /BM /Multiply >> >> >> /Contents ${page.contentId} 0 R >>\nendobj\n`);
    startObject(page.contentId);
    write(`<< /Length ${Buffer.byteLength(page.content)} >>\nstream\n${page.content}endstream\nendobj\n`);
    page.images.forEach((image, index) => {
      startObject(page.imageIds[index]);
      write(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`);
      write(image.bytes);
      write("\nendstream\nendobj\n");
    });
  });

  return finishPdf(chunks, offsets, position, nextObjectId - 1, write);
}

function buildImagePdf(pages) {
  const chunks = [];
  const offsets = [0];
  let position = 0;
  const write = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, "binary");
    chunks.push(chunk);
    position += chunk.length;
  };
  const startObject = (id) => {
    offsets[id] = position;
    write(`${id} 0 obj\n`);
  };

  write("%PDF-1.4\n");
  startObject(1);
  write("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObject(2);
  write(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ")}] >>\nendobj\n`);

  pages.forEach((page, index) => {
    const pageId = 3 + index * 3;
    const imageId = pageId + 1;
    const contentId = pageId + 2;
    const width = page.width;
    const height = page.height;
    const content = `q\n${width} 0 0 ${height} 0 0 cm\n/Im${index + 1} Do\nQ\n`;

    startObject(pageId);
    write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /ProcSet [/PDF /ImageC] /XObject << /Im${index + 1} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\nendobj\n`);
    startObject(imageId);
    write(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.imageBytes.length} >>\nstream\n`);
    write(page.imageBytes);
    write("\nendstream\nendobj\n");
    startObject(contentId);
    write(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream\nendobj\n`);
  });

  return finishPdf(chunks, offsets, position, 2 + pages.length * 3, write);
}

function finishPdf(chunks, offsets, position, maxObjectId, write) {
  const xrefOffset = position;
  write(`xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= maxObjectId; id += 1) {
    write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  write(`trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

function parseDrawingKit(encodedDrawing) {
  const bytes = Buffer.from(encodedDrawing, "base64");
  const reader = new BinaryReader(bytes);
  const strokes = [];

  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.fieldNumber === 1 && field.wireType === 2) {
      try {
        const stroke = parseStroke(reader.bytes());
        if (stroke.points.length > 0) strokes.push(stroke);
      } catch {
        // Some CollaNote payloads include DrawingKit records we do not render yet.
      }
    } else {
      reader.skip(field.wireType);
    }
  }
  return strokes;
}

function parseLegacyDrawing(encodedDrawing, pageYOffset = 0, pageHeight = 0) {
  const bytes = Buffer.from(encodedDrawing, "base64");
  if (bytes.length < 8 || bytes[0] !== 0x77 || bytes[1] !== 0x72 || bytes[2] !== 0x64) return [];

  const reader = new BinaryReader(bytes.subarray(8));
  const styles = [];
  const strokeRecords = [];

  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.fieldNumber === 4 && field.wireType === 2) {
      styles.push(parseLegacyStyle(reader.bytes()));
    } else if (field.fieldNumber === 5 && field.wireType === 2) {
      strokeRecords.push(reader.bytes());
    } else {
      reader.skip(field.wireType);
    }
  }

  return normalizeLegacyPageCoordinates(strokeRecords
    .map((record) => parseLegacyStroke(record, styles))
    .filter((stroke) => stroke.points.length > 0), pageYOffset, pageHeight);
}

function normalizeLegacyPageCoordinates(strokes, pageYOffset, pageHeight) {
  if (!strokes.length || pageYOffset <= 0 || pageHeight <= 0) return strokes;

  const bounds = legacyStrokeBounds(strokes);
  const looksDocumentGlobal = bounds.maxY > pageHeight * 1.25
    && bounds.minY >= pageYOffset - pageHeight * 0.25;
  if (!looksDocumentGlobal) return strokes;

  return strokes.map((stroke) => ({
    ...stroke,
    points: stroke.points.map((point) => ({
      ...point,
      y: point.y - pageYOffset,
    })),
  }));
}

function legacyStrokeBounds(strokes) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return { minY, maxY };
}

function parseLegacyStyle(bytes) {
  const reader = new BinaryReader(bytes);
  const style = {};

  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.fieldNumber === 1 && field.wireType === 2) {
      const color = parseStyleColor(reader.bytes());
      if (color) style.color = color;
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      style.inkType = reader.bytes().toString("utf8");
    } else {
      reader.skip(field.wireType);
    }
  }

  style.isHighlighter = /marker/i.test(style.inkType || "");
  return style;
}

function parseLegacyStroke(bytes, styles) {
  const reader = new BinaryReader(bytes);
  let styleIndex = 0;
  let pathBytes = null;

  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.fieldNumber === 4 && field.wireType === 0) {
      styleIndex = reader.varint();
    } else if (field.fieldNumber === 5 && field.wireType === 2) {
      pathBytes = reader.bytes();
    } else {
      reader.skip(field.wireType);
    }
  }

  const { points, width } = pathBytes ? parseLegacyStrokePath(pathBytes) : { points: [], width: null };
  const style = styles[styleIndex] || styles[0] || {};
  const strokeWidth = width || style.width || (style.isHighlighter ? 18 : 2.6);
  const isHighlighter = style.isHighlighter || strokeWidth >= 12;
  return {
    points,
    width: strokeWidth,
    isHighlighter,
    pdfColor: style.color || (isHighlighter ? [1, 0.88, 0.16] : [0.1, 0.1, 0.09]),
  };
}

function parseLegacyStrokePath(bytes) {
  const reader = new BinaryReader(bytes);
  let pointCount = 0;
  let pointBytes = null;

  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.fieldNumber === 3 && field.wireType === 0) {
      pointCount = reader.varint();
    } else if (field.fieldNumber === 7 && field.wireType === 2) {
      pointBytes = reader.bytes();
    } else {
      reader.skip(field.wireType);
    }
  }

  return parseLegacyPackedPoints(pointBytes, pointCount);
}

function parseLegacyPackedPoints(bytes, pointCount) {
  if (!bytes || !bytes.length) return { points: [], width: null };

  const stride = pointCount > 0
    ? bytes.length / pointCount
    : bytes.length % 16 === 0 ? 16 : 12;
  if (!Number.isInteger(stride) || stride < 8) return { points: [], width: null };

  const points = [];
  const widths = [];
  for (let offset = 0; offset + 7 < bytes.length; offset += stride) {
    const point = {
      x: bytes.readFloatLE(offset),
      y: bytes.readFloatLE(offset + 4),
    };
    if (isPlausiblePoint(point)) points.push(point);
    if (stride >= 16 && offset + 15 < bytes.length) {
      const width = bytes.readFloatLE(offset + 12);
      if (width > 0.1 && width < 80) widths.push(width);
    }
  }

  return {
    points,
    width: median(widths),
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function parseStroke(bytes) {
  const style = scanStrokeStyle(bytes);
  const width = style.width || 2.6;
  const isHighlighter = style.tool === 27 || width >= 12;
  const color = style.color || (isHighlighter ? [1, 0.88, 0.16] : [0.1, 0.1, 0.09]);
  return {
    points: scanStrokePoints(bytes),
    width,
    isHighlighter,
    pdfColor: color,
  };
}

function scanStrokePoints(bytes) {
  const points = readTopLevelStrokePoints(bytes);
  if (points.length > 0) return points;

  return scanEmbeddedStrokePoints(bytes);
}

function readTopLevelStrokePoints(bytes) {
  const points = [];

  try {
    const reader = new BinaryReader(bytes);
    while (!reader.done()) {
      const field = reader.field();
      if (!field) break;
      if (field.fieldNumber === 2 && field.wireType === 2) {
        const point = parsePoint(reader.bytes());
        if (isPlausiblePoint(point)) points.push(point);
      } else {
        reader.skip(field.wireType);
      }
    }
  } catch {
    return [];
  }

  return points;
}

function scanEmbeddedStrokePoints(bytes) {
  const points = [];

  for (let index = 0; index < bytes.length - 2; index += 1) {
    if (bytes[index] !== 0x12) continue;

    const lengthInfo = readVarintAt(bytes, index + 1);
    if (!lengthInfo) continue;

    const length = lengthInfo.value;
    const start = lengthInfo.nextOffset;
    const end = start + length;
    if (length < 10 || length > 64 || end > bytes.length) continue;

    const point = parsePoint(bytes.subarray(start, end));
    if (!isPlausiblePoint(point)) continue;

    points.push(point);
    index = end - 1;
  }

  return points;
}

function isPlausiblePoint(point) {
  return Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && point.x > -100000
    && point.x < 100000
    && point.y > -100000
    && point.y < 100000;
}

function scanStrokeStyle(bytes) {
  const direct = readStrokeStyleBytes(bytes);
  if (direct) {
    let style = {};
    try {
      style = parseStrokeStyle(direct);
    } catch {
      style = {};
    }
    if (style.width || style.color || style.tool) return style;
  }

  for (let index = 0; index < bytes.length - 2; index += 1) {
    if (bytes[index] !== 0x1a) continue;

    const lengthInfo = readVarintAt(bytes, index + 1);
    if (!lengthInfo) continue;

    const length = lengthInfo.value;
    const start = lengthInfo.nextOffset;
    const end = start + length;
    if (length < 1 || length > 128 || end > bytes.length) continue;

    let style = {};
    try {
      style = parseStrokeStyle(bytes.subarray(start, end));
    } catch {
      style = {};
    }
    if (style.width || style.color || style.tool) return style;
    index = end - 1;
  }

  return {};
}

function readStrokeStyleBytes(bytes) {
  try {
    const reader = new BinaryReader(bytes);
    while (!reader.done()) {
      const field = reader.field();
      if (!field) break;
      if (field.fieldNumber === 3 && field.wireType === 2) return reader.bytes();
      reader.skip(field.wireType);
    }
  } catch {
    return null;
  }
  return null;
}

function readVarintAt(bytes, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < bytes.length && shift <= 56) {
    const byte = bytes[cursor];
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, nextOffset: cursor };
    shift += 7;
  }

  return null;
}

function parsePoint(bytes) {
  const reader = new BinaryReader(bytes);
  const point = { x: NaN, y: NaN };
  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.wireType === 5 && reader.remaining() >= 4) {
      const value = reader.float32();
      if (field.fieldNumber === 1) point.x = value;
      if (field.fieldNumber === 2) point.y = value;
    } else {
      reader.skip(field.wireType);
    }
  }
  return point;
}

function parseStrokeStyle(bytes) {
  const reader = new BinaryReader(bytes);
  const style = {};
  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.fieldNumber === 1 && field.wireType === 5 && reader.remaining() >= 4) {
      const value = reader.float32();
      if (value > 0.1 && value < 80) style.width = value;
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      const color = parseStyleColor(reader.bytes());
      if (color) style.color = color;
    } else if (field.fieldNumber === 3 && field.wireType === 0) {
      style.tool = reader.varint();
    } else {
      reader.skip(field.wireType);
    }
  }
  return style;
}

function parseStyleColor(bytes) {
  const reader = new BinaryReader(bytes);
  const channels = {};
  while (!reader.done()) {
    const field = reader.field();
    if (!field) break;
    if (field.wireType === 5 && reader.remaining() >= 4) {
      const value = reader.float32();
      if (value >= 0 && value <= 1) channels[field.fieldNumber] = value;
    } else {
      reader.skip(field.wireType);
    }
  }

  if (channels[1] == null || channels[2] == null) return null;
  return [
    channels[1],
    channels[2],
    channels[3] ?? 0.12,
  ];
}

class BinaryReader {
  constructor(bytes) {
    this.buffer = bytes;
    this.offset = 0;
  }

  done() {
    return this.offset >= this.buffer.length;
  }

  field() {
    if (this.done()) return null;
    const tag = this.varint();
    return { fieldNumber: tag >> 3, wireType: tag & 7 };
  }

  varint() {
    let value = 0;
    let shift = 0;
    while (this.offset < this.buffer.length) {
      const byte = this.buffer[this.offset++];
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
    return value;
  }

  bytes() {
    const length = this.varint();
    const start = this.offset;
    this.offset += length;
    return this.buffer.subarray(start, start + length);
  }

  float32() {
    const value = this.buffer.readFloatLE(this.offset);
    this.offset += 4;
    return value;
  }

  remaining() {
    return this.buffer.length - this.offset;
  }

  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 1) this.offset = Math.min(this.buffer.length, this.offset + 8);
    else if (wireType === 2) {
      const length = this.varint();
      this.offset = Math.min(this.buffer.length, this.offset + length);
    }
    else if (wireType === 5) this.offset = Math.min(this.buffer.length, this.offset + 4);
    else this.offset = this.buffer.length;
  }
}

function parseZip(bytes) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 66000); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error("Could not find ZIP directory.");

  const entryCount = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP directory is damaged.");
    const method = bytes.readUInt16LE(offset + 10);
    let compressedSize = bytes.readUInt32LE(offset + 20);
    let uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const extra = bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      const zip64 = readZip64Sizes(extra);
      compressedSize = zip64.compressedSize ?? compressedSize;
      uncompressedSize = zip64.uncompressedSize ?? uncompressedSize;
    }
    if (!name.endsWith("/")) entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZip64Sizes(extra) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    const dataStart = offset + 4;
    if (headerId === 0x0001) {
      return {
        uncompressedSize: Number(extra.readBigUInt64LE(dataStart)),
        compressedSize: Number(extra.readBigUInt64LE(dataStart + 8)),
      };
    }
    offset += 4 + dataSize;
  }
  return {};
}

function inflateEntry(zipBytes, entry) {
  const offset = entry.localHeaderOffset;
  if (zipBytes.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Local header missing for ${entry.name}.`);
  const nameLength = zipBytes.readUInt16LE(offset + 26);
  const extraLength = zipBytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = zipBytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  if (entry.method === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`${entry.name} uses unsupported ZIP compression method ${entry.method}.`);
}

function jpegSize(bytes) {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return { width: 420, height: 593 };
}

function looksLikeZip(bytes) {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function isJpeg(bytes) {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isPng(bytes) {
  return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function extensionOf(name) {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function emptyResult() {
  return { cpageFiles: [], noteFiles: [], pdfFiles: [], imageFiles: [], imageAttachmentCount: 0 };
}

function countImageAttachments(cpage) {
  return (Array.isArray(cpage.attachments) ? cpage.attachments : [])
    .filter((attachment) => attachment?.type === "image" && typeof attachment.imageInData === "string")
    .length;
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim() || "note";
}

function safeJoin(root, entryName) {
  const target = path.resolve(root, entryName);
  const resolvedRoot = path.resolve(root);
  if (!target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Unsafe archive path: ${entryName}`);
  }
  return target;
}

function fmt(value) {
  return Number(value).toFixed(2).replace(/\.?0+$/, "");
}

main();
