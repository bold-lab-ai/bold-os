// Topic changes that need to see all conversations, including private ones.
const { HttpsError } = require('firebase-functions/v2/https');
const { topicId, starters } = require('./conversation-topics');

function topicRef(db, id){
  if (typeof id !== 'string' || id.length > 180 || !/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id)) {
    throw new HttpsError('invalid-argument', 'Choose a conversation topic.');
  }
  return db.collection('conversationTopics').doc(id);
}

// Keep the topic and the first conversation in the same transaction. Concurrent
// submissions with the same name reuse whichever icon and spelling were saved first.
async function withTopic(db, id, draft, writeConversation){
  const ref = topicRef(db, id);
  await db.runTransaction(async tx => {
    if (!(await tx.get(ref)).exists) {
      if (!draft || typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 60 ||
          topicId(draft.name) !== id || typeof draft.icon !== 'string' || !draft.icon.trim() || [...draft.icon].length > 16) {
        throw new HttpsError('invalid-argument', 'Choose a conversation topic.');
      }
      tx.create(ref, { name: draft.name.trim(), icon: draft.icon });
    }
    writeConversation(tx);
  });
}

async function removeEmpty(db, id){
  const ref = topicRef(db, id);
  if (starters.some(t => t.id === id)) throw new HttpsError('failed-precondition', 'Starter topics are kept for everyone.');
  await db.runTransaction(async tx => {
    if (!(await tx.get(ref)).exists) return;
    const inUse = await tx.get(db.collection('conversations').where('topicId', '==', id).limit(1));
    if (!inUse.empty) throw new HttpsError('failed-precondition', 'Only empty topics can be removed.');
    tx.delete(ref);
  });
}

module.exports = { withTopic, removeEmpty };
