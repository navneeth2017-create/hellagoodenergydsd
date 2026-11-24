const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const inputDir = 'C:/Users/navne/code/hellagoodenergydsd';
const outputDir = 'C:/Users/navne/code/hellagoodenergydsd/public/images';

const conversions = [
  // Display image (for admin portal, etc.)
  { input: 'MarshawnDisplay2.png', output: 'display' },
  // Box images for each flavor
  { input: 'MarshawnBoxGreen.png', output: 'box-razzilicious' },      // Razzilicious (turquoise)
  { input: 'MarshawnBoxRed.png', output: 'box-strawberry-lemonade' },  // Strawberry Lemonade
  { input: 'MarshawnBoxOrange.png', output: 'box-orange-pineapple-mango' }, // Orange Pineapple Mango
];

async function convert() {
  for (const c of conversions) {
    const inputPath = path.join(inputDir, c.input);
    if (!fs.existsSync(inputPath)) {
      console.log(`❌ Missing: ${inputPath}`);
      continue;
    }

    const webpPath = path.join(outputDir, `${c.output}.webp`);
    const avifPath = path.join(outputDir, `${c.output}.avif`);

    try {
      // WebP
      await sharp(inputPath)
        .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82, effort: 6 })
        .toFile(webpPath);
      console.log(`✅ ${c.output}.webp`);

      // AVIF
      await sharp(inputPath)
        .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
        .avif({ quality: 55, effort: 9 })
        .toFile(avifPath);
      console.log(`✅ ${c.output}.avif`);
    } catch (e) {
      console.error(`❌ Failed ${c.input}:`, e.message);
    }
  }
  console.log('Done!');
}

convert();