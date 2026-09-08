import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Room } from '../dist/db.js';
function setup(t) {
 const dir=mkdtempSync(path.join(tmpdir(),'room-collab-'));
 const cfg={dataDir:dir,dbPath:path.join(dir,'room.db'),maxDbBytes:8*1024*1024,maxMessageBytes:65536,maxDocBytes:524288,retentionDays:0,maxResponseBytes:65536};
 const room=new Room(cfg);room.collaboration.setMembers([{id:'alice',role:'agent'},{id:'bob',role:'agent'}]);
 t.after(()=>{room.close();rmSync(dir,{recursive:true,force:true});});return {room,c:room.collaboration,cfg};
}
test('threads route mentions and nested replies; invalid recipients roll back atomically',t=>{
 const {room,c}=setup(t);
 const a=room.postMessage('alice','Question for @bob?',undefined,['bob'],true);
 assert.equal(c.inbox('bob').items.length,1);
 assert.equal(c.inbox('bob').items[0].question,1);
 const b=room.postMessage('bob','Answer',a.id);
 room.postMessage('alice','Follow up',b.id);
 assert.equal(c.thread(b.id).root_id,a.id);
 assert.equal(c.thread(a.id).items.length,3);
 assert.equal(c.inbox('alice').items.length,1);
 assert.throws(()=>room.postMessage('alice','typo',undefined,['unknown']),/unknown recipient/);
 assert.equal(room.status().messages,3);
 assert.throws(()=>c.attention('alice',c.inbox('bob').items[0].id,'resolved'),/belong/);
 c.attention('bob',c.inbox('bob').items[0].id,'acknowledged');
 assert.equal(c.inbox('bob').items[0].state,'acknowledged');
 c.attention('bob',c.inbox('bob').items[0].id,'resolved');
 assert.equal(c.inbox('bob').items.length,1); // follow-up remains
});
test('status history is owner-only, byte bounded, chunked and conflict protected',t=>{
 const {c}=setup(t);const data={summary:'Building',state:'working',detail:'🎉'.repeat(10240)};
 c.put('alice','status','alice',data,0);
 assert.throws(()=>c.put('bob','status','alice',data,1),/identity/);
 assert.throws(()=>c.put('alice','status','alice',data,0),/version conflict/);
 assert.throws(()=>c.put('alice','status','alice',{...data,detail:data.detail+'x'},1),/Maximum 40/);
 c.put('alice','status','alice',{summary:'Done',state:'finished'},1);
 assert.equal(c.records('status').items.length,1);
 assert.equal(c.records('status',0,20,'alice').items.length,2);
 let offset=0,full='';do {const page=c.content('status','alice',offset,1); full+=page.content; offset=page.next_offset;} while(offset!==null);
 assert.equal(JSON.parse(full).detail,data.detail);
});
test('work lease takeover and immutable test commit identity',t=>{
 const {c}=setup(t);const work={title:'Task',state:'working',lease_until:Date.now()+10000};
 c.put('alice','work','task',work,0);
 assert.throws(()=>c.put('bob','work','task',work,1),/another agent/);
 c.put('alice','work','task',{...work,lease_until:0},1);
 c.put('bob','work','task',work,2);
 const run={repo:'org/repo',commit:'a'.repeat(40),suite:'unit',command:'npm test',state:'running',started_at:new Date().toISOString(),summary:''};
 c.put('alice','test','run1',run,0);
 assert.throws(()=>c.put('alice','test','run1',{...run,commit:'b'.repeat(40)},1),/identity cannot change/);
 assert.throws(()=>c.put('bob','test','run1',run,1),/another agent/);
 c.put('alice','test','run1',{...run,state:'passed'},1);
});
test('wake claims exclude duplicate runners, preserve new arrivals, retry failures and enforce deadlines',t=>{
 const {c,room}=setup(t);const check=c.checkin('bob',30);
 assert.equal(c.claimWake('bob'),null);
 room.postMessage('alice','Wake',undefined,['bob']);
 const first=c.claimWake('bob',30);
 assert.equal(first.reason,'notification');assert.equal(c.claimWake('bob'),null);
 room.postMessage('alice','New arrival',undefined,['bob']);
 assert.throws(()=>c.finishWake('bob',first.token,first.through_event+2,true),/watermark/);
 c.finishWake('bob',first.token,first.through_event,true);
 const second=c.claimWake('bob',30);assert.ok(second.through_event>first.through_event);
 c.finishWake('bob',second.token,second.through_event,false);
 assert.equal(c.claimWake('bob'),null);
 const retry=c.claimWake('bob',30,Date.now()+4000);assert.ok(retry);
 assert.throws(()=>c.finishWake('bob',first.token,first.through_event,true),/expired/);
 c.finishWake('bob',retry.token,retry.through_event,true,Date.now()+4001);
 const periodic=c.claimWake('bob',30,check.next_due+10000);assert.equal(periodic.reason,'check_in_due');
});
test('log output redaction and durable event replay after restart',t=>{
 const {c,room,cfg}=setup(t);
 c.put('alice','log','log1',{level:'info',summary:'Run',output:'Authorization: Bearer private\npassword=hunter2\nghp_abcdef'},0);
 const value=c.latest('log','log1').data.output;
 assert.ok(!value.includes('private')&&!value.includes('hunter2')&&!value.includes('ghp_abcdef'));
 const reopened=new Room(cfg);try {assert.equal(reopened.collaboration.events().items.length,1);} finally {reopened.close();}
 const exported=JSON.parse([...room.exportChunks()].join(''));assert.equal(exported.room_records.length,1);
});

test('work dependency cycles are rejected, and runner restarts do not postpone overdue checks',t=>{
 const {c}=setup(t);const work={title:'Task',state:'open',lease_until:0};
 c.put('alice','work','a',work,0);c.put('alice','work','b',{...work,depends_on:['a']},0);
 assert.throws(()=>c.put('alice','work','a',{...work,depends_on:['b']},1),/cycle/);
 c.registerRunner('bob',30);const first=c.checkins().items[0];
 c.registerRunner('bob',300);assert.equal(c.checkins().items[0].next_due,first.next_due);
 assert.equal(c.claimWake('bob').reason,'check_in_due');
});
