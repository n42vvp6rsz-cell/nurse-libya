'use strict';
// Real PostgreSQL in an isolated PGlite database. No network, credentials, real
// auth identities, or production message/patient rows are used.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createDatabase,uid}=require('./database-runtime.cjs');
const migration=fs.readFileSync(path.join(__dirname,'../docs/messages-database-fixes.sql'),'utf8');
// Exact messages catalog columns, defaults, constraints, grants and policies
// inspected read-only on juxiaorwaiazfjlmkcvm on October 7, 2026.
const fixture=String.raw`
CREATE TABLE public.messages(
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL,
  receiver_id uuid NOT NULL,
  body text NOT NULL,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT messages_pkey PRIMARY KEY(id),
  CONSTRAINT messages_sender_id_fkey FOREIGN KEY(sender_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT messages_receiver_id_fkey FOREIGN KEY(receiver_id) REFERENCES public.profiles(id) ON DELETE CASCADE,
  CONSTRAINT messages_body_check CHECK(length(body)>=1 AND length(body)<=5000)
);
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.messages TO anon,authenticated,service_role;
CREATE POLICY "messages participants read" ON public.messages FOR SELECT TO authenticated
  USING(sender_id=(SELECT auth.uid()) OR receiver_id=(SELECT auth.uid()));
CREATE POLICY "messages receiver mark read" ON public.messages FOR UPDATE TO authenticated
  USING(receiver_id=(SELECT auth.uid())) WITH CHECK(receiver_id=(SELECT auth.uid()));
CREATE POLICY "messages sender insert" ON public.messages FOR INSERT TO authenticated
  WITH CHECK(sender_id=(SELECT auth.uid()) AND sender_id<>receiver_id);
`;
async function main(){
  let checks=0;const db=await createDatabase({applyBase:true});
  const q=async(sql,params=[])=> (await db.query(sql,params)).rows;
  const as=async(role,user,work)=>{await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec(`SET ROLE ${role}`);try{return await work();}finally{await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub','',false)");}};
  const user=(number,work)=>as('authenticated',uid(number),work);
  const check=async(name,work)=>{await work();checks++;process.stdout.write(`PASS ${name}\n`);};
  const denies=async(work,pattern)=>assert.rejects(work,error=>pattern.test(error.message));
  const send=(sender,n,receiver,body='Synthetic private text')=>user(sender,()=>q('SELECT * FROM public.send_private_message($1,$2,$3)',[uid(n),uid(receiver),body]));
  const row=async n=>(await q('SELECT * FROM public.messages WHERE id=$1',[uid(n)]))[0];
  const count=async()=>Number((await q('SELECT count(*) AS count FROM public.messages'))[0].count);
  try{
    await db.exec(fixture);
    const version=(await q('SELECT version()'))[0].version;assert.match(version,/PostgreSQL 17\./);process.stdout.write(`Engine: ${version}\n`);
    await check('legacy raw sender INSERT allows arbitrary patient target',async()=>{
      await user(2,()=>q('INSERT INTO public.messages(id,sender_id,receiver_id,body) VALUES($1,$2,$3,$4)',[uid(700),uid(2),uid(3),'Synthetic legacy patient conversation']));
      assert.equal((await row(700)).receiver_id,uid(3));
    });
    await check('legacy receiver UPDATE can change body and sender',async()=>{
      await user(3,()=>q('UPDATE public.messages SET body=$1,sender_id=$2 WHERE id=$3',['Synthetic altered legacy text',uid(10),uid(700)]));
      const saved=await row(700);assert.equal(saved.body,'Synthetic altered legacy text');assert.equal(saved.sender_id,uid(10));
      // Restore the synthetic legacy pair so it cannot qualify a provider reply.
      await q('UPDATE public.messages SET sender_id=$1,body=$2 WHERE id=$3',[uid(2),'Synthetic legacy patient conversation',uid(700)]);
      await user(2,()=>q('INSERT INTO public.messages(id,sender_id,receiver_id,body) VALUES($1,$2,$3,$4)',[uid(701),uid(2),uid(4),'Synthetic legacy provider inbound']));
      await user(4,()=>q('UPDATE public.messages SET sender_id=$1,body=$2 WHERE id=$3',[uid(3),'Synthetic forged provider inbound',uid(701)]));
    });
    await check('messaging transaction installs marker and retains existing rows',async()=>{
      await db.exec(migration);assert.equal((await user(2,()=>q('SELECT public.nurse_messages_contract_version() AS version')))[0].version,1);assert.equal(await count(),2);assert.equal((await row(700)).body,'Synthetic legacy patient conversation');assert.equal((await row(701)).sent_via_private_contract,false);
      await denies(()=>as('anon',null,()=>q('SELECT public.nurse_messages_contract_version()')),/permission denied/);
    });
    await check('public wrappers are invoker and private writers are narrowly privileged',async()=>{
      const functions=await q("SELECT n.nspname,p.proname,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname IN('send_private_message','mark_private_message_read','nurse_messages_contract_version')");
      assert.equal(functions.length,5);assert.ok(functions.filter(fn=>fn.nspname==='public').every(fn=>!fn.prosecdef));assert.ok(functions.filter(fn=>fn.nspname==='private').every(fn=>fn.prosecdef&&fn.proconfig.some(config=>config.startsWith('search_path='))));
      await denies(()=>user(2,()=>q('SELECT private.is_public_message_provider($1)',[uid(4)])),/permission denied/);
    });
    await check('anonymous reads and all raw writes are denied by grants',async()=>{
      for(const sql of ['SELECT * FROM public.messages','DELETE FROM public.messages','TRUNCATE public.messages'])await denies(()=>as('anon',null,()=>q(sql)),/permission denied/);
      await denies(()=>user(2,()=>q('INSERT INTO public.messages(sender_id,receiver_id,body) VALUES($1,$2,$3)',[uid(2),uid(4),'Synthetic bypass'])),/permission denied/);
      await denies(()=>user(3,()=>q('UPDATE public.messages SET body=$1,sender_id=$2,id=$3,created_at=now() WHERE id=$4',['Synthetic forged',uid(4),uid(701),uid(700)])),/permission denied/);
      await denies(()=>user(3,()=>q('UPDATE public.messages SET is_read=true WHERE id=$1',[uid(700)])),/permission denied/);
      for(const sql of ['DELETE FROM public.messages','TRUNCATE public.messages'])await denies(()=>user(2,()=>q(sql)),/permission denied/);
      assert.equal((await row(700)).body,'Synthetic legacy patient conversation');assert.equal((await row(700)).sender_id,uid(2));
    });
    await check('participants read their rows; stranger and admin cannot read private rows',async()=>{
      for(const n of [2,3])assert.equal((await user(n,()=>q('SELECT id FROM public.messages WHERE id=$1',[uid(700)]))).length,1);
      for(const n of [1,4,10])assert.equal((await user(n,()=>q('SELECT id FROM public.messages WHERE id=$1',[uid(700)]))).length,0);
      assert.equal((await as('authenticated',null,()=>q('SELECT id FROM public.messages'))).length,0);
    });
    await q("INSERT INTO public.doctors(id,profile_id,name,specialty) VALUES($1,$2,'Synthetic doctor','Synthetic specialty')",[uid(601),uid(4)]);
    await q("INSERT INTO public.nurses(id,profile_id,name) VALUES($1,$2,'Synthetic nurse')",[uid(602),uid(5)]);
    await q("INSERT INTO public.hospitals(id,owner_profile_id,name) VALUES($1,$2,'Synthetic hospital')",[uid(603),uid(6)]);
    for(const [table,n] of [['doctors',601],['nurses',602],['hospitals',603]])await user(1,()=>q(`UPDATE public.${table} SET verified=true WHERE id=$1`,[uid(n)]));
    await check('first sends to each approved public provider capture the authenticated sender',async()=>{
      for(const [receiver,n] of [[4,710],[5,711],[6,712]]){const saved=(await send(2,n,receiver))[0];assert.equal(saved.sender_id,uid(2));assert.equal(saved.receiver_id,uid(receiver));assert.equal(saved.is_read,false);assert.equal(saved.sent_via_private_contract,true);assert.ok(saved.created_at);}
    });
    await check('approved provider can reply to its inbound sender',async()=>{
      const saved=(await send(4,713,2,'Synthetic provider reply'))[0];assert.equal(saved.sender_id,uid(4));assert.equal(saved.receiver_id,uid(2));
    });
    await check('unrelated patients and provider-to-unrelated-patient initiation are denied',async()=>{
      const before=await count();await denies(()=>send(2,714,3),/not authorized/);await denies(()=>send(4,715,3),/not authorized/);await denies(()=>send(3,716,2),/not authorized/);assert.equal(await count(),before);
    });
    await check('forged legacy inbound cannot confer private provider reply authority',async()=>{
      const legacy=await row(701);assert.equal(legacy.sender_id,uid(3));assert.equal(legacy.receiver_id,uid(4));assert.equal(legacy.sent_via_private_contract,false);
      await denies(()=>send(4,725,3),/not authorized/);await denies(()=>user(4,()=>q('UPDATE public.messages SET sent_via_private_contract=true WHERE id=$1',[uid(701)])),/permission denied/);assert.equal((await row(701)).sent_via_private_contract,false);
    });
    await check('directory verification without the matching stored role is insufficient',async()=>{
      await q("INSERT INTO public.doctors(id,profile_id,name,specialty) VALUES($1,$2,'Synthetic invalid role','Synthetic specialty')",[uid(604),uid(10)]);await user(1,()=>q('UPDATE public.doctors SET verified=true WHERE id=$1',[uid(604)]));
      await denies(()=>send(2,717,10),/not authorized/);assert.equal(await row(717),undefined);
    });
    await check('exact booking pair permits contact without granting unrelated target access',async()=>{
      await user(2,()=>q("INSERT INTO public.bookings(id,user_id,service,patient_name,phone,booking_date,status,provider_profile_id) VALUES($1,$2,'Synthetic nursing','Synthetic booking owner','0000000000','2099-01-01','pending',$3)",[uid(605),uid(2),uid(5)]));
      await user(1,()=>q('UPDATE public.nurses SET verified=false WHERE id=$1',[uid(602)]));
      assert.equal((await send(2,718,5))[0].receiver_id,uid(5));assert.equal((await send(5,719,2))[0].sender_id,uid(5));
      await denies(()=>send(3,720,5),/not authorized/);await denies(()=>send(5,721,3),/not authorized/);
      assert.equal((await user(2,()=>q('UPDATE public.bookings SET provider_profile_id=$1 WHERE id=$2 RETURNING id',[uid(3),uid(605)]))).length,0);
      assert.equal((await q('SELECT provider_profile_id FROM public.bookings WHERE id=$1',[uid(605)]))[0].provider_profile_id,uid(5));
    });
    await check('exact UUID retry returns the original row without duplicate or timestamp changes',async()=>{
      const saved=await row(710),before=await count();const retried=(await send(2,710,4))[0];assert.deepEqual(retried,saved);assert.equal(await count(),before);
    });
    await check('UUID content/recipient/owner mismatch rejects and leaves the original row intact',async()=>{
      const before=await row(710),size=await count();await denies(()=>send(2,710,4,'Changed synthetic body'),/reference is unavailable/);await denies(()=>send(2,710,6),/reference is unavailable/);await denies(()=>send(3,710,4),/reference is unavailable/);assert.deepEqual(await row(710),before);assert.equal(await count(),size);
    });
    await check('confirmed UUID can recover after the provider is withdrawn',async()=>{
      await user(1,()=>q('UPDATE public.doctors SET verified=false WHERE id=$1',[uid(601)]));const saved=(await send(2,710,4))[0];assert.equal(saved.id,uid(710));await denies(()=>send(3,722,4),/not authorized/);
    });
    await check('anonymous and authenticated null-UID RPC invocations fail',async()=>{
      await denies(()=>as('anon',null,()=>q('SELECT * FROM public.send_private_message($1,$2,$3)',[uid(723),uid(4),'Synthetic text'])),/permission denied/);
      await denies(()=>as('authenticated',null,()=>q('SELECT * FROM public.send_private_message($1,$2,$3)',[uid(723),uid(4),'Synthetic text'])),/Invalid private message/);
      await denies(()=>as('authenticated',null,()=>q('SELECT * FROM public.mark_private_message_read($1)',[uid(710)])),/not authorized/);
      await denies(()=>as('anon',null,()=>q('SELECT * FROM private.send_private_message($1,$2,$3)',[uid(723),uid(4),'Synthetic text'])),/permission denied/);
    });
    await check('empty, oversized, control, self and null parameters are rejected atomically',async()=>{
      const before=await count();for(const body of ['', ' \t\r\n ', 'a'.repeat(5001),'Synthetic\u0001','Synthetic\u202e'])await denies(()=>send(2,724,6,body),/Invalid private message/);
      await denies(()=>send(2,724,2),/Invalid private message/);
      for(const args of [[null,uid(6),'Synthetic text'],[uid(724),null,'Synthetic text'],[uid(724),uid(6),null]])await denies(()=>user(2,()=>q('SELECT * FROM public.send_private_message($1,$2,$3)',args)),/Invalid private message/);
      assert.equal(await count(),before);assert.equal((await send(2,724,6,'Synthetic line one\nSynthetic line two'))[0].body,'Synthetic line one\nSynthetic line two');
    });
    await check('only the receiver can mark read; content/identities/time remain immutable',async()=>{
      const original=await row(710);await denies(()=>user(2,()=>q('SELECT * FROM public.mark_private_message_read($1)',[uid(710)])),/not authorized/);await denies(()=>user(3,()=>q('SELECT * FROM public.mark_private_message_read($1)',[uid(710)])),/not authorized/);await denies(()=>user(1,()=>q('SELECT * FROM public.mark_private_message_read($1)',[uid(710)])),/not authorized/);
      const marked=(await user(4,()=>q('SELECT * FROM public.mark_private_message_read($1)',[uid(710)])))[0];assert.deepEqual(marked,{...original,is_read:true});const retried=(await user(4,()=>q('SELECT * FROM public.mark_private_message_read($1)',[uid(710)])))[0];assert.deepEqual(retried,marked);
      await denies(()=>user(4,()=>q('UPDATE public.messages SET is_read=false,body=$1,sender_id=$2 WHERE id=$3',['Synthetic forged edit',uid(3),uid(710)])),/permission denied/);assert.deepEqual(await row(710),marked);
    });
    await check('migration reapplication preserves rows, narrow grants and marker',async()=>{
      const before=await count();await db.exec(migration);assert.equal(await count(),before);assert.equal((await user(2,()=>q('SELECT public.nurse_messages_contract_version() AS version')))[0].version,1);const grants=(await q("SELECT has_table_privilege('authenticated','public.messages','INSERT') AS can_insert,has_table_privilege('authenticated','public.messages','UPDATE') AS can_update"))[0];assert.equal(grants.can_insert,false);assert.equal(grants.can_update,false);
    });
    await check('missing base contract rolls the full messaging transaction back',async()=>{
      const fresh=await createDatabase();try{await fresh.exec(fixture);await assert.rejects(()=>fresh.exec(migration),/Install the base Nurse Libya contract first/);await fresh.exec('ROLLBACK');const marker=(await fresh.query("SELECT to_regprocedure('public.nurse_messages_contract_version()') AS marker,has_table_privilege('authenticated','public.messages','INSERT') AS raw_insert")).rows[0];assert.equal(marker.marker,null);assert.equal(marker.raw_insert,true);}finally{await fresh.close();}
    });
    process.stdout.write(`Messaging database runtime: ${checks} scenarios passed\n`);
  }finally{await db.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main,fixture};
