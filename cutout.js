/*
 * Cut the baked-in white background out of the product photos.
 *
 * These are photos on a pure white sweep, so a brightness threshold alone would
 * also punch holes in the white type on the packaging. Instead we look at
 * connected regions of pure white: the backdrop and the pockets of backdrop you
 * can see *through* the wire display rack are all big contiguous blobs, while
 * the white lettering on the packaging is tiny and fragmented. Anything at or
 * above a size cut-off is background; the rest is left alone.
 *
 * Then the rim is feathered and un-blended from the white it was mixed with, so
 * there is no hard jagged cut line, and the result is trimmed to the product.
 *
 * Writes display/box-*.webp and .avif with alpha.
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'public', 'images');

// Pure enough to be the backdrop.
const CLEAR_WHITE = 248;
// A contiguous white blob at least this big is backdrop, not lettering.
const BACKDROP_AREA = 3000;
// Faintly white enough to be the antialiased rim of the product.
const RIM_WHITE = 206;
// Feather width, in luminance units, across the rim.
const FEATHER = 48;

const JOBS = [
  { input: 'MarshawnDisplay2.png', output: 'display', pad: 0.015 },
  { input: 'MarshawnBoxGreen.png', output: 'box-razzilicious', pad: 0.03 },
  { input: 'MarshawnBoxRed.png', output: 'box-strawberry-lemonade', pad: 0.03 },
  { input: 'MarshawnBoxOrange.png', output: 'box-orange-pineapple-mango', pad: 0.03 },
];

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

async function cutout(inputPath) {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const n = width * height;

  // --- 1. Every connected blob of pure white. ---
  const white = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    if (lum(data[o], data[o + 1], data[o + 2]) >= CLEAR_WHITE) white[i] = 1;
  }

  const seen = new Uint8Array(n);
  const bg = new Uint8Array(n); // 1 = backdrop
  const stack = [];
  let removed = 0;
  let blobs = 0;

  for (let seed = 0; seed < n; seed++) {
    if (!white[seed] || seen[seed]) continue;

    // Collect one blob.
    const members = [];
    seen[seed] = 1;
    stack.length = 0;
    stack.push(seed);

    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % width;
      const y = (i - x) / width;
      if (x > 0 && white[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < width - 1 && white[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && white[i - width] && !seen[i - width]) { seen[i - width] = 1; stack.push(i - width); }
      if (y < height - 1 && white[i + width] && !seen[i + width]) { seen[i + width] = 1; stack.push(i + width); }
    }

    if (members.length >= BACKDROP_AREA) {
      blobs++;
      removed += members.length;
      for (const i of members) bg[i] = 1;
    }
  }

  // --- 2. Apply the mask, feathering the pixels that touch the cut edge. ---
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let i = 0; i < n; i++) {
    const o = i * channels;

    if (bg[i]) {
      data[o + 3] = 0;
      continue;
    }

    const x = i % width;
    const y = (i - x) / width;

    const touchesBg =
      (x > 0 && bg[i - 1]) ||
      (x < width - 1 && bg[i + 1]) ||
      (y > 0 && bg[i - width]) ||
      (y < height - 1 && bg[i + width]);

    if (touchesBg) {
      const L = lum(data[o], data[o + 1], data[o + 2]);
      if (L >= RIM_WHITE) {
        // How much white was mixed into this pixel? That is how see-through it is.
        const a = Math.max(0, Math.min(1, (246 - L) / FEATHER));
        if (a <= 0.02) {
          data[o + 3] = 0;
          continue;
        }
        // Pull the white back out so the rim keeps its true colour.
        for (let c = 0; c < 3; c++) {
          const v = (data[o + c] - (1 - a) * 255) / a;
          data[o + c] = Math.max(0, Math.min(255, Math.round(v)));
        }
        data[o + 3] = Math.round(a * 255);
        if (data[o + 3] < 6) continue;
      }
    }

    if (data[o + 3] > 8) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) throw new Error('everything got cut away');

  const alpha = Buffer.from(data);
  const cropped = await sharp(alpha, { raw: { width, height, channels } })
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();

  return { cropped, blobs, removed };
}

async function run() {
  for (const job of JOBS) {
    const inputPath = path.join(ROOT, job.input);
    if (!fs.existsSync(inputPath)) {
      console.log(`skip (missing): ${job.input}`);
      continue;
    }

    const { cropped, blobs, removed } = await cutout(inputPath);
    const meta = await sharp(cropped).metadata();
    const pad = Math.round(Math.max(meta.width, meta.height) * job.pad);

    const padded = await sharp(cropped)
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(760, 760, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();

    await sharp(padded).webp({ quality: 90, effort: 6, alphaQuality: 100 }).toFile(path.join(OUT, `${job.output}.webp`));
    await sharp(padded).avif({ quality: 64, effort: 7 }).toFile(path.join(OUT, `${job.output}.avif`));

    const m2 = await sharp(padded).metadata();
    console.log(`ok ${job.output.padEnd(24)} ${m2.width}x${m2.height}  (${blobs} backdrop blobs, ${removed} px cut)`);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
