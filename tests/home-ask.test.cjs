// The home page's talk with Sofya (index.js): the starters, a bug report, and the card it ends in.
const {test}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('fs'),vm=require('vm'),{parseHTML}=require('linkedom');
const html=fs.readFileSync(require.resolve('../src/pages/index.html'),'utf8'); const js=fs.readFileSync(require.resolve('../src/assets/js/pages/index.js'),'utf8');
const part=js.slice(js.indexOf('  // ---- Talking to Sofya ----'), js.indexOf('  // J and K: from one way in'));
const {document,window}=parseHTML('<html><body>'+html.slice(html.indexOf('<main'))+'</body></html>');
window.HTMLElement.prototype.focus=function(){};
const calls=[];
const ctx={document,window,console,setInterval,clearInterval,setTimeout,Event:window.Event,location:{hash:''},
  localStorage:{getItem(){return null},setItem(){},removeItem(){}},sessionStorage:{getItem(){return null},setItem(){},removeItem(){}},
  matchMedia:()=>({matches:true}),BOLD:{can:()=>true,cannotReason:()=>'x',confirmAlways:async()=>({skip:{}}),getApp(){}},
  firebase:{app:()=>({functions:()=>({httpsCallable:()=>async(d)=>{calls.push(d);return d.action==='card'?{data:{board:'B',title:'Bug: x',notes:'n',kind:'code'}}:{data:{conversation:'c1',text:'Where did it happen?'}}}})}),
    firestore:()=>({collection:()=>({doc:()=>({collection:()=>({add:async(v)=>{calls.push({added:v})}})})})})}};
ctx.window.matchMedia=ctx.matchMedia;
vm.createContext(ctx);
vm.runInContext('var esc=String, state={chatOn:true, mine:{owner:[{title:"World models"}]}}, user={email:"a@b.c",displayName:"A"};\n'+part+'\nmountAsk(); this.drawStarters=drawStarters;',ctx);
test('a starter about BOLD.OS starts a report that ends in a card on its board', async () => {
 const $=(s)=>document.querySelector(s), tick=async(n)=>{ for(let i=0;i<n;i++) await new Promise(r=>setTimeout(r,0)); };
 const labels=[...document.querySelectorAll('.ha-starter')].map(b=>b.textContent);
 assert.deepEqual(labels.slice(0,2), ['Something’s wrong with BOLD.OS', 'I’d like BOLD.OS to do something new']);
 assert.equal(labels[3], 'What’s new on World models?');
 $('.ha-starter').dispatchEvent(new window.Event('click',{bubbles:true})); await tick(5);
 assert.equal(calls[0].intent, 'bug'); assert.equal(calls[0].effort, 'off'); assert.equal($('.ha-starters').hidden, true); assert.equal($('.ha-report').hidden, false);
 assert.equal(document.querySelectorAll('.ha-who')[1].textContent, 'Sofya');
 $('.ha-report-go').dispatchEvent(new window.Event('click')); await tick(5);
 assert.equal($('.ha-card').hidden, false); assert.equal($('.ha-card-title').value, 'Bug: x');
 $('.ha-card').dispatchEvent(new window.Event('submit',{cancelable:true})); await tick(8);
 const added=calls.find(c=>c.added).added;
 assert.equal(added.kind, 'code'); assert.equal(added.column, 'todo'); assert.equal(added.by.email, 'a@b.c');
});
