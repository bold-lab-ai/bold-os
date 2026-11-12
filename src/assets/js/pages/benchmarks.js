(function(){
  'use strict';
  var root=document.getElementById('registry');
  if(!root || !BOLD.getAuth())return;
  var el=function(id){return document.getElementById(id);}, esc=BOLD.escapeHtml;
  var kind=root.dataset.kind, rows=[], cursor=null, generation=0, signedIn=false, busy=false;
  var call=firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry');
  function status(message,error){el('registryStatus').textContent=message;el('registryStatus').dataset.error=!!error;}
  function date(value){var d=new Date(value);return isNaN(d)?'Not recorded':d.toLocaleString();}
  function external(href,label){return '<a target="_blank" rel="noopener" href="'+esc(href)+'">'+esc(label)+' ↗</a>';}
  function facts(values){return '<dl class="registry-facts">'+values.map(function(x){return '<dt>'+esc(x[0])+'</dt><dd>'+esc(String(x[1]))+'</dd>';}).join('')+'</dl>';}
  function render(){
    var q=el('registrySearch').value.toLowerCase().trim(), archived=el('registryArchived');
    var shown=rows.filter(function(r){return (!r.archived || (archived&&archived.checked)) && [r.title,r.objective,r.task_kind,(r.evaluator||{}).commit].join(' ').toLowerCase().indexOf(q)!==-1;});
    el('registryList').innerHTML=shown.map(function(r){var e=r.evaluator, id=r.problem_id||r.id;
      return '<article class="registry-card"><h2><a href="'+kind+'.html?problem='+encodeURIComponent(id)+'">'+esc(r.title)+'</a></h2><p class="registry-meta">'+esc(r.task_kind)+' · Version '+esc(String(e?e.version:r.latest_version))+(r.archived?' · Archived':'')+'</p>'+
        (e?'<p>Research data checked · Human approved</p><p class="registry-meta">Commit '+esc(e.commit.slice(0,12))+'</p>':'<p>'+esc(r.objective)+'</p>')+'</article>';
    }).join('');
    el('registryMore').hidden=!cursor;el('registryMore').disabled=busy;
    status(shown.length?shown.length+' shown. '+rows.length+' loaded.':rows.length?'No matching records in the loaded results.':'No records yet. Complete research-data validation and approval in AutoKaggle to register a release.');
  }
  async function load(more){
    if(!signedIn||busy)return;busy=true;var epoch=generation;el('registryRetry').hidden=true;status('Loading…');
    try{var r=(await call({action:'list',kind:kind,cursor:more?cursor:null})).data;if(epoch!==generation)return;
      rows=more?rows.concat(r.items):r.items;cursor=r.cursor;render();
    }catch(e){if(epoch===generation){status('Could not load records. '+(e.message||'Please retry.'),true);el('registryRetry').hidden=false;}}
    finally{if(epoch===generation){busy=false;el('registryMore').disabled=false;}}
  }
  function release(r){var e=r.evaluator,v=r.research,a=r.approval;
    return '<article class="registry-release"><h3>Evaluator version '+esc(String(e.version))+'</h3><p>Research data checked · Human approved</p><div class="registry-links">'+external(e.repository+'/tree/'+e.commit,'Open pinned code')+external(e.zip_url,'Download ZIP')+'</div>'+facts([
      ['Commit',e.commit],['Contract SHA-256',e.contract_sha256],['Measured fitness',v.observed_fitness],['Expected fitness',v.expected_fitness],['Tolerance',v.tolerance],['Expected-score basis',v.expected_basis],['Reference SHA-256',v.reference_sha256],['Artifact SHA-256',v.artifact_sha256],['Validation report SHA-256',v.report_sha256],['Controlled run',v.checked_by],['Validated',date(v.checked_at)],['Approved',date(a.approved_at)],['Approval note',a.note]])+'</article>';
  }
  async function detail(id){
    var epoch=generation, box=el('registryDetail');box.hidden=false;box.textContent='Loading details…';
    try{var data=(await call({action:'get',problem_id:id})).data;if(epoch!==generation)return;var p=data.problem;
      box.innerHTML='<div class="registry-detail-head"><h2>'+esc(p.title)+'</h2><a href="'+kind+'.html">Close details</a></div><p>'+esc(p.objective)+'</p><p class="registry-meta">'+esc(p.task_kind)+(p.archived?' · Archived':'')+'</p>'+
        '<p><a target="_blank" rel="noopener" href="https://lite.ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/lite?project='+encodeURIComponent(p.source_id.replace('autokaggle:',''))+'&amp;review=evaluator">Open organizer review in AutoKaggle ↗</a> · Access requires permission for that session.</p>'+
        '<form class="registry-notes"><label for="registryNotes">Registry notes</label><textarea id="registryNotes" class="no-tags"'+(p.can_edit?'':' disabled')+'>'+esc(p.notes||'')+'</textarea><label><input id="registryArchive" type="checkbox"'+(p.archived?' checked':'')+(p.can_edit?'':' disabled')+'> Archive this problem</label><button class="btn-box" type="submit"'+(p.can_edit?'':' disabled title="Only the registering account or a PI/admin can edit this record."')+'>Save notes and archive state</button><span id="registrySaveStatus" role="status"></span></form>'+
        '<p class="registry-note">Change the scientific definition in AutoKaggle. A revised evaluator needs new tests and approval. Earlier commits remain available.</p>'+data.versions.map(release).join('')+
        '<details><summary>Record history</summary><ul>'+(data.history||[]).map(function(h){return '<li>'+esc(date(h.updatedAt)+' — '+h.changeNote)+(h.notes?'<p>'+esc(h.notes)+'</p>':'')+'</li>';}).join('')+'</ul></details>';
      box.querySelector('form').onsubmit=async function(event){event.preventDefault();if(!p.can_edit)return;var button=event.currentTarget.querySelector('button');button.disabled=true;el('registrySaveStatus').textContent='Saving…';
        try{await call({action:'update',problem_id:id,notes:el('registryNotes').value,archived:el('registryArchive').checked});if(epoch!==generation)return;await detail(id);await load(false);}
        catch(e){if(epoch===generation){el('registrySaveStatus').textContent='Not saved. '+e.message;button.disabled=false;}}
      };
    }catch(e){if(epoch===generation){box.textContent='Could not load this problem. '+e.message;}}
  }
  el('registrySearch').oninput=render;if(el('registryArchived'))el('registryArchived').onchange=render;
  el('registryMore').onclick=function(){load(true);};el('registryRetry').onclick=function(){load(false);};
  BOLD.onUser(function(user){generation++;signedIn=!!user;busy=false;rows=[];cursor=null;el('registryList').textContent='';el('registryDetail').hidden=true;el('registryDetail').textContent='';el('registryMore').hidden=true;el('registryRetry').hidden=true;
    if(!user){status('Sign in to view the research registry.');return;}load(false);var id=new URLSearchParams(location.search).get('problem');if(id)detail(id);
  });
})();
