#!/usr/bin/env node
// Fetch only the profile photos named in the local rota snapshot. The preview
// itself uses the downloaded files and makes no image requests to this host.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';

const page = await readFile('_site/group-meetings-preview.html', 'utf8');
const match = page.match(/const data = (.*);\n/);
if (!match) throw new Error('Build the local rota preview first.');
const data = JSON.parse(match[1]);
const names = [...new Set(data.people.map(([, person]) => person.name).filter(Boolean))];
const slug = name => String(name).toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const slugs = [...new Set(names.map(slug).filter(Boolean))];
const directory = '_site/assets/img/rota-profiles';
await mkdir(directory, { recursive: true });

const results = [];
async function download(name){
  const path = `${directory}/${name}.webp`;
  if (await stat(path).then(file => file.size > 0).catch(() => false)) return 'cached';
  const response = await fetch(`https://bold-lab.ai/profile-assets/${name}.webp`, { redirect: 'error' });
  if (response.status === 404) return 'missing';
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  if (!(response.headers.get('content-type') || '').startsWith('image/webp')) throw new Error(`${name}: expected a WebP image`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 1_000_000) throw new Error(`${name}: unexpected image size`);
  await writeFile(path, bytes);
  return 'downloaded';
}
for (let i = 0; i < slugs.length; i += 6) {
  const batch = await Promise.allSettled(slugs.slice(i, i + 6).map(download));
  results.push(...batch.map(result => result.status === 'fulfilled' ? result.value : `error: ${result.reason.message}`));
}
const counts = results.reduce((out, result) => { out[result] = (out[result] || 0) + 1; return out; }, {});
console.log(`Profile photos for ${slugs.length} rota members: ${JSON.stringify(counts)}`);
if (results.some(result => result.startsWith('error:'))) process.exitCode = 1;
