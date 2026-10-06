// Read-only Google Doc importer. Keep parsing and storage separate so the
// hackathon can exercise this with fictional HTML and no Google credential.
const crypto = require('node:crypto');
const parse5 = require('parse5');

const ALLOWED = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'b', 'em', 'i',
  'u', 'code', 'a', 'br', 'hr',
]);
const DROP = new Set(['head', 'style', 'script', 'svg', 'iframe', 'form', 'input', 'button', 'img']);
const BLOCK_CONTAINERS = new Set(['body', 'div', 'section', 'article', 'ul', 'ol', 'table', 'thead', 'tbody', 'tr']);

function tag(node) { return node.tagName || ''; }
function children(node) { return node.childNodes || []; }
function attr(node, name) { return (node.attrs || []).find((a) => a.name === name)?.value || ''; }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
function textOf(node) {
  if (node.nodeName === '#text') return node.value || '';
  return children(node).map(textOf).join('');
}
function tidy(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function findTag(node, name) {
  if (tag(node) === name) return node;
  for (const child of children(node)) {
    const found = findTag(child, name);
    if (found) return found;
  }
  return null;
}
function walk(node, fn) {
  fn(node);
  for (const child of children(node)) walk(child, fn);
}
function safeHref(value) {
  const href = String(value || '').trim();
  if (href.startsWith('#')) return href;
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : '';
  } catch (_) { return ''; }
}
function slug(value) {
  return tidy(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

function blocksFromHtml(html) {
  const root = parse5.parseFragment(html);
  const blocks = [];
  function ownLiText(node) {
    return tidy(children(node).filter((child) => !['ul', 'ol', 'p'].includes(tag(child))).map(textOf).join(''));
  }
  function visit(node) {
    const name = tag(node);
    if (/^h[2-6]$/.test(name)) {
      const text = tidy(textOf(node));
      if (text) blocks.push({ type: name, text });
    } else if (name === 'p' || name === 'th' || name === 'td') {
      const text = tidy(textOf(node));
      if (text) blocks.push({ type: name, text });
    } else if (name === 'li') {
      const text = ownLiText(node);
      if (text) blocks.push({ type: 'li', text });
    }
    for (const child of children(node)) visit(child);
  }
  visit(root);
  return blocks;
}

function normalizeExport(exportHtml) {
  const parsed = parse5.parse(String(exportHtml || ''));
  const body = findTag(parsed, 'body') || parsed;
  const headingRanks = [];
  walk(body, (node) => {
    if (/^h[1-6]$/.test(tag(node)) && tidy(textOf(node)).toLowerCase() !== 'boldiquette') {
      headingRanks.push(Number(tag(node)[1]));
    }
  });
  const firstRank = Math.min(...headingRanks);
  const seenIds = new Map();
  const toc = [];
  let skippedTitle = false;

  function render(node, parentTag = '') {
    if (node.nodeName === '#text') {
      const value = (node.value || '').replace(/\s+/g, ' ');
      return BLOCK_CONTAINERS.has(parentTag) && !value.trim() ? '' : escapeHtml(value);
    }
    const name = tag(node);
    if (!name && node.nodeName !== '#document' && node.nodeName !== '#document-fragment') return '';
    if (DROP.has(name)) return '';
    if (name === 'br' || name === 'hr') return `<${name}>`;
    const inside = children(node).map((child) => render(child, name)).join('');
    if (/^h[1-6]$/.test(name)) {
      const label = tidy(textOf(node));
      if (!label) return '';
      if (!skippedTitle && label.toLowerCase() === 'boldiquette') { skippedTitle = true; return ''; }
      const level = Math.min(6, Math.max(2, Number(name[1]) - firstRank + 2));
      const base = slug(label);
      const count = (seenIds.get(base) || 0) + 1;
      seenIds.set(base, count);
      const id = count === 1 ? base : `${base}-${count}`;
      if (level === 2) toc.push({ id, label });
      return `<h${level} id="${escapeHtml(id)}">${inside}</h${level}>`;
    }
    if (!ALLOWED.has(name)) return inside;
    if (name === 'a') {
      const href = safeHref(attr(node, 'href'));
      if (!href) return inside;
      const external = !href.startsWith('#');
      return `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inside}</a>`;
    }
    const cleanName = name === 'b' ? 'strong' : name === 'i' ? 'em' : name;
    const start = name === 'ol' && /^\d+$/.test(attr(node, 'start')) ? ` start="${attr(node, 'start')}"` : '';
    // Google Docs exports adjacent list levels as separate <ul> elements.
    // Retain only their numeric level; discard its generated CSS classes.
    const listMatch = (name === 'ul' || name === 'ol')
      && attr(node, 'class').match(/\blst-kix_[^\s]+-(\d+)\b/);
    const level = listMatch ? ` data-bold-list-level="${Math.min(6, Number(listMatch[1]))}"` : '';
    return `<${cleanName}${start}${level}>${inside}</${cleanName}>`;
  }

  const rendered = children(body).map((child) => render(child, tag(body))).join('');
  // The public export includes a cover page and its own long table of
  // contents. Our page already has both, so start at the first real section.
  const firstSection = rendered.indexOf('<h2 ');
  const html = firstSection < 0 ? rendered : rendered.slice(firstSection);
  const blocks = blocksFromHtml(html);
  if (blocks.length < 3 || !toc.length) throw new Error('Google Doc export has no usable BOLDiquette sections');
  if (Buffer.byteLength(JSON.stringify({ html, blocks, toc }), 'utf8') > 900_000) {
    throw new Error('Google Doc export exceeds the Firestore version size budget');
  }
  const hash = crypto.createHash('sha256').update(html).digest('hex');
  return { html, blocks, toc, hash };
}

async function fetchPublicGoogleDoc(docId, tabId = 't.0') {
  if (!/^[A-Za-z0-9_-]+$/.test(docId)) throw new Error('Invalid BOLDiquette document ID');
  if (!/^[A-Za-z0-9._-]+$/.test(tabId)) throw new Error('Invalid BOLDiquette tab ID');
  const url = new URL(`https://docs.google.com/document/d/${docId}/export`);
  url.searchParams.set('format', 'html');
  url.searchParams.set('tab', tabId);
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Public Google Doc export failed (${response.status})`);
  const html = await response.text();
  if (Buffer.byteLength(html, 'utf8') > 10_000_000) throw new Error('Public Google Doc export is too large');
  return html;
}

async function captureVersion(db, sourceHtml, sourceModifiedAt, now = Date.now()) {
  const version = normalizeExport(sourceHtml);
  const metaRef = db.collection('boldiquetteMeta').doc('current');
  const versionRef = db.collection('boldiquetteVersions').doc(version.hash);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(versionRef);
    if (!existing.exists) tx.set(versionRef, {
      ...version, sourceModifiedAt, capturedAt: now,
    });
    tx.set(metaRef, {
      latestVersion: version.hash, sourceModifiedAt, lastCheckedAt: now,
    }, { merge: true });
  });
  return version.hash;
}

async function syncGoogleDoc(db, docId, now = Date.now(), tabId = 't.0') {
  if (!docId) throw new Error('BOLDIQUETTE_DOC_ID is not configured');
  const metaRef = db.collection('boldiquetteMeta').doc('current');
  const metaSnap = await metaRef.get();
  const previous = metaSnap.exists && metaSnap.data();
  const html = await fetchPublicGoogleDoc(docId, tabId);
  const normalized = normalizeExport(html);
  if (previous?.latestVersion === normalized.hash) {
    await metaRef.set({ lastCheckedAt: now }, { merge: true });
    return { changed: false, version: previous.latestVersion };
  }
  const hash = await captureVersion(db, html, null, now);
  return { changed: !previous || previous.latestVersion !== hash, version: hash };
}

module.exports = { normalizeExport, blocksFromHtml, fetchPublicGoogleDoc, captureVersion, syncGoogleDoc };
