// Topic names and icons are stored in Firestore. These are the five initial records
// installed by the migration. This module is also served as a classic script.
const ConversationTopics = (function(){
  const starters = [
    { id: 'about-bold', name: 'About BOLD', icon: '🦋' },
    { id: 'bold-os-feedback', name: 'BOLD.OS feedback', icon: '⚙️' },
    { id: 'research-brainstorms', name: 'Research brainstorms', icon: '🧠' },
    { id: 'project-proposals', name: 'Project proposals', icon: '📄' },
    { id: 'advice', name: 'Advice', icon: '☎️' },
  ];
  function topicId(name){
    return String(name).trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  }
  function suggestIcon(name){
    const words = topicId(name);
    if (words === 'about-bold' || words.includes('butterfly')) return '🦋';
    if (/research|idea|brainstorm/.test(words)) return '🧠';
    if (/project|proposal|plan|document|file/.test(words)) return '📄';
    if (/feedback|tool|software/.test(words)) return '⚙️';
    if (/advice|help|support/.test(words)) return '☎️';
    if (/paper|read|book/.test(words)) return '📖';
    if (/meeting|event/.test(words)) return '🕒';
    return '💬';
  }
  // Older topics allowed a free-text icon. Keep their meaning when showing them in the picker or API.
  const oldIcons = new Map([['◎', '💬'], ['☏', '☎️'], ['⚙', '⚙️'], ['✦', '🧠'], ['⚑', '📄'],
    ['whiteboard', '📄'], ['▤', '📖'], ['◷', '🕒'], ['★', '⭐']]);
  function fromDoc(doc){
    const { name, icon } = doc.data();
    let emoji = oldIcons.get(icon);
    if (!emoji && typeof icon === 'string' && !/[\p{L}\s]/u.test(icon) && /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(icon)) {
      // Text-default emoji such as a gear need the emoji presentation selector.
      emoji = /^\p{Extended_Pictographic}$/u.test(icon) && !/\p{Emoji_Presentation}/u.test(icon) ? icon + '\uFE0F' : icon;
    }
    return { id: doc.id, name, icon: emoji || suggestIcon(name) };
  }
  async function exists(db, id){
    return typeof id === 'string' && id.length <= 180 && /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id)
      && (await db.collection('conversationTopics').doc(id).get()).exists;
  }
  return { starters, topicId, suggestIcon, fromDoc, exists };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ConversationTopics;
