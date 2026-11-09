// Copies the 3D office and shared assets into office/public for a Worker assets binding.
// Does not copy landing/ (the public homepage) and does not embed credentials.
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const out = path.resolve(import.meta.dirname, 'public');
const parts = [
  ['web', 'office', /^(index\.html|app\.js|styles\.css|wallpaper\.js|feed\.js)$/],
  ['web/lib', 'office/lib', /\.(js|css|json)$/, { deep: true }],
  ['web/scene', 'office/scene', /\.(js|css)$/],
  ['web/vendor/three', 'office/vendor/three', /\.js$|^LICENSE$|^INTEGRITY\.json$/, { deep: true }],
  ['web/ui', 'office/ui', /\.(js|css)$/],
  ['web/audio', 'office/audio', /\.(js|m4a)$/],
  ['web/share', 'office/share', /\.(js|css)$/],
  ['web/data', 'office/data', /^demo-(state|looks)\.json$/],
  ['assets/blobs', 'assets/blobs', /\.glb$/],
  ['assets/blobs/thumbs', 'assets/blobs/thumbs', /\.png$/],
  ['assets/blobs/lib', 'assets/blobs/lib', /\.(png|json)$/, { optional: true }],
  ['assets/office', 'assets/office', /^office\.glb$/],
  ['assets/office/night', 'assets/office/night', /\.jpg$/],
  ['assets/brand', 'assets/brand', /\.(png|svg)$/],
  ['assets/earth', 'assets/earth', /^(day|night)\.jpg$/],
];

function copy(src, dst, keep, deep) {
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (deep) n += copy(path.join(src, entry.name), path.join(dst, entry.name), keep, deep);
      continue;
    }
    if (!keep.test(entry.name)) continue;
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name));
    n++;
  }
  return n;
}

fs.rmSync(out, { recursive: true, force: true });
let total = 0;
for (const [from, to, keep, { deep = false, optional = false } = {}] of parts) {
  const src = path.join(repo, from);
  const n = fs.existsSync(src) ? copy(src, path.join(out, to), keep, deep) : 0;
  if (!n && !optional) throw new Error(`nothing to copy from ${from}/`);
  total += n;
}
console.log(`assembled ${total} files into ${out}`);
