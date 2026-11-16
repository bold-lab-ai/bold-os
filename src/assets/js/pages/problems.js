(function(){
  'use strict';
  var root=document.getElementById('registry');
  if(!root || !BOLD.getAuth())return;
  var el=function(id){return document.getElementById(id);},esc=BOLD.escapeHtml,rows=[],projects=[],cursor=null,generation=0,signedIn=false,busy=false;
  var call=firebase.app().functions('europe-west2').httpsCallable('benchmarkRegistry');
  var stages={open:'Open problem · No evaluator release',implemented:'Fully implemented · reported by AutoKaggle',checked:'Checked · reported by AutoKaggle',validated:'Validated on the actual task · reported by AutoKaggle'};
  // AutoKaggle's addresses (settings/problemBank, set by PIs and admins at the foot of the page); these until one is saved.
  var urls={autokaggleUrl:'https://ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/',autokaggleLiteUrl:'https://lite.ecc962fa-2f4c-4a3f-96c4-179af273fb7a.k8s.civo.com/lite'},canApprove=false;
  var fields={owner:'Research owner',collaborators:'Collaborators',submission_format:'Submission format',metrics:'Metrics and score direction',run_command:'Run command',dependencies:'Dependencies',seeds:'Seeds',compute:'Compute requirements',data_assets:'Data and assets: source, version, access and licence',limitations:'Known limitations',open_issues:'Open issues',next_action:'Next action and responsible person'};
  function status(message,error){el('registryStatus').textContent=message;el('registryStatus').dataset.error=!!error;}
  function date(value){var d=new Date(value);return isNaN(d)?'Not recorded':d.toLocaleString();}
  function external(href,label){return '<a target="_blank" rel="noopener" href="'+esc(href)+'">'+esc(label)+' ↗</a>';}
  function facts(values){return '<dl class="registry-facts">'+values.map(function(x){return '<dt>'+esc(x[0])+'</dt><dd>'+BOLDRegistryLinks.formatText(x[1]==null?'Not recorded':String(x[1]))+'</dd>';}).join('')+'</dl>';}
  function stage(r){return stages[r.stage]||'Stage not recorded';}
  function projectLink(p){return p.project_id?'<a href="project.html#id='+encodeURIComponent(p.project_id)+(p.project_board?'&amp;board='+encodeURIComponent(p.project_board):'')+'">'+esc(p.project_title||p.project_id)+'</a>':'';}
  function sessionURL(p,handoff){
    if(!p.session)return '';
    var base=p.session.application==='lite'?urls.autokaggleLiteUrl:urls.autokaggleUrl;
    return base+'?project='+encodeURIComponent(p.session.project_id)+(handoff?'&review=handoff':'');
  }
  function options(p){return '<option value="">Select a BOLD OS project</option>'+projects.map(function(x){return '<option value="'+esc(JSON.stringify([x.id,x.board]))+'"'+(p&&p.project_id===x.id&&(p.project_board||'')===(x.board||'')?' selected':'')+'>'+esc(x.title+(x.venue?' · '+x.venue:''))+'</option>';}).join('');}
  function metadata(p){return Object.keys(fields).map(function(k){return '<label>'+esc(fields[k])+'<textarea class="no-tags" name="'+k+'" maxlength="8000"'+(p.can_edit===false?' disabled':'')+'>'+esc((p.details||{})[k]||'')+'</textarea></label>';}).join('');}
  function readMetadata(form){var out={};Object.keys(fields).forEach(function(k){var v=form.elements[k].value.trim();if(v)out[k]=v;});return out;}
  function render(){
    var q=el('registrySearch').value.toLowerCase().trim(),filter=el('registryStage').value;
    var shown=rows.filter(function(r){return (!r.archived||el('registryArchived').checked)&&(!filter||r.stage===filter)&&[r.title,r.objective,r.task_kind,r.project_title,(r.details||{}).owner,(r.evaluator||{}).commit].join(' ').toLowerCase().indexOf(q)!==-1;});
    el('registryList').innerHTML=shown.map(function(r){return '<article class="registry-card"><p class="registry-meta">'+projectLink(r)+'</p><h2><a href="problems.html?problem='+encodeURIComponent(r.id)+'">'+esc(r.title)+'</a></h2><p>'+esc(r.objective)+'</p><p class="registry-stage">'+esc(stage(r))+(r.archived?' · Archived':'')+'</p><p class="registry-meta">'+esc(r.task_kind)+' · '+esc((r.details||{}).owner||'Owner not recorded')+'</p>'+(r.evaluator?external(r.evaluator.repository,'Evaluator repository'):'')+'</article>';}).join('');
    el('registryMore').hidden=!cursor;el('registryMore').disabled=busy;
    status(shown.length?shown.length+' shown. '+rows.length+' loaded.':rows.length?'No matching records in the loaded results.':'No problems yet. Add an open problem or register an evaluator from AutoKaggle.');
  }
  async function load(more){
    if(!signedIn||busy)return;busy=true;var epoch=generation;el('registryRetry').hidden=true;status('Loading…');
    try{var r=(await call({action:'list',cursor:more?cursor:null})).data;if(epoch!==generation)return;rows=more?rows.concat(r.items):r.items;cursor=r.cursor;render();}
    catch(e){if(epoch===generation){status('Could not load records. '+e.message,true);el('registryRetry').hidden=false;}}
    finally{if(epoch===generation){busy=false;el('registryMore').disabled=false;}}
  }
  function release(r){var e=r.evaluator,v=r.research,a=r.approval;
    var data=[['Commit',e.commit],['Contract SHA-256',e.contract_sha256],['Recorded',date(r.updatedAt)]];
    Object.keys(r.validation||{}).forEach(function(k){data.push([k.replace(/_/g,' '),r.validation[k]]);});
    if(v)data=data.concat([['Measured fitness',v.observed_fitness],['Expected fitness',v.expected_fitness],['Tolerance',v.tolerance],['Expected-score basis',v.expected_basis],['Reference SHA-256',v.reference_sha256],['Artifact SHA-256',v.artifact_sha256],['Validation report SHA-256',v.report_sha256],['Controlled run',v.checked_by],['Validated',date(v.checked_at)]]);
    var ra=r.reported_approval;if(ra)data=data.concat([['AutoKaggle reports approval',date(ra.approved_at)],['Its approval note',ra.note]]);
    return '<article class="registry-release"><h3>Evaluator version '+esc(String(e.version))+'</h3><p class="registry-stage">'+esc(stage(r))+'</p><p>'+ (a?'Approved by '+esc(a.name)+', '+esc(date(a.at))+(a.note?': '+esc(a.note):'')+'.':'Not approved in BOLD.OS.')+'</p>'+(!a&&r.stage==='validated'?'<p><button type="button" class="btn-box" data-approve="'+esc(r.id)+'"'+(canApprove?'':' disabled title="Only a PI or admin approves a release"')+'>Approve this release</button></p>':'')+'<div class="registry-links">'+external(e.repository,'Repository')+external(e.repository+'/tree/'+e.commit,'Pinned code')+external(e.zip_url,'Download ZIP')+'</div><details><summary>Checks and evidence</summary>'+facts(data)+'</details></article>';
  }
  async function detail(id){
    var epoch=generation,box=el('registryDetail');box.hidden=false;box.textContent='Loading details…';
    try{var data=(await call({action:'get',problem_id:id})).data;if(epoch!==generation)return;canApprove=!!data.can_approve;var p=data.problem;
      box.innerHTML='<div class="registry-detail-head"><h2>'+esc(p.title)+'</h2><a href="problems.html">Close details</a></div><p>'+projectLink(p)+'</p><p>'+esc(p.objective)+'</p><p class="registry-stage">'+esc(stage(p))+'</p>'+
        (p.session?'<div class="registry-links">'+external(sessionURL(p,false),'Resume in AutoKaggle'+(p.session.application==='lite'?' Lite':''))+external(sessionURL(p,true),'Manage session handoff')+'</div><p class="registry-note">Sign in to the original session. Its owner can create a single-use handoff code, valid for 24 hours, and revoke access there. Codes are not stored in the Problem Bank.</p>':'<p class="registry-note">No AutoKaggle session is linked.</p>')+
        facts(Object.keys(fields).map(function(k){return [fields[k],(p.details||{})[k]||'Not recorded'];}))+
        '<details><summary>Edit project and descriptive details</summary><form class="registry-notes"><label>BOLD OS project (required)<select name="project" required'+(p.can_edit?'':' disabled')+'>'+options(p)+'</select></label>'+(p.stage==='open'?'<label>Problem title<input name="title" maxlength="180" required value="'+esc(p.title)+'"'+(p.can_edit?'':' disabled')+'></label><label>Research question<textarea name="objective" class="no-tags" required maxlength="8000"'+(p.can_edit?'':' disabled')+'>'+esc(p.objective)+'</textarea></label><label>Task type<input name="task_kind" required maxlength="80" value="'+esc(p.task_kind)+'"'+(p.can_edit?'':' disabled')+'></label>':'')+metadata(p)+'<label>Registry notes<textarea name="notes" class="no-tags" maxlength="8000"'+(p.can_edit?'':' disabled')+'>'+esc(p.notes||'')+'</textarea></label><label><input name="archived" type="checkbox"'+(p.archived?' checked':'')+(p.can_edit?'':' disabled')+'> Archive this problem</label><button class="btn-box" type="submit"'+(p.can_edit?'':' disabled title="Only the registering account or a PI/admin can edit."')+'>Save details</button><span id="registrySaveStatus" role="status"></span></form></details>'+
        '<p class="registry-note">Descriptive notes do not change the accepted evaluation contract. Make scientific changes in AutoKaggle and check the new evaluator version.</p>'+data.versions.map(release).join('')+
        '<details><summary>Record history</summary><ul>'+(data.history||[]).map(function(h){return '<li>'+esc(date(h.updatedAt)+' — '+h.changeNote+' · '+stage(h)+' · '+(h.project_title||'Project not recorded')+(h.latest_commit?' · Commit '+h.latest_commit.slice(0,12):''))+(h.notes?'<p>'+esc(h.notes)+'</p>':'')+'</li>';}).join('')+'</ul></details>';
      box.querySelectorAll('[data-approve]').forEach(function(b){b.onclick=async function(){if(!canApprove)return;b.disabled=true;
        try{await call({action:'approve',benchmark_id:b.dataset.approve});if(epoch===generation)await detail(id);}catch(e){b.disabled=false;b.insertAdjacentText('afterend',' Not approved. '+e.message);}};});
      box.querySelector('form').onsubmit=async function(event){event.preventDefault();if(!p.can_edit)return;var form=event.currentTarget,button=form.querySelector('button'),project=JSON.parse(form.elements.project.value);button.disabled=true;el('registrySaveStatus').textContent='Saving…';
        try{await call({action:'update',problem_id:id,project_id:project[0],project_board:project[1],details:readMetadata(form),...(p.stage==='open'?{definition:{title:form.elements.title.value,objective:form.elements.objective.value,task_kind:form.elements.task_kind.value}}:{}),notes:form.elements.notes.value,archived:form.elements.archived.checked});if(epoch!==generation)return;await detail(id);await load(false);if(epoch===generation)status('Saved details.');}
        catch(e){if(epoch===generation){el('registrySaveStatus').textContent='Not saved. '+e.message;button.disabled=false;}}
      };
    }catch(e){if(epoch===generation)box.textContent='Could not load this problem. '+e.message;}
  }
  // AutoKaggle's addresses: everyone signed in reads them, PIs and admins change them.
  function loadUrls(){
    firebase.firestore(BOLD.getApp()).collection('settings').doc('problemBank').get().then(function(x){
      if(x.exists)['autokaggleUrl','autokaggleLiteUrl'].forEach(function(k){if(x.data()[k])urls[k]=x.data()[k];});
    }).catch(function(){}).then(function(){
      var form=el('registryUrls'),full=BOLD.isFullWrite();el('registryLite').href=urls.autokaggleLiteUrl;
      ['autokaggleUrl','autokaggleLiteUrl'].forEach(function(k){form.elements[k].value=urls[k];form.elements[k].disabled=!full;});
      form.querySelector('button').disabled=!full;form.querySelector('button').title=full?'':'Only a PI or admin changes them';
    });
  }
  el('registryUrls').onsubmit=function(event){event.preventDefault();var form=event.currentTarget,user=BOLD.getAuth().currentUser;
    var value={autokaggleUrl:form.elements.autokaggleUrl.value.trim(),autokaggleLiteUrl:form.elements.autokaggleLiteUrl.value.trim(),updatedAt:Date.now(),updatedBy:String(user&&user.email||'').toLowerCase()};
    el('registryUrlsStatus').textContent='Saving…';
    firebase.firestore(BOLD.getApp()).collection('settings').doc('problemBank').set(value).then(function(){urls.autokaggleUrl=value.autokaggleUrl;urls.autokaggleLiteUrl=value.autokaggleLiteUrl;el('registryLite').href=urls.autokaggleLiteUrl;el('registryUrlsStatus').textContent='Saved.';})
      .catch(function(e){el('registryUrlsStatus').textContent='Not saved. '+e.message;});
  };
  el('registryNew').onclick=function(){var box=el('registryCreate');box.hidden=!box.hidden;};
  el('registryCreate').onsubmit=async function(event){event.preventDefault();var form=event.currentTarget,button=form.querySelector('button'),epoch=generation;button.disabled=true;el('registryCreateStatus').textContent='Saving…';
    try{var project=JSON.parse(form.elements.project.value),r=(await call({action:'create',project_id:project[0],project_board:project[1],title:form.elements.title.value,objective:form.elements.objective.value,task_kind:form.elements.task_kind.value,details:{owner:form.elements.owner.value}})).data;if(epoch!==generation)return;location.href='problems.html?problem='+encodeURIComponent(r.problem_id);}
    catch(e){if(epoch===generation){el('registryCreateStatus').textContent='Not saved. '+e.message;button.disabled=false;}}
  };
  el('registrySearch').oninput=render;el('registryStage').onchange=render;el('registryArchived').onchange=render;
  el('registryMore').onclick=function(){load(true);};el('registryRetry').onclick=function(){load(false);};
  BOLD.onUser(async function(user){generation++;var epoch=generation;signedIn=!!user;busy=false;rows=[];cursor=null;projects=[];el('registryList').textContent='';el('registryDetail').hidden=true;el('registryDetail').textContent='';el('registryCreate').hidden=true;el('registryMore').hidden=true;el('registryRetry').hidden=true;el('registryNew').disabled=true;
    if(!user){status('Sign in to view the Problem Bank.');return;}
    BOLD.onAccess(loadUrls);
    try{projects=(await call({action:'projects'})).data.items;if(epoch!==generation)return;el('registryCreate').elements.project.innerHTML=options();BOLD.onAccess(function(){el('registryNew').disabled=!BOLD.can('projects','edit');});}catch(e){if(epoch===generation)status('Could not load projects. '+e.message,true);}
    if(epoch!==generation)return;load(false);var id=new URLSearchParams(location.search).get('problem');if(id)detail(id);
  });
})();
