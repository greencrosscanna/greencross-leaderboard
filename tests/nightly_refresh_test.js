#!/usr/bin/env node
/* Nightly kiosk refresh — GC.nightlyRefresh in index.html.
 *
 * The kiosk is an always-on screen nobody reloads by hand, so this timer is the ONLY thing that
 * resets per-day frontend state (_goalCelebrated, _seenTxnKeys) and picks up shipped code. Both of
 * its failure modes are silent from the floor:
 *
 *   never fires  → the screen quietly runs last week's build, and a store that hit goal once never
 *                  fires confetti again. Nothing on the display says so.
 *   fires twice  → the day is recorded AFTER the reload (or not at all), the condition is still
 *                  true on the way back up, and six kiosks sit in a reload loop all morning.
 *
 * Neither shows up in a browser you are actually watching, which is why it is gated here.
 *
 * The rollover is PT-DATE math (GC.PT_TZ), so it inherits every hazard the .gs date helpers have:
 * DST in both directions, midnight rendering as hour 24, and viewers whose machine is not on PT.
 * Those are covered below with real Intl, not a fixture.
 *
 * Per tests/_harness.js's rule, this NEVER reimplements the module — it extracts GC.nightlyRefresh
 * from the shipped index.html and runs that. The harness itself is not reused: it loads .gs files,
 * and this one lives in the monolith.
 */
'use strict';
const fs=require('fs'), path=require('path'), vm=require('vm');
const src=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const m=src.match(/GC\.nightlyRefresh = \(function\(\) \{[\s\S]*?\n\}\)\(\);/);
if(!m) throw new Error('module not found in index.html');

// Fresh module instance per test — the real one holds _memDay in a closure, so reusing it
// across cases leaks yesterday's state into today's assertions.
function make(opts){
  opts=opts||{};
  const env={NOW:new Date('2026-08-24T12:00:00Z'), store:opts.store||{}, reloads:0, active:null, listeners:{}};
  const ls = opts.throwingStorage
    ? {getItem(){throw new Error('denied')}, setItem(){throw new Error('denied')}}
    : {getItem:k=>k in env.store?env.store[k]:null, setItem:(k,v)=>{env.store[k]=v}};
  const sandbox={
    GC:{PT_TZ:'America/Los_Angeles'}, Intl, console:{log(){}},
    localStorage:ls,
    document:{
      get activeElement(){return env.active},
      addEventListener(type,fn){ (env.listeners[type]=env.listeners[type]||[]).push(fn); }
    },
    // A real navigation can preempt the rest of the script at any moment after this call, so the
    // sandbox stops executing here. That is what makes "record the day BEFORE reloading" testable:
    // sequence the write after the reload and it never lands, and the kiosk loops.
    location:{reload(){ env.reloads++; const e=new Error('__navigated__'); e.__nav=true; throw e; }},
    setInterval:()=>1,
    Date:Object.assign(class extends Date{constructor(...a){ if(!a.length) super(env.NOW.getTime()); else super(...a);} },
                       {now:()=>env.NOW.getTime(), UTC:Date.UTC, parse:Date.parse})
  };
  vm.createContext(sandbox);
  vm.runInContext(m[0]+'\nthis.NR=GC.nightlyRefresh;',sandbox);
  env.NR=sandbox.NR; env.sandbox=sandbox;
  env.at=iso=>{env.NOW=new Date(iso)};
  env.tick=()=>{ try{ env.NR._tick(); }catch(e){ if(!e.__nav) throw e; } };
  env.type=()=>{ (env.listeners.keydown||[]).forEach(f=>f()); };   // simulate a keystroke NOW
  return env;
}

let pass=0,fail=0;
function t(name,fn){try{fn();console.log('  ok  '+name);pass++}catch(e){console.log('  FAIL '+name+' — '+e.message);fail++}}
function eq(a,b,msg){if(a!==b)throw new Error((msg||'value')+': expected '+JSON.stringify(b)+' got '+JSON.stringify(a));}

t('ptNow converts UTC to PT day+hour (PDT, UTC-7)',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z');       // 04:30 PT
  eq(x.NR._ptNow().day,'2026-08-24','day'); eq(x.NR._ptNow().hour,4,'hour');
});
t('ptNow keeps the PT day on the 24th at 23:59 PT',()=>{
  const x=make(); x.at('2026-08-25T06:59:00Z');
  eq(x.NR._ptNow().day,'2026-08-24','day'); eq(x.NR._ptNow().hour,23,'hour');
});
t('midnight PT reports hour 0, not 24',()=>{
  const x=make(); x.at('2026-08-25T07:00:00Z');
  eq(x.NR._ptNow().day,'2026-08-25','day'); eq(x.NR._ptNow().hour,0,'hour');
});
t('first tick seeds the day and does NOT reload on boot',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  eq(x.reloads,0,'reloads'); eq(x.store.gcperf_lastRefreshDay,'2026-08-24','stored day');
});
t('same PT day: no reload however many ticks',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-24T20:00:00Z'); x.tick(); x.tick();
  eq(x.reloads,0,'reloads');
});
t('day rolled over but before 04:00 PT: waits, day untouched',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T09:00:00Z');                       // 02:00 PT
  x.tick();
  eq(x.reloads,0,'reloads'); eq(x.store.gcperf_lastRefreshDay,'2026-08-24','stored day');
});
t('day rolled over and past 04:00 PT: reloads exactly once',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T11:01:00Z');                       // 04:01 PT
  x.tick(); eq(x.reloads,1,'first reload');
  x.tick(); x.tick(); eq(x.reloads,1,'no reload loop');
  eq(x.store.gcperf_lastRefreshDay,'2026-08-25','stored day');
});
t('ACTIVE typing defers the reload; next tick takes it',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T11:01:00Z'); x.active={tagName:'INPUT'}; x.type();
  x.tick(); eq(x.reloads,0,'deferred while typing');
  x.active=null; x.tick(); eq(x.reloads,1,'taken once focus left');
});
t('contenteditable being typed in also defers',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T11:01:00Z'); x.active={tagName:'DIV',isContentEditable:true}; x.type();
  x.tick(); eq(x.reloads,0,'deferred');
});
t('REGRESSION: a kiosk parked on the autofocused login field still reloads',()=>{
  // The login screen autofocuses #loginUser. Treating focus alone as "busy" meant a signed-out
  // kiosk had an <input> focused forever and never refreshed again -- found by running it, not by
  // this suite, which is why it is pinned here.
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.active={tagName:'INPUT',id:'loginUser',type:'text'};   // focused, never typed in
  x.at('2026-08-25T11:01:00Z');
  x.tick(); eq(x.reloads,1,'idle focus must NOT block the reload');
});
t('typing goes stale: a field abandoned mid-edit stops blocking after the idle window',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T11:01:00Z'); x.active={tagName:'INPUT'}; x.type();
  x.tick(); eq(x.reloads,0,'blocked right after a keystroke');
  x.at('2026-08-25T11:02:30Z'); x.tick(); eq(x.reloads,0,'still blocked at 90s');
  x.at('2026-08-25T11:04:00Z'); x.tick(); eq(x.reloads,1,'released past the 2min idle window');
});
t('a focused non-editable element never blocks',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T11:01:00Z'); x.active={tagName:'BUTTON'}; x.type();
  x.tick(); eq(x.reloads,1,'a focused button is not an edit in progress');
});
t('a tab asleep through the window catches up on wake',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T16:00:00Z');                       // 09:00 PT, window long past
  x.tick(); eq(x.reloads,1,'reloads');
});
t('three days asleep still reloads only once on wake',()=>{
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-27T16:00:00Z');
  x.tick(); x.tick(); eq(x.reloads,1,'reloads');
});
t('PST (UTC-8) after DST fall-back still resolves 04:00 PT',()=>{
  const x=make({store:{gcperf_lastRefreshDay:'2025-11-30'}});
  x.at('2025-12-01T12:00:00Z');                       // 04:00 PST
  eq(x.NR._ptNow().hour,4,'hour'); x.tick(); eq(x.reloads,1,'reloads');
});
t('spring-forward morning (clocks jumped 02:00->03:00) still reloads at 04:00',()=>{
  const x=make({store:{gcperf_lastRefreshDay:'2026-03-07'}});
  x.at('2026-03-08T11:00:00Z');                       // 04:00 PDT
  eq(x.NR._ptNow().day,'2026-03-08','day'); eq(x.NR._ptNow().hour,4,'hour');
  x.tick(); eq(x.reloads,1,'reloads');
});
t('a viewer in a non-PT timezone still reloads on the PT boundary',()=>{
  process.env.TZ='America/New_York';
  const x=make(); x.at('2026-08-24T11:30:00Z'); x.tick();
  x.at('2026-08-25T09:30:00Z');                       // 05:30 ET = 02:30 PT -> too early
  x.tick(); eq(x.reloads,0,'not yet at 02:30 PT');
  x.at('2026-08-25T11:30:00Z');                       // 04:30 PT
  x.tick(); eq(x.reloads,1,'reloads on PT 04:00, not local');
  process.env.TZ='America/Los_Angeles';
});
t('localStorage denied: seeds in memory and does not loop',()=>{
  const x=make({throwingStorage:true});
  x.at('2026-08-24T11:30:00Z'); x.tick();
  eq(x.reloads,0,'no reload on boot');
  x.at('2026-08-24T20:00:00Z'); x.tick(); eq(x.reloads,0,'same day');
  x.at('2026-08-25T11:01:00Z'); x.tick(); eq(x.reloads,1,'one reload on rollover');
  x.tick(); x.tick(); eq(x.reloads,1,'no loop');
});

t('a formatter reporting midnight as hour 24 is normalized to 0',()=>{
  // Node's en-CA gives '00', but hour12:false maps to hourCycle h24 in some engines, which renders
  // midnight as '24'. Unnormalized that is >= PT_HOUR, so every kiosk would reload at MIDNIGHT --
  // stores are still closing, and the day has only just rolled. Substitute such a formatter.
  const x=make();
  const RealDTF=Intl.DateTimeFormat;
  x.sandbox.Intl={DateTimeFormat:function(loc,opts){
    const f=new RealDTF(loc,opts);
    return {formatToParts:(d)=>f.formatToParts(d).map(p=>p.type==='hour'&&p.value==='00'?{type:'hour',value:'24'}:p)};
  }};
  x.at('2026-08-25T07:00:00Z');                       // 00:00 PT on the 25th
  eq(x.NR._ptNow().hour,0,'hour');
  x.store.gcperf_lastRefreshDay='2026-08-24';
  x.tick(); eq(x.reloads,0,'must NOT reload at midnight');
  x.at('2026-08-25T11:01:00Z'); x.tick(); eq(x.reloads,1,'reloads at 04:00 as normal');
});

console.log('\n'+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
