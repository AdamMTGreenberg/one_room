import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Room } from '../dist/db.js';
import { GitHubSync } from '../dist/github.js';
test('GitHub snapshots are bounded, source-owned, deduplicated and tied to exact-commit test evidence',async t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'room-github-'));
 const room=new Room({dataDir:dir,dbPath:path.join(dir,'room.db'),maxDbBytes:16*1024*1024,maxMessageBytes:65536,maxDocBytes:524288,retentionDays:0});
 t.after(()=>{room.close();rmSync(dir,{recursive:true,force:true});});
 let sha='a'.repeat(40),open=true,failed=false,ciFailed=false;const seen=[];
 const pull=()=>({number:1,title:'Feature',body:'Description\n'+'x'.repeat(50000),state:open?'open':'closed',merged_at:open?null:new Date().toISOString(),draft:false,head:{sha}});
 const request=async(url,opts)=>{
  assert.ok(url.startsWith('https://api.github.com/repos/org/repo/'));assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer test');seen.push(url);
  if(failed)return new Response('{}',{status:503});
  let data;
  if(url.includes('/reviews'))data=[{user:{id:1},state:'APPROVED'}];
  else if(url.includes('/check-runs')){if(ciFailed)return new Response('{}',{status:403});data={check_runs:[{status:'completed',conclusion:'success'}]};}
  else if(url.endsWith('/status'))data={total_count:0,state:'pending'};
  else if(url.includes('/pulls?'))data=open?[pull()]:[];
  else data=pull();
  return Response.json(data);
 };
 const sync=new GitHubSync(room,{repos:['org/repo'],token:'test',intervalSeconds:300},request);
 assert.equal((await sync.sync()).error,null);
 const c=room.collaboration;let pr=c.latest('pr','org/repo#1');assert.equal(pr.data.ci,'success');assert.equal(pr.data.description.length,50012);
 assert.throws(()=>c.put('alice','pr','org/repo#1',pr.data,1),/synchronizer/);
 await sync.sync();assert.equal(c.latest('pr','org/repo#1').version,1,'unchanged sync should not duplicate descriptions');
 c.put('alice','test','test1',{repo:'org/repo',commit:sha,suite:'unit',command:'npm test',state:'passed',started_at:new Date().toISOString(),summary:'pass'},0);
 c.put('alice','pr_note','org/repo#1',{summary:'Alice owns this'},0);
 assert.equal(c.prTests('org/repo#1').items.length,1);
 sha='b'.repeat(40);await sync.sync();assert.equal(c.prTests('org/repo#1').items.length,0);
 assert.equal(c.latest('pr_note','org/repo#1').data.summary,'Alice owns this');
 ciFailed=true;await sync.sync();assert.equal(c.latest('pr','org/repo#1').data.ci,'unknown');
 open=false;await sync.sync();assert.equal(c.latest('pr','org/repo#1').data.state,'merged');
 assert.ok(seen.some(url=>url.endsWith('/pulls/1')));
 failed=true;assert.match((await sync.sync()).error,/503/);assert.equal(c.latest('pr','org/repo#1').data.state,'merged');
});
