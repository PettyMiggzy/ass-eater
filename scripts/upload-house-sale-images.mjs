#!/usr/bin/env node
// Bulk-uploads the PAID house-model files to /api/admin/house-sale-image.
//
//   ADMIN_UPLOAD_KEY=... node scripts/upload-house-sale-images.mjs <folder> [--site https://www.joinonlyone.com] [--apply]
//
// Folder layout: one sub-folder per model slug, files named by slot number:
//   <folder>/nova-reyes/1.jpg ... 6.jpg   (photos: jpg/jpeg/png/webp)
//   <folder>/nova-reyes/7.mp4 ... 9.mp4   (video clips)
// Without --apply it only prints the plan (a dry run). The admin key is read
// from the environment so it never lands in shell history or the repo.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const args = process.argv.slice(2);
const siteIdx = args.indexOf('--site');
const dir = args.find((a, i) => !a.startsWith('--') && (siteIdx < 0 || i !== siteIdx + 1));
const site = (siteIdx >= 0 ? args[siteIdx + 1] : 'https://www.joinonlyone.com').replace(/\/$/, '');
const apply = args.includes('--apply');
const key = process.env.ADMIN_UPLOAD_KEY || '';
const MAX = 4 * 1024 * 1024;
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4' };

if (!dir || !existsSync(dir)) { console.error('Usage: node scripts/upload-house-sale-images.mjs <folder> [--site URL] [--apply]'); process.exit(2); }
if (apply && !key) { console.error('Set ADMIN_UPLOAD_KEY in the environment first.'); process.exit(2); }

const plan = [];
for (const slug of readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory())) {
  for (const f of readdirSync(join(dir, slug))) {
    const m = /^(?:sale-)?([1-9])\.(\w+)$/.exec(f);
    const type = TYPES[extname(f).toLowerCase()];
    const n = m ? Number(m[1]) : 0;
    const wantsVideo = n >= 7;
    const problem = !m || !type ? 'name must be 1-9 + jpg/png/webp/mp4'
      : wantsVideo !== (type === 'video/mp4') ? (wantsVideo ? 'slots 7-9 must be .mp4' : 'slots 1-6 must be an image')
      : statSync(join(dir, slug, f)).size > MAX ? 'over 4MB (the upload limit)' : '';
    plan.push({ slug, n, file: join(dir, slug, f), type, problem });
  }
}
plan.sort((a, b) => a.slug.localeCompare(b.slug) || a.n - b.n);
let bad = 0, ok = 0;
for (const p of plan) {
  if (p.problem) { bad++; console.log(`SKIP  ${p.slug}/${p.file.split(/[\\/]/).pop()}  -- ${p.problem}`); continue; }
  if (!apply) { ok++; console.log(`PLAN  ${p.slug} slot ${p.n}  <- ${p.file}`); continue; }
  const res = await fetch(`${site}/api/admin/house-sale-image?slug=${encodeURIComponent(p.slug)}&n=${p.n}`, {
    method: 'POST', headers: { 'x-admin-key': key, 'content-type': p.type }, body: readFileSync(p.file),
  });
  const body = await res.text();
  if (res.ok) { ok++; console.log(`OK    ${p.slug} slot ${p.n}`); } else { bad++; console.log(`FAIL  ${p.slug} slot ${p.n}: ${res.status} ${body.slice(0, 120)}`); }
}
console.log(`\n${apply ? 'uploaded' : 'planned'}: ${ok}, problems: ${bad}${apply ? '' : '  (dry run -- add --apply to upload)'}`);
if (!apply) console.log('Then open /admin > AI HOUSE ROSTER and click Install on each model.');
process.exit(bad ? 1 : 0);
