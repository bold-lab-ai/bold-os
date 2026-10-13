// The site's commits, for the changelog (changelog.html, pages/changelog.js):
// [{ hash, at (ms), author, subject }], newest first, read from git at build
// time (the Pages workflow checks out the full history). An author's name is the
// fullest one they have committed under; the bot's rebuild commits are left out.
// `json` is the list as JSON that's safe inside a <script>.
import { execSync } from 'node:child_process';

let list = [];
try {
  const out = execSync('git log --no-merges --format=%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e', { encoding: 'utf8', maxBuffer: 1 << 26 });
  const rows = out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => r.split('\x1f'));
  const fullest = {};
  rows.forEach(([, name, email]) => {
    const clean = name.replace(/[“”"]/g, '').trim();
    if (!fullest[email] || clean.length > fullest[email].length) fullest[email] = clean;
  });
  list = rows.filter(([, name]) => !/\[bot\]$/.test(name))
    .map(([hash, , email, at, subject]) => ({ hash, at: Number(at) * 1000, author: fullest[email], subject }));
} catch (e) {
  console.warn('[commits] git log failed; the changelog lists no commits', e.message);
}

export default { list, json: JSON.stringify(list).replace(/</g, '\\u003c') };
