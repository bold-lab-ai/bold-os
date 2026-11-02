// The Projects page's join button, as one plain function (no DOM, no Firebase), so it can be
// tested (tests/projects-join.test.cjs): a project the viewer is already on (`joined`, from
// getAllProjects) says so, greyed out, instead of offering to join it again. Below Projects' View
// (BOLD-associate, PAN-BOLD: `ask`), it asks to join, and the owner accepts; `asked`: waiting on them;
// `invited`: an invitation of theirs to answer (on the project's page).
(function(root){
  root.BoldProjectJoin = {
    joinState: function(p){
      if (p && p.joined) return { label: 'Joined', disabled: true, title: 'You’re on this project' };
      if (p && p.invited) return { label: 'You’re invited', disabled: false, title: 'Join it or decline, on its page', invite: p.invited };
      if (p && p.asked) return { label: 'Asked', disabled: true, title: 'Its owner decides' };
      if (p && p.ask) return { label: 'Ask to join', disabled: false, title: 'Its owner decides', ask: true };
      return { label: 'Join the project', disabled: false, title: '' };
    }
  };
})(this);
