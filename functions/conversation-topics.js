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
  // Lab vocabulary supplements the site's named emoji. Match whole words so "planet" doesn't match "plan".
  const keywords = new Map();
  for (const [icon, names] of [
    ['🦋', 'butterfly'], ['🧠', 'research idea brainstorm neuroscience'],
    ['📄', 'project proposal plan planning document file'], ['⚙️', 'feedback tool software'],
    ['☎️', 'advice help support'], ['📖', 'paper read reading book journal journal_club'],
    ['🕒', 'meeting event'], ['🤖', 'ai robotics machine_learning artificial_intelligence'],
    ['💻', 'code coding programming compute gpu'], ['📊', 'data statistics analytics'],
    ['🔬', 'science experiment microscopy'], ['✈️', 'travel travelling'], ['🥾', 'hiking hike'],
    ['☕', 'coffee cafe'], ['🌍', 'climate sustainability'], ['🧬', 'genetics genomics biology']
  ]) {
    for (const word of names.split(' ')) keywords.set(word, icon);
  }
  const genericWords = new Set('a an and at bold club discussion discussions for group in of on our the to topic topics'.split(' '));
  function suggestIcon(name, emojiNames){
    const id = topicId(name);
    if (!id) return '💬';
    const starter = starters.find(topic => topic.id === id);
    if (starter) return starter.icon;
    const words = id.split('-');
    const lookup = key => keywords.get(key) || emojiNames?.get(key);
    // Prefer a named phrase ("polar bear") to one of its individual words.
    for (let size = words.length; size > 0; size--) {
      for (let i = 0; i + size <= words.length; i++) {
        const phrase = words.slice(i, i + size).join('_');
        if (genericWords.has(phrase)) continue;
        const icon = lookup(phrase) || lookup(phrase.replace(/ies$/, 'y').replace(/s$/, ''));
        if (icon) return icon;
      }
    }
    // Unfamiliar names still get a repeatable, neutral topic marker.
    const markers = ['💬', '💭', '📌', '🔖', '🗂️', '🏷️'];
    let hash = 0;
    for (const char of id) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
    return markers[hash % markers.length];
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
