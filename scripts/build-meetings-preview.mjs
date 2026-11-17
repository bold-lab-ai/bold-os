// Run after npm run build. Real calendar/form scripts, synthetic in-memory data only.
import { readFile, writeFile } from 'node:fs/promises';
const page = await readFile(new URL('../_site/calendar.html', import.meta.url), 'utf8');
const bold = await readFile(new URL('../src/assets/js/bold.js', import.meta.url), 'utf8');
const confirmStart = bold.indexOf('  BOLD.confirmAction = function(o){');
const confirmation = bold.slice(confirmStart, bold.indexOf('\n  };', confirmStart) + 5);
const mock = String.raw`
(function(){
  var role = 'member', users = [], listeners = [], auth = null;
  var projects = [{id:'preview-project-1',title:'Learning from sparse observations',board:'preview-board',venue:'Example venue'},{id:'preview-project-2',title:'Reliable evaluation of language models',board:'',venue:''}];
  var people = [{id:'UADA00001',name:'Ada North'},{id:'UBEN00001',name:'Ben Stone'},{id:'UCAM00001',name:'Cam Rivers'},{id:'UDEE00001',name:'Dee West'}];
  var channelPeople = people.slice(0,3);
  var today = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London'}).format(new Date());
  var d = new Date(today+'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+(5-d.getUTCDay()+7)%7); var friday=d.toISOString().slice(0,10);
  var records = [{id:'preview-supervision-000001',title:'Joint supervision',mode:'existing',category:'supervision',calendarState:'listed',firstDate:friday,meeting:{day:'FR',time:'15:00',minutes:60,every:1},version:1,
    channel:{id:'CDEMO00001',name:'joint-supervision'},link:'https://meet.example.org/joint-supervision',participantIds:people.slice(0,3).map(p=>p.id),manualIds:['UCAM00001']}];
  var publicView = s => ({id:s.id,title:s.title,firstDate:s.firstDate,meeting:s.meeting,version:s.version,mode:s.mode,category:s.category,calendarState:s.calendarState,projectId:s.projectId||'',projectTitle:s.projectTitle||'',projectBoard:s.projectBoard||''});
  var user = () => ({email:(role==='member'?'ada':role==='participant'?'cam':'dee')+'@example.org',name:role==='member'?'Ada North':role==='participant'?'Cam Rivers':'Dee West'});
  var esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.BOLD = {escapeHtml:esc,getAuth:()=>true,getApp:()=>({}),can:()=>true,cannotReason:()=>'',isFullWrite:()=>false,visibleLevels:()=>['internal'],
    onUser:f=>{users.push(f);setTimeout(()=>f(user()),0);},onAccess:f=>setTimeout(f,0),
    takeLinkAction:h=>{if(location.hash!=='#'+h)return false;history.replaceState(null,'',location.pathname);return true;},
    confirmAlways:o=>BOLD.confirmAction({...o,always:true}),copyBoxHtml:s=>esc(s)};
  __CONFIRM__
  window.BoldEvents={access:f=>setTimeout(()=>f(false),0),isPast:e=>e.endDate<today,when:(a,b)=>a+(b!==a?'–'+b:'')};
  function snapshot(col){return {docs:(col==='calendarMeetingEntries'?records.map(publicView):col==='people'?people.map(p=>({...p,email:p.id.toLowerCase()+'@example.org'})):[]).map(s=>({id:s.id,data:()=>structuredClone(s),ref:{parent:{id:col}}}))};}
  function notify(){listeners.slice().forEach(x=>x.fn(snapshot(x.col)));}
  function collection(col){return {where:()=>collection(col),get:async()=>snapshot(col),onSnapshot:fn=>{var l={col,fn};listeners.push(l);fn(snapshot(col));return ()=>{listeners=listeners.filter(x=>x!==l)};}};}
  async function call(a){
    await new Promise(r=>setTimeout(r,100));
    if(a.action==='projects')return {projects};
    if(a.action==='directory')return {people};
    if(a.action==='channel'){
      if(role!=='member')throw Error('You must be a member of this Slack channel.');
      if(!/CDEMO00001/.test(a.channel))throw Error('Preview channel: paste CDEMO00001 or https://demo.slack.com/archives/CDEMO00001.');
      return {channel:{id:'CDEMO00001',name:'joint-supervision'},people:channelPeople,unmatched:1};
    }
    var s=records.find(s=>s.id===a.id);
    if(a.action==='get'){
      if(!s)throw Error('This entry was removed.');
      return {...publicView(s),canEdit:role==='member',...(role==='member'?{link:s.link,channel:s.channel,participantIds:s.participantIds,manualIds:s.manualIds,inviteGuests:!!s.inviteGuests,syncError:s.syncError||'',pendingOperation:s.pendingOperation||'',syncing:false}:{channelError:'The meeting link is only available to Slack channel members.'}),
        ...(role!=='outside'?{people:people.filter(p=>s.participantIds.includes(p.id))}:{})};
    }
    if(role!=='member')throw Error('You must be a member of this Slack channel.');
    if(a.action==='retry'){s.calendarState='ready';s.syncError='';s.link='https://meet.example.org/generated-preview';notify();return publicView(s);}
    if(a.action==='remove'){records=records.filter(s=>s.id!==a.id);notify();return {removed:true};}
    if(a.action==='save'){
      if(!a.participantIds.length)throw Error('Choose at least one BOLD.OS participant.');
      if(a.mode==='existing'&&!/^https:\/\//.test(a.link))throw Error('Add an HTTPS meeting link.');
      if(a.until&&a.until<a.firstDate)throw Error('End date must be on or after the first date.');
      if(!s&&records.some(x=>x.channel.id===a.channel&&x.link===a.link&&x.meeting.time===a.time&&x.meeting.every===+a.every))throw Error('This channel already has a meeting with that schedule and link. Open its existing calendar entry.');
      var project=projects.find(p=>p.id===a.projectId);
      if(a.category==='project'&&!project)throw Error('Choose an existing BOLD.OS project.');
      if(a.mode==='create'&&!a.confirmed)throw Error('Confirm the Google Calendar changes.');
      var failed=a.mode==='create'&&document.getElementById('previewFail').checked;document.getElementById('previewFail').checked=false;
      var n={mode:a.mode,category:a.category,projectId:a.category==='project'?project.id:'',projectTitle:a.category==='project'?project.title:'',projectBoard:a.category==='project'?project.board:'',inviteGuests:a.mode==='create'&&a.inviteGuests,calendarState:a.mode==='create'?(failed?'error':'ready'):'listed',syncError:failed?'Could not finish the Google Calendar update. Refresh and retry; an existing event will not be duplicated.':'',pendingOperation:'save',id:a.id,title:a.title,firstDate:a.firstDate,meeting:{day:['SU','MO','TU','WE','TH','FR','SA'][new Date(a.firstDate+'T12:00:00Z').getUTCDay()],time:a.time,minutes:+a.minutes,every:+a.every,...(a.until?{until:a.until}:{})},
        version:s?s.version+1:1,link:a.mode==='create'?(failed?(s&&s.link||''):'https://meet.example.org/generated-preview'):a.link,channel:{id:a.channel,name:'joint-supervision'},participantIds:a.participantIds,manualIds:a.manualIds};
      records=records.filter(x=>x.id!==n.id).concat([n]);notify();return publicView(n);
    }
    throw Error('Unavailable in this offline preview.');
  }
  window.firebase={firestore:()=>({collection}),app:()=>({functions:()=>({httpsCallable:name=>async a=>{
    if(name!=='calendarMeeting')throw Error('Only direct calendar meetings are enabled in this offline preview.');return {data:await call(a)};
  }})})};
  document.getElementById('previewRole').onchange=e=>{role=e.target.value;users.forEach(f=>f(user()));};
  document.getElementById('previewTheme').onclick=()=>{var root=document.documentElement;root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';};
  document.getElementById('previewMembership').onclick=e=>{channelPeople=channelPeople.length===3?[people[0],people[1],people[3]]:people.slice(0,3);e.target.textContent=channelPeople.length===3&&channelPeople[2].id==='UDEE00001'?'Channel changed: Dee replaced Cam':'Simulate channel change';};
  document.querySelectorAll('.sidebar a,.masthead a').forEach(a=>a.addEventListener('click',e=>e.preventDefault()));
})();`.replace('__CONFIRM__', confirmation);
let html = page.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/(<div class="shell"[^>]*?) hidden/, '$1')
  .replace('<title>Calendar | BOLD Lab</title>', '<title>Add meeting preview | BOLD.OS</title>');
html = html.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="connect-src \'none\'; form-action \'none\'">');
html = html.replace('<main>', `<main><section style="border:1px solid var(--line);padding:14px;margin-bottom:20px;background:var(--surface);font-family:var(--sans);font-size:13px"><strong>Local preview · synthetic data only</strong><p>No Firebase, Slack or Google connections. Changes reset on reload. Test channel: <code>CDEMO00001</code></p><label>View as <select id="previewRole"><option value="member">Channel member</option><option value="participant">Participant outside channel</option><option value="outside">Other calendar viewer</option></select></label> <button id="previewTheme" class="view-btn">Light / dark</button> <button id="previewMembership" class="view-btn">Simulate channel change</button> <label><input type="checkbox" id="previewFail">Simulate next Google update failing</label></section>`);
html = html.replace('</body>', '<script>'+mock+'</script><script src="assets/js/project-fields.js"></script><script src="assets/js/calendar-meetings.js"></script><script src="assets/js/pages/calendar.js"></script></body>');
await writeFile(new URL('../_site/_preview_meetings.html', import.meta.url), html);
await writeFile(new URL('../_site/_preview_co-supervision.html', import.meta.url), html);
console.log('Preview: http://127.0.0.1:8137/_preview_meetings.html');
