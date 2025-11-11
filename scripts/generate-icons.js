#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

(async () => {
  try {
    const iconsDir = path.join(__dirname, '..', 'src', 'icons');
    const source = path.join(iconsDir, 'logoextension1.png');
    if (!fs.existsSync(source)) {
      console.error('Source image not found:', source);
      process.exit(2);
    }
    const sizes = [16, 48, 128];
    for (const s of sizes) {
      const out = path.join(iconsDir, `logoextension1-${s}.png`);
      await sharp(source).resize(s, s, { fit: 'cover' }).png().toFile(out);
      console.log('Wrote', out);
    }
    console.log('Icon generation complete.');
  } catch (err) {
    console.error('Failed to generate icons', err);
    process.exit(1);
  }
})();
