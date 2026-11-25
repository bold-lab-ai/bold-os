// A paper submitted for internal review can describe work completed before BOLD.OS.
// It is a venue card, with no project workspace or compute approval.
const makeRegisteredCard = require('./make-registered-card');
const isPastPaper = card => card?.registrationKind === 'past_paper';

// The venue card is the source of the current paper title and problem link.
function papersByProblem(boards, cards) {
  const venues = new Map(boards.filter(b => !b.archived && (b.status || 'approved') === 'approved')
    .map(b => [b.id,b.label || b.id]));
  const papers = new Map();
  for (const {boardId,id,data} of cards) {
    if (!isPastPaper(data) || !data.openProblemId || !venues.has(boardId)) continue;
    if (!papers.has(data.openProblemId)) papers.set(data.openProblemId,[]);
    papers.get(data.openProblemId).push({id, board:boardId, venue:venues.get(boardId), title:data.title || 'Untitled paper'});
  }
  for (const rows of papers.values())
    rows.sort((a,b) => a.title.localeCompare(b.title) || a.venue.localeCompare(b.venue) || a.board.localeCompare(b.board) || a.id.localeCompare(b.id));
  return papers;
}

async function registerPastPaper({db, error, fingerprint}, data, email, name) {
  const keys = ['action','request_id','board','problem_id','title','compute_estimate','note'];
  if (Object.keys(data).some(key => !keys.includes(key)))
    throw error('invalid-argument','Supply only the paper title, venue, open problem, compute estimate and note.');
  if (typeof data.request_id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(data.request_id))
    throw error('invalid-argument','Supply a registration request ID.');
  if (typeof data.board !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(data.board))
    throw error('invalid-argument','Choose an approved venue.');
  if (typeof data.problem_id !== 'string' || !/^ak-[a-f0-9]{24}$/.test(data.problem_id))
    throw error('invalid-argument','Choose an active Problem Bank problem.');
  function field(key, limit, required = false) {
    const raw = data[key] === undefined ? '' : data[key];
    if (typeof raw !== 'string' || raw.trim().length > limit || (required && !raw.trim()))
      throw error('invalid-argument','Supply '+key.replace('_',' ')+' within '+limit+' characters.');
    return raw.trim();
  }
  const fields = {title:field('title',300,true), computeEstimate:field('compute_estimate',500), note:field('note',4000)};
  const id = 'paper-' + fingerprint(['past_paper',email,data.request_id]).slice(0,24);
  const hash = fingerprint([data.board,data.problem_id,fields]);
  const result = {card_id:id,board:data.board};
  const receipt = db.collection('paperRegistrationReceipts').doc(id);
  const venue = db.collection('boards').doc(data.board);
  const card = venue.collection('cards').doc(id);
  const problem = db.collection('problemBank').doc(data.problem_id);
  return db.runTransaction(async tx => {
    const [saved,board,question,existing] = await Promise.all([receipt,venue,problem,card].map(ref=>tx.get(ref)));
    if (saved.exists) {
      if (saved.data().hash !== hash) throw error('already-exists','This request already registered a different paper.');
      if (!existing.exists) throw error('not-found','This registered paper was removed.');
      return result;
    }
    if (existing.exists) throw error('already-exists','A paper with that ID already exists.');
    if (!board.exists || board.data().archived || (board.data().status || 'approved') !== 'approved')
      throw error('failed-precondition','The selected venue is no longer available. Choose an approved venue.');
    if (!question.exists || question.data().archived || !question.data().title)
      throw error('failed-precondition','The selected problem is no longer available. Choose an active problem.');
    const row = makeRegisteredCard({email,name:name || email},fields,Date.now());
    delete row.id;
    tx.set(card,{...row,registrationKind:'past_paper',openProblemId:question.id,openProblemTitle:question.data().title});
    tx.set(receipt,{hash});
    return result;
  });
}
module.exports = {isPastPaper,registerPastPaper,papersByProblem};
