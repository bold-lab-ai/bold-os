// Topic names and icons are stored in Firestore. These are the five initial records
// installed by the migration. This module is also served as a classic script.
const ConversationTopics = (function(){
  const starters = [
    { id: 'about-bold', name: 'About BOLD', icon: '◎' },
    { id: 'bold-os-feedback', name: 'BOLD.OS feedback', icon: '⚙' },
    { id: 'research-brainstorms', name: 'Research brainstorms', icon: '✦' },
    { id: 'project-proposals', name: 'Project proposals', icon: '⚑' },
    { id: 'advice', name: 'Advice', icon: '☏' },
  ];
  function topicId(name){
    return String(name).trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  }
  function suggestIcon(name){
    const words = topicId(name);
    if (/research|idea|brainstorm/.test(words)) return '✦';
    if (/project|proposal|plan/.test(words)) return '⚑';
    if (/feedback|tool|software/.test(words)) return '⚙';
    if (/advice|help|support/.test(words)) return '☏';
    if (/paper|read|book/.test(words)) return '▤';
    if (/meeting|event/.test(words)) return '◷';
    return '◎';
  }
  async function exists(db, id){
    return typeof id === 'string' && id.length <= 180 && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id)
      && (await db.collection('conversationTopics').doc(id).get()).exists;
  }
  return { starters, topicId, suggestIcon, exists };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ConversationTopics;
