  const links = Array.from(document.querySelectorAll('nav.toc a'));
  const tl = Array.from(document.querySelectorAll('.timeline a'));
  const ids = links.map(a => a.getAttribute('href').slice(1));
  const TL_IDS = tl.map(a => a.getAttribute('href').slice(1));
  const sections = ids.map(id => document.getElementById(id));
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const pagerStatus = document.getElementById('pagerStatus');
  const layout = document.querySelector('.layout');

  // Rush mode's own phases, in order — matches RUSH_STATUS_ORDER in
  // audit-board.html exactly (Register, Abstract, Paper, Rebuttal), one
  // guide phase per real stage (2026-09-18+5: the standalone "Wait for
  // approval" phase is gone — its content moved into Submit the
  // abstract's own "How to review" section — so this list no longer has
  // an entry with nothing of its own to plot on the timeline).
  const RUSH_IDS = ['phase-1', 'phase-3', 'phase-4', 'phase-6'];
  // Post to arXiv — real, reachable, but not a numbered pipeline step
  // (optional, concurrent to Rebuttal, no gate of its own, and not part
  // of rush mode at all). Excluded from Previous/Next stepping and the
  // "Phase N of M" count via steppableIds() below, but still a normal
  // click from the TOC/a hash link — showPhase() itself doesn't care
  // which list an id came from.
  const OPTIONAL_IDS = ['phase-5'];
  const rushToggle = document.getElementById('rushToggle');
  const rushToggleLabel = document.getElementById('rushToggleLabel');
  const timelineList = document.getElementById('timelineList');

  function isRushView() { return document.body.classList.contains('rush-view'); }
  function isVisiblePhase(id) { return !isRushView() || RUSH_IDS.includes(id) || OPTIONAL_IDS.includes(id); }
  function visibleIds() { return ids.filter(isVisiblePhase); }
  function steppableIds() { return visibleIds().filter(id => !OPTIONAL_IDS.includes(id)); }

  function applyRushView(on) {
    document.body.classList.toggle('rush-view', on);
    rushToggle.setAttribute('aria-checked', on ? 'true' : 'false');
    rushToggleLabel.textContent = on
      ? 'Rush mode — showing 4 of 7 phases'
      : 'Full pipeline — show only Rush mode’s 4 phases';
    // Keeps the timeline's connecting line ending at the first/last
    // VISIBLE dot (see .timeline ol::before's own calc(50% / var(--n))) —
    // hiding li's via CSS doesn't shrink this on its own. TL_IDS (not ids)
    // for the full-pipeline count, since Post to arXiv is TOC-only; for
    // rush, RUSH_IDS.length directly now (2026-09-18+5) — every RUSH_IDS
    // entry has its own timeline dot since Wait for approval was folded
    // into Submit the abstract, so there's no longer a TOC-only entry to
    // exclude the way Post to arXiv still is on the full-pipeline side.
    timelineList.style.setProperty('--n', on ? RUSH_IDS.length : TL_IDS.length);
    try { localStorage.setItem('boldGuideRushView', on ? '1' : '0'); } catch (e) {}
    // Already sitting on a phase Rush mode doesn't have — land on
    // Register instead of leaving the pager stuck on a hidden phase.
    if (!isVisiblePhase(currentId())) showPhase(RUSH_IDS[0]);
  }

  rushToggle.addEventListener('click', () => applyRushView(!isRushView()));

  function showPhase(id, { pushHistory = true, scroll = true } = {}) {
    const idx = ids.indexOf(id);
    if (idx === -1) return;

    sections.forEach(s => s.classList.toggle('active', s.id === id));
    links.forEach(l => {
      const isActive = l.getAttribute('href') === '#' + id;
      l.classList.toggle('active', isActive);
      if (isActive) { l.setAttribute('aria-current', 'page'); }
      else { l.removeAttribute('aria-current'); }
    });
    tl.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));

    // Numbered against whichever phases are actually steppable right now
    // (4 in Rush view, 7 otherwise) — Post to arXiv is real and visible
    // but isn't part of this count at all, same reasoning as the "Phase 2
    // of 8" one this replaced: don't count what isn't actually a step.
    const vis = steppableIds();
    const visIdx = vis.indexOf(id);
    if (visIdx === -1) {
      pagerStatus.textContent = 'Optional — not part of the numbered pipeline';
      prevBtn.disabled = true;
      nextBtn.disabled = true;
    } else {
      pagerStatus.textContent = `Phase ${visIdx + 1} of ${vis.length}`;
      prevBtn.disabled = visIdx <= 0;
      nextBtn.disabled = visIdx >= vis.length - 1;
    }

    if (pushHistory && location.hash !== '#' + id) {
      history.pushState({ phase: id }, '', '#' + id);
    }
    if (scroll && layout && typeof layout.scrollIntoView === 'function') {
      layout.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  links.concat(tl).forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      showPhase(link.getAttribute('href').slice(1));
    });
  });

  // Step to the next/previous STEPPABLE phase, not just the adjacent
  // array entry — in Rush view, Next from Register goes straight to
  // Abstract, skipping the hidden Pitch in between; in any view, Next
  // from Submit the paper skips over the optional Post to arXiv page
  // straight to Submit rebuttal.
  prevBtn.addEventListener('click', () => {
    const vis = steppableIds();
    const idx = vis.indexOf(currentId());
    if (idx > 0) showPhase(vis[idx - 1]);
  });
  nextBtn.addEventListener('click', () => {
    const vis = steppableIds();
    const idx = vis.indexOf(currentId());
    if (idx !== -1 && idx < vis.length - 1) showPhase(vis[idx + 1]);
  });

  function currentId() {
    const active = sections.find(s => s.classList.contains('active'));
    return active ? active.id : ids[0];
  }

  window.addEventListener('popstate', () => {
    const id = location.hash.slice(1);
    showPhase(ids.includes(id) ? id : ids[0], { pushHistory: false, scroll: false });
  });

  let savedRushView = false;
  try { savedRushView = localStorage.getItem('boldGuideRushView') === '1'; } catch (e) {}
  applyRushView(savedRushView);

  let startId = ids.includes(location.hash.slice(1)) ? location.hash.slice(1) : ids[0];
  if (!isVisiblePhase(startId)) startId = RUSH_IDS[0];
  showPhase(startId, { pushHistory: false, scroll: false });
