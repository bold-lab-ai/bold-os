// The Projects page's join button, as one plain function (no DOM, no Firebase), so it can be
// tested (tests/projects-join.test.cjs): a project the viewer is already on (`joined`, from
// getAllProjects) says so, greyed out, instead of offering to join it again. Below Projects' View
// (BOLD-associate: `ask`), it asks to join, and the owner accepts; PAN-BOLD (`talk`) talks to the owner on
// Slack first, who adds them; `asked`: waiting on them;
// `invited`: an invitation of theirs to answer (on the project's page).
(function(root){
  root.BoldProjectJoin = {
    joinState: function(p){
      if (p && p.joined) return { label: 'Joined', disabled: true, title: 'You’re on this project' };
      if (p && p.invited) return { label: 'You’re invited', disabled: false, title: 'Join it or decline, on its page', invite: p.invited };
      // PAN-BOLD: a conversation with its owner first, who adds them (2026-11-03).
      if (p && p.talk) return { label: 'Talk to the lead', disabled: false, title: 'A Slack message to ' + (p.talk.name || 'the lead') + ': they add you if it fits', talk: p.talk };
      if (p && p.asked) return { label: 'Asked', disabled: true, title: 'Its owner decides' };
      if (p && p.ask) return { label: 'Ask to join', disabled: false, title: 'Its owner decides', ask: true };
      return { label: 'Join the project', disabled: false, title: '' };
    }
  };
})(this);
