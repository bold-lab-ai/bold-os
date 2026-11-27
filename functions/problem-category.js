// A problem's category, for the server and the pages (copied to assets/js/problem-category.js by eleventy.config.js):
// change it here only, and keep it plain ES5 with no dependencies.
//   method         a research problem whose solutions are scored: it needs a verifier (AutoKaggle Lite)
//   benchmark      building the benchmark is the goal: it is its own verifier
//   open_question  an observation or a high-level idea to follow: nothing to score yet, so no verifier; it keeps
//                  its inspiration instead
// A problem saved before categories has only builds_benchmark: true is a benchmark, anything else a method.
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoldProblemCategory = factory();
})(typeof window !== 'undefined' ? window : this, function(){
  'use strict';
  var LIST = ['method', 'benchmark', 'open_question'];
  var LABELS = { method: 'Method', benchmark: 'Benchmark', open_question: 'Open question' };
  var HINTS = {
    method: 'The result is a solution to a research problem, scored by a verifier. Using a benchmark to measure another result is a method too.',
    benchmark: 'The result is the benchmark itself. It needs no separate verifier.',
    open_question: 'The result is an answer to an observation or a high-level idea. There is nothing to score yet, so it needs no verifier.'
  };
  function of(p){
    p = p || {};
    return LIST.indexOf(p.category) >= 0 ? p.category : p.builds_benchmark === true ? 'benchmark' : 'method';
  }
  function needsVerifier(p){ return of(p) === 'method'; }
  function label(p){ return LABELS[of(p)]; }
  // What a request chose: its category, or the builds_benchmark of an older page or agent. '' when it says neither;
  // throws when it is not a category, or the two disagree.
  function chosen(category, buildsBenchmark){
    if (buildsBenchmark !== undefined && typeof buildsBenchmark !== 'boolean') throw new Error('Choose whether this problem builds a benchmark.');
    if (category === undefined || category === null || category === '') return buildsBenchmark === undefined ? '' : buildsBenchmark ? 'benchmark' : 'method';
    if (LIST.indexOf(category) < 0) throw new Error('Choose the problem’s category: method, benchmark or open_question.');
    if (buildsBenchmark !== undefined && buildsBenchmark !== (category === 'benchmark')) throw new Error('The category and the benchmark choice disagree.');
    return category;
  }
  return { LIST: LIST, LABELS: LABELS, HINTS: HINTS, of: of, needsVerifier: needsVerifier, label: label, chosen: chosen };
});
