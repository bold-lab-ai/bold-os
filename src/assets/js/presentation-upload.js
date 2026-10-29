// Upload a presentation's file (slides, a poster, a PDF) to the lab's Google Drive and
// put its link in the field: a project's presentation (pages/project.js), a talk
// (pages/talk.js) and a keynote's or oral's talk (pages/session.js). The server opens an
// upload to Drive (presentationFile), the browser sends the file there itself, then the
// server makes it viewable by anyone with the link and returns that link. Saving the form
// saves it.
//
// BoldPresentationUpload.html(cls) → the line under the field (cls: the page's hint class);
// .wire(line, { args() → { project } | { talk }, input, busy(on) }).
window.BoldPresentationUpload = (function(){
  function html(cls){
    return '<p class="' + (cls || '') + ' pu-line"><button type="button" class="btn-text pu-btn">Upload a file</button> to the lab’s Google Drive (anyone with the link can view it)' +
      '<input type="file" class="pu-file" hidden><span class="pu-msg"></span></p>';
  }
  function wire(line, o){
    if (!line) return;
    var btn = line.querySelector('.pu-btn'), file = line.querySelector('.pu-file'), msg = line.querySelector('.pu-msg');
    var call = function(more){ return firebase.app().functions('europe-west2').httpsCallable('presentationFile')(Object.assign(o.args(), more)); };
    var say = function(t){ msg.textContent = t ? ' · ' + t : ''; };
    var busy = function(on){ btn.disabled = on; if (o.busy) o.busy(on); };
    btn.addEventListener('click', function(){ file.click(); });
    file.addEventListener('change', function(){
      var f = file.files && file.files[0];
      if (!f) return;
      // A file anyone with its link can open: asked every time (the ground rule).
      BOLD.confirmAction({ title: 'Upload ' + f.name + '?', go: 'Upload it', always: true,
        effects: ['Put it on the lab’s Google Drive, where anyone with the link can open it'] }).then(function(ok){
        if (ok) upload(f); else file.value = '';
      });
    });
    function upload(f){
      busy(true); say('Starting…');
      call({ name: f.name, type: f.type, size: f.size }).then(function(r){
        return new Promise(function(ok, no){
          var x = new XMLHttpRequest();
          x.open('PUT', r.data.url);
          x.upload.onprogress = function(e){ if (e.lengthComputable) say('Uploading ' + Math.round(100 * e.loaded / e.total) + '%'); };
          x.onload = function(){ var j = null; try { j = JSON.parse(x.responseText); } catch (e){} if (x.status < 300 && j && j.id) ok(j.id); else no(new Error('Google Drive said ' + x.status + '.')); };
          x.onerror = function(){ no(new Error('The upload didn’t go through.')); };
          x.send(f);
        });
      }).then(function(id){ say('Sharing…'); return call({ file: id }); }).then(function(r){
        o.input.value = r.data.url;
        o.input.dispatchEvent(new Event('input', { bubbles: true }));
        say('Uploaded ' + f.name + ': save to keep it');
      }).catch(function(err){
        console.error('[BOLD] uploading a presentation file failed', err);
        say(err && err.message && err.code !== 'functions/internal' ? err.message : 'Couldn’t upload it — try again.');
      }).then(function(){ busy(false); file.value = ''; });
    }
  }
  return { html: html, wire: wire };
})();
