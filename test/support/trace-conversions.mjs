// Loaded only by the regression tests, in a separate CLI process.
import fs from "node:fs";
import { setTimeout } from "node:timers/promises";
import sharp from "sharp";

const tracePath = process.env.CNOTE_TEST_TRACE;
const record = (event) => fs.appendFileSync(tracePath, `${event}\n`);
const toBuffer = sharp.prototype.toBuffer;
let conversion = 0;
sharp.prototype.toBuffer = async function (...args) {
  const id = ++conversion;
  record(`start:${id}`);
  // Different latencies expose both premature rendering and reordered images.
  await setTimeout(id === 1 ? 100 : 10);
  try {
    const result = await toBuffer.apply(this, args);
    record(`done:${id}`);
    return result;
  } catch (error) {
    record(`failed:${id}`);
    throw error;
  }
};

const writeFileSync = fs.writeFileSync;
fs.writeFileSync = function (file, ...args) {
  if (String(file).endsWith(".pdf")) record("pdf");
  if (String(file).endsWith("manifest.txt")) record("manifest");
  return writeFileSync.call(this, file, ...args);
};
