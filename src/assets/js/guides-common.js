// How-to guides — guides/{slug} in Firestore: { slug, title, description,
// parts: [{ id, title, body (Markdown, markdown.js) }], createdAt, createdBy,
// updatedAt, updatedBy, changeNote, proposedBy }. PIs/admins change a guide
// directly; anyone else's change is a proposal, guides/{slug}/proposals/{id}:
// { kind: 'about' | 'edit' | 'add' | 'remove', partId, before, after, note,
// by: { email, name }, at, status: 'open' | 'accepted' | 'declined',
// decidedBy, decidedAt }, which a PI/admin accepts (it's applied then) or
// declines (firestore.rules). Every change is kept in the guide's history
// (history.js). Shared by the guides page (guides.html) and a guide's page
// (guide.html?guide=<slug>).
window.BoldGuides = (function(){
  var NOT_PI = 'Only PIs and admins can do this';
  var SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  function slugify(s){
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  }
  function partId(){ return Math.random().toString(36).slice(2, 10); }
  function byTitle(a, b){ return (a.title || a.slug).localeCompare(b.title || b.slug); }

  // Whether the signed-in user is a PI/admin (getMyAccess); cb(bool).
  function access(cb){
    firebase.app().functions('europe-west2').httpsCallable('getMyAccess')().then(function(r){
      cb(!!(r.data && r.data.fullWrite));
    }).catch(function(err){ console.error('[BOLD Guides] access check failed', err); cb(false); });
  }

  return { NOT_PI: NOT_PI, SLUG: SLUG, slugify: slugify, partId: partId, byTitle: byTitle, access: access };
})();
