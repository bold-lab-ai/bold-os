// A contribution points from a narrower problem to a broader problem or objective.
// Related problems share one undirected edge. Edges survive archiving so restoration
// and audit do not depend on reconstructing a previous version of a problem.
const crypto = require('node:crypto');
const PROBLEM_ID = /^ak-[a-f0-9]{24}$/;
const MOON_ID = /^moon-[a-f0-9]{24}$/;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const PILLARS = new Map([['BP','Beyond Backpropagation'], ['HCLD','Human-Centric Learning & Discovery'], ['EL','Embodied Learning']]);
const SOURCE = 'boldiquette.html#afchbwgz';
const CONTRIBUTES = 'contributes_to';
const RELATED = 'related_to';
const isPillar = id => [...PILLARS.keys()].some(key => id === 'pillar-' + key.toLowerCase());
const edgeId = edge => [edge.kind, edge.from, edge.to].join('_');
const same = (a,b) => a.length === b.length && a.every((id,i) => id === b[i]);
const equalSelection = (a,b) => same(a.parents,b.parents) && same(a.related,b.related);

function pillarRows(handbook){
  const parts = handbook?.parts || [];
  const section = parts.find(p => p.id === 'afchbwgz');
  const titles = new Map(PILLARS);
  // Stable pillar IDs follow the BOLDiquette's abbreviations, even when the section
  // is reordered or a title changes. Demo handbooks can omit the research section.
  for (const match of String(section?.body || '').matchAll(/^\s*[-*]?\s*(?:\d+[.)]\s*)?([^\n:]+?)\s+\((BP|HCLD|EL)\)\s*\**:/gm)) {
    titles.set(match[2], match[1].replace(/\*/g,'').trim());
  }
  return [...titles].map(([key,title]) => ({ id:'pillar-' + key.toLowerCase(), title, kind:'pillar', archived:false, source_url:SOURCE }));
}
function selectionFrom(edges, id){
  const parents = [], related = [];
  for (const e of edges) {
    if (e.kind === CONTRIBUTES && e.from === id) parents.push(e.to);
    if (e.kind === RELATED && (e.from === id || e.to === id)) related.push(e.from === id ? e.to : e.from);
  }
  return {parents:parents.sort(), related:related.sort()};
}
function edgesFor(family, id){
  return family.parents.map(to => ({kind:CONTRIBUTES,from:id,to})).concat(family.related.map(peer => {
    const [from,to] = [id,peer].sort();
    return {kind:RELATED,from,to};
  }));
}
function closesCycle(edges, id, parents){
  const upward = new Map();
  for (const e of edges) {
    if (e.kind !== CONTRIBUTES || e.from === id) continue;
    if (!upward.has(e.from)) upward.set(e.from, []);
    upward.get(e.from).push(e.to);
  }
  const todo = parents.slice(), visited = new Set();
  while (todo.length) {
    const next = todo.pop();
    if (next === id) return true;
    if (visited.has(next)) continue;
    visited.add(next);
    for (const ancestor of upward.get(next) || []) todo.push(ancestor);
  }
  return false;
}

module.exports = function problemFamily(db, error){
  const objectives = db.collection('problemObjectives'), relations = db.collection('problemRelationships');
  const state = db.collection('problemFamilyState').doc('graph');
  const problems = db.collection('problemBank');
  const publicEdges = snap => snap.docs.map(d => {
    const {from,to,kind} = d.data(); return {from,to,kind};
  });
  async function list(full){
    const [handbook, goals, nodes, links] = await Promise.all([
      db.collection('handbook').doc('boldiquette').get(), objectives.get(), problems.select('title','stage','archived','builds_benchmark').get(), relations.select('from','to','kind').get()
    ]);
    return {
      objectives: pillarRows(handbook.data()).concat(goals.docs.map(doc => ({id:doc.id,kind:'moonshot',title:doc.data().title,archived:!!doc.data().archived}))),
      problems: nodes.docs.map(doc => ({id:doc.id,title:doc.data().title,stage:doc.data().stage || 'open',builds_benchmark:doc.data().builds_benchmark === true,archived:!!doc.data().archived})),
      edges: publicEdges(links), can_manage_objectives: full
    };
  }
  function normalize(family, id){
    if (!family || !Array.isArray(family.parents) || !Array.isArray(family.related) || Object.keys(family).some(k => k !== 'parents' && k !== 'related'))
      throw error('invalid-argument', 'Supply the broader objectives or problems and the related problems.');
    const {parents,related} = family;
    if (parents.some(p => typeof p !== 'string' || !(PROBLEM_ID.test(p) || MOON_ID.test(p) || isPillar(p))) || related.some(p => typeof p !== 'string' || !PROBLEM_ID.test(p)))
      throw error('invalid-argument', 'Select a problem or objective from the family tree.');
    const all = parents.concat(related);
    if (all.includes(id)) throw error('invalid-argument','A problem cannot link to itself.');
    if (new Set(all).size !== all.length) throw error('invalid-argument','Choose each problem or objective only once.');
    return { parents:parents.slice().sort(), related:related.slice().sort() };
  }
  // The revision document serializes edge writes including cases where two new edges
  // on different documents would together introduce a cycle. Read targets in the
  // transaction as well, so archiving a target cannot race the creation of an edge.
  async function replace(tx, id, desired, expected, actor, at){
    const [version, edgeSnap] = await Promise.all([tx.get(state), tx.get(relations.select('from','to','kind'))]);
    const edges = publicEdges(edgeSnap), before = selectionFrom(edges,id);
    if (equalSelection(before,desired)) return null;
    if (expected && !equalSelection(before,expected)) throw error('aborted','The family links changed. Reload this problem before saving.');
    const prior = new Map(edgesFor(before,id).map(e => [edgeId(e),e]));
    const after = new Map(edgesFor(desired,id).map(e => [edgeId(e),e]));
    const added = [...after].filter(([key]) => !prior.has(key));
    const removed = [...prior].filter(([key]) => !after.has(key));
    // A problem can accumulate related links from other editors. Limit the writes
    // in this transaction, rather than the number already attached to the node.
    if (added.length > 100 || added.length + removed.length > 400)
      throw error('invalid-argument','Save at most 100 new links or 400 total link changes at a time.');
    const newTargets = added.map(([,e]) => e.from === id ? e.to : e.from).filter(target => !isPillar(target));
    const targets = await Promise.all(newTargets.map(target => tx.get((MOON_ID.test(target) ? objectives : problems).doc(target))));
    if (targets.some(doc => !doc.exists || doc.data().archived)) throw error('failed-precondition','A selected problem or objective is no longer active. Reload the choices.');
    if (closesCycle(edges,id,desired.parents)) throw error('failed-precondition','This link would make a problem its own ancestor. Choose a different broader problem.');
    // A peer may already have named this problem as a parent. This also prevents an
    // undirected relationship and a direct contribution between the same pair.
    const children = new Set(edges.filter(e => e.kind === CONTRIBUTES && e.to === id).map(e => e.from));
    if (desired.related.some(peer => children.has(peer)))
      throw error('invalid-argument','A broader or narrower problem already has a direct family link.');
    for (const [key,edge] of added) tx.set(relations.doc(key), {...edge,createdBy:actor,createdAt:at});
    for (const [key] of removed) tx.delete(relations.doc(key));
    tx.set(state,{revision:(version.exists ? version.data().revision : 0)+1});
    return {before,after:desired};
  }
  async function setFamily(d, email, canEdit){
    if (typeof d.problem_id !== 'string' || !PROBLEM_ID.test(d.problem_id)) throw error('invalid-argument','Supply the problem ID.');
    const id = d.problem_id, desired = normalize(d.family,id), previous = normalize(d.previous,id), ref = problems.doc(id);
    return db.runTransaction(async tx => {
      const problem = await tx.get(ref);
      if (!problem.exists) throw error('not-found','This problem does not exist.');
      if (!canEdit(problem)) throw error('permission-denied','Only whoever added the problem, a PI or an admin can edit its links.');
      if (problem.data().archived) throw error('failed-precondition','Restore this problem before editing its links.');
      const at = Date.now(), change = await replace(tx,id,desired,previous,email,at);
      if (change) {
        const stamp = {updatedAt:at,updatedBy:email};
        tx.update(ref,stamp);
        tx.set(ref.collection('versions').doc(crypto.randomUUID()),{...problem.data(),...stamp,changeNote:'Updated family links',familyChange:change});
      }
      return {ok:true};
    });
  }
  async function saveMoonshot(d, email, full){
    if (!full) throw error('permission-denied','Only a PI or admin can manage moonshots.');
    const creating = d.objective_id === undefined;
    if (!creating && (typeof d.objective_id !== 'string' || !MOON_ID.test(d.objective_id))) throw error('invalid-argument','Select a moonshot to edit.');
    if (d.request_id !== undefined && (typeof d.request_id !== 'string' || !UUID.test(d.request_id))) throw error('invalid-argument','Supply a valid request ID.');
    if (d.title !== undefined && (typeof d.title !== 'string' || !d.title.trim() || d.title.trim().length > 180)) throw error('invalid-argument','Give the moonshot a title of up to 180 characters.');
    if (d.archived !== undefined && typeof d.archived !== 'boolean') throw error('invalid-argument','Supply the archive choice.');
    if (creating && (!d.title || d.archived) || !creating && d.title === undefined && d.archived === undefined) throw error('invalid-argument','Supply the moonshot title or archive choice.');
    const title = d.title?.trim();
    const id = creating ? 'moon-' + crypto.createHash('sha256').update(email + ':' + (d.request_id || crypto.randomUUID())).digest('hex').slice(0,24) : d.objective_id;
    const ref = objectives.doc(id), at = Date.now();
    return db.runTransaction(async tx => {
      const doc = await tx.get(ref), was = doc.data();
      if (creating && doc.exists) {
        if (was.initialTitle !== title) throw error('already-exists','This request already created a different moonshot.');
        return {objective_id:id};
      }
      if (!creating && !doc.exists) throw error('not-found','This moonshot does not exist.');
      const next = {title:title ?? was.title,archived:d.archived ?? was?.archived ?? false};
      if (creating || next.title !== was.title || next.archived !== was.archived) {
        tx.set(ref,{...(was || {createdBy:email,createdAt:at,initialTitle:title}),...next,updatedBy:email,updatedAt:at});
        tx.set(ref.collection('versions').doc(crypto.randomUUID()),{...next,updatedBy:email,updatedAt:at});
      }
      return {objective_id:id};
    });
  }
  return {list,normalize,replace,setFamily,saveMoonshot};
};
