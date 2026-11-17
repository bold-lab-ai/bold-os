const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleMeetings, eventBody, idOf } = require('../functions/calendar-meetings-google');
const { londonMs } = require('../functions/busy');
const meeting = () => ({ id:'test-meeting-1234567890',mode:'create',title:'Team meeting',firstDate:'2026-10-23',meeting:{day:'FR',time:'15:00',minutes:60,every:1},participantIds:['U1','U2'],inviteGuests:false });
function harness(){
  const state = { event:null, calls:[], lostInsert:false, pending:false, failure:false };
  function googleEvent(body){
    const e=structuredClone(body);
    for(const k of ['start','end']) if(e[k]) e[k].dateTime=new Date(londonMs(e[k].dateTime.slice(0,10),e[k].dateTime.slice(11,16))).toISOString();
    return e;
  }
  const sync=createGoogleMeetings({CAL:'https://calendar.example.org/events',addressesForIds:async()=>['ada@example.org','ben@example.org'],googleFetch:async(method,url,body)=>{
    state.calls.push({method,url,body:structuredClone(body)});
    if(state.failure)throw Object.assign(Error('Google unavailable'),{status:503});
    if(method==='GET'){if(!state.event)throw Object.assign(Error('Missing'),{status:404});return structuredClone(state.event);}
    if(method==='POST'){
      if(state.event)throw Object.assign(Error('Exists'),{status:409});
      state.event={...googleEvent(body),...(!state.pending?{hangoutLink:'https://meet.example.org/generated'}:{})};
      if(state.lostInsert){state.lostInsert=false;throw Error('Connection lost after Google accepted event');}
      return structuredClone(state.event);
    }
    if(method==='PATCH'){Object.assign(state.event,googleEvent(body));return structuredClone(state.event);}
    if(method==='DELETE'){state.event=null;return {};}
    throw Error('Unexpected method');
  }});
  return {state,sync};
}
test('new meeting without invitations has no Google guests, generates one stable Meet event',async()=>{
  const h=harness(),s=meeting();const r=await h.sync(s,'save');
  assert.equal(r.link,'https://meet.example.org/generated');
  const post=h.state.calls.find(c=>c.method==='POST');assert.deepEqual(post.body.attendees,[]);assert.match(post.url,/sendUpdates=none/);assert.match(post.url,/conferenceDataVersion=1/);
  assert.match(post.body.id,/^[0-9a-v]+$/);assert.equal(post.body.id,idOf(s.id));
  await h.sync(s,'save');assert.equal(h.state.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.state.calls.filter(c=>c.method==='PATCH').length,0);
});
test('invitation opt-in sends selected participants; opting out removes existing guests with cancellations',async()=>{
  const h=harness(),s={...meeting(),inviteGuests:true};await h.sync(s,'save');
  assert.match(h.state.calls.find(c=>c.method==='POST').url,/sendUpdates=all/);assert.equal(h.state.event.attendees.length,2);
  await h.sync({...s,inviteGuests:false},'save');
  const patch=h.state.calls.find(c=>c.method==='PATCH');assert.deepEqual(patch.body.attendees,[]);assert.match(patch.url,/sendUpdates=all/);
});
test('optional invitations can be enabled after creating the event without guests',async()=>{
  const h=harness(),s=meeting();await h.sync(s,'save');await h.sync({...s,inviteGuests:true},'save');
  assert.equal(h.state.event.attendees.length,2);assert.match(h.state.calls.find(c=>c.method==='PATCH').url,/sendUpdates=all/);
});
test('lost insert response and delayed Meet creation recover without duplicate events or emails',async()=>{
  const h=harness(),s={...meeting(),inviteGuests:true};h.state.lostInsert=true;
  await assert.rejects(h.sync(s,'save'));await h.sync(s,'save');
  assert.equal(h.state.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.state.calls.filter(c=>c.method==='PATCH').length,0);
  const p=harness();p.state.pending=true;await assert.rejects(p.sync(s,'save'),/preparing/);
  p.state.event.hangoutLink='https://meet.example.org/ready';assert.equal((await p.sync(s,'save')).link,'https://meet.example.org/ready');assert.equal(p.state.calls.filter(c=>c.method==='POST').length,1);
});
test('recurrence stays at London wall time across DST and respects end date',()=>{
  const s=meeting();s.meeting.until='2027-01-29';s.meeting.every=2;const b=eventBody(s,[]);
  assert.equal(b.start.dateTime,'2026-10-23T15:00:00');assert.equal(b.start.timeZone,'Europe/London');assert.equal(b.end.dateTime,'2026-10-23T16:00:00');
  assert.equal(b.recurrence[0],'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20270129T235959Z');
});
test('title-only edits do not email guests, time edits do',async()=>{
  const h=harness(),s={...meeting(),inviteGuests:true};await h.sync(s,'save');await h.sync({...s,title:'New title'},'save');
  assert.match(h.state.calls.filter(c=>c.method==='PATCH').at(-1).url,/sendUpdates=none/);
  await h.sync({...s,title:'New title',meeting:{...s.meeting,time:'16:00'}},'save');assert.match(h.state.calls.filter(c=>c.method==='PATCH').at(-1).url,/sendUpdates=all/);
});
test('removing a managed event cancels invitations; importing existing meetings can never write to Google',async()=>{
  const h=harness(),s={...meeting(),inviteGuests:true};await h.sync(s,'save');await h.sync(s,'remove');assert.match(h.state.calls.find(c=>c.method==='DELETE').url,/sendUpdates=all/);assert.equal(h.state.event,null);
  const n=h.state.calls.length;await assert.rejects(h.sync({...s,mode:'existing'},'save'));assert.equal(h.state.calls.length,n);
});
