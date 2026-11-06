// Conversations (conversations.html): the forum (conversations-forum.js), all of it.
(function(){
  var mount = document.getElementById('bsMount');
  if (mount && window.BoldConversations) mount.appendChild(BoldConversations.create({}).el);
})();
