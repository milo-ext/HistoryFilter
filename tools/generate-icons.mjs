// Run `npm ci` once, then `node tools/generate-icons.mjs`.
// resvg renders the checked-in SVG paths, including rounded strokes, directly
// at each output size. No large PNG is used to generate the toolbar icons.
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const outputDir = new URL('../assets/icons/', import.meta.url);
const variants = [
  { source: 'icon16.svg', sizes: [16, 32], inset: 1 / 16 },
  { source: 'icon.svg', sizes: [48, 128], inset: 16 / 128 }
];

for (const { source, sizes, inset } of variants) {
  const svg = fs.readFileSync(new URL(source, outputDir));
  for (const size of sizes) {
    const rendered = new Resvg(svg, {
      fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: false }
    }).render();
    if (rendered.width !== size || rendered.height !== size) throw new Error(`Wrong dimensions: ${source}`);
    const pixels = rendered.pixels;
    const xs = [], ys = [];
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (pixels[(y * size + x) * 4 + 3]) { xs.push(x); ys.push(y); }
    }
    const margins = [Math.min(...xs), Math.min(...ys), size - 1 - Math.max(...xs), size - 1 - Math.max(...ys)];
    if (!margins.every(value => value === size * inset)) throw new Error(`Wrong transparent margins: ${source}: ${margins}`);
    fs.writeFileSync(new URL(`icon${size}.png`, outputDir), rendered.asPng());
    console.log(`icon${size}.png: ${size}x${size}, transparent margins ${margins.join('/')}, source ${source}`);
  }
}
fs.copyFileSync(new URL('icon128.png', outputDir), new URL('../docs/icon128.png', import.meta.url));
console.log('Synced docs/icon128.png');
