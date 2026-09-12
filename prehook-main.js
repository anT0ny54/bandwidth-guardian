// Bandwidth Guardian 0.1.0 — MAIN-world early image prehook
// Purpose: intercept page JavaScript image URL assignments before the page's own
// JavaScript can trigger the original image request. No extension APIs are used here.
(() => {
  "use strict";
  if (window.__BWG_MAIN_PREHOOK__) return;
  window.__BWG_MAIN_PREHOOK__ = true;

  const DEFAULTS = { enabled:true, proxyBase:"", quality:40, grayscale:true, maxWidth:1280, mobileMaxWidth:1280, isWebpSupported:false, failoverOriginal:true, excludeDomains:"google.com gstatic.com" };
  let opts = {...DEFAULTS};
  let excluded = new Set();
  let proxyHost = "";
  let configured = false;
  const imgProto = HTMLImageElement.prototype;
  const sourceProto = HTMLSourceElement.prototype;
  const linkProto = HTMLLinkElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto,"src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto,"srcset");
  const sourceSrcsetDesc = Object.getOwnPropertyDescriptor(sourceProto,"srcset");
  const linkHrefDesc = Object.getOwnPropertyDescriptor(linkProto,"href");
  const nativeSetAttribute = Element.prototype.setAttribute;
  const NativeImage = window.Image;
  const state = new WeakMap();
  const lazyState = new WeakMap();
  const writing = new WeakSet();
  const urlCache = new Map();
  const CACHE_LIMIT = 1024;
  const LAZY_ATTRS = new Set(["data-src","data-iurl","data-lazy-src","data-original","data-url","data-hi-res","data-lazy","data-echo","data-image","data-original-src"]);
  const PROXY_TIMEOUT_NORMAL = 4500;
  const PROXY_TIMEOUT_LCP = 1800;

  const parseURL = v => { try { return new URL(String(v||""), document.baseURI); } catch { return null; } };
  const httpURL = v => { const u=parseURL(v); return u && /^https?:$/.test(u.protocol) ? u : null; };
  function parseDomains(text){ const s=new Set(); for(const t of String(text||"").split(/[\s,]+/)){const h=t.trim().toLowerCase().replace(/^https?:\/\//,'').split('/')[0].replace(/\.$/,''); if(h)s.add(h);} return s; }
  function hostExcluded(host){ host=String(host||'').toLowerCase(); if(excluded.has(host))return true; for(const d of excluded) if(host.endsWith('.'+d))return true; return false; }
  function normalizeBase(v){ const raw=String(v||'').trim(); if(!raw)return ''; try{const u=new URL(raw); if(!/^https?:$/.test(u.protocol))return ''; u.hash='';u.search='';const p=u.pathname.replace(/\/+$/,'');u.pathname=(!p||p==='/')?'/api':p;return u.toString().replace(/\/$/,'');}catch{return '';}}
  function shouldSkip(v){
    if(!opts.enabled || !opts.proxyBase) return true;
    const u=httpURL(v); if(!u)return true;
    const host=u.hostname.toLowerCase(), href=u.href.toLowerCase(), path=u.pathname.toLowerCase();
    if(proxyHost && host===proxyHost) return true;
    if(hostExcluded(host) || hostExcluded(location.hostname)) return true;
    return path.endsWith('.ico') || path.endsWith('.svg') || href.includes('favicon');
  }
  function proxy(v){
    const u=httpURL(v); if(!u || shouldSkip(u.href)) return v;
    const mobile=!!window.matchMedia?.('(max-width: 900px)')?.matches;
    const mw0=Number(opts.maxWidth)||0, mm=Number(opts.mobileMaxWidth)||0;
    const mw=mobile&&mw0>0&&mm>0?Math.min(mw0,mm):mw0;
    const key=`${u.href}|mw:${mw}|fmt:${opts.isWebpSupported?'webp':'jpeg'}|q:${opts.quality}|bw:${opts.grayscale?1:0}`;
    const hit=urlCache.get(key); if(hit)return hit;
    const p=new URLSearchParams({url:u.href,jpeg:opts.isWebpSupported?'0':'1',bw:opts.grayscale?'1':'0',quality:String(opts.quality??40)});
    if(mw>0)p.set('max_width',String(Math.round(mw)));
    const r=opts.proxyBase+'?'+p.toString();
    if(urlCache.size>=CACHE_LIMIT) urlCache.delete(urlCache.keys().next().value);
    urlCache.set(key,r); return r;
  }
  function hasResponsive(img){ return !!img?.getAttribute?.('srcset') || !!img?.closest?.('picture'); }
  function failover(img){
    const s=state.get(img); if(!s||s.failed||!opts.failoverOriginal)return;
    const current=img.currentSrc||img.getAttribute('src')||'';
    if(current!==s.proxy && img.getAttribute('src')!==s.proxy)return;
    s.failed=true; writing.add(img); try{srcDesc?.set?.call(img,s.original);}catch{} queueMicrotask(()=>writing.delete(img));
  }
  function arm(img, p){
    if(!opts.failoverOriginal)return;
    // Never allow a stalled proxy request to stall the page indefinitely.
    // LCP/high-priority images get a shorter escape hatch; other images get more
    // time for a Netlify cold start. This bounds LCP risk while retaining savings.
    const priority=String(img.getAttribute?.("fetchpriority")||"").toLowerCase();
    const lcpLike=priority==="high" || img.loading==="eager";
    const timeout=lcpLike?PROXY_TIMEOUT_LCP:PROXY_TIMEOUT_NORMAL;
    setTimeout(()=>{
      const s=state.get(img);
      if(s?.proxy===p && !s.failed && !img.complete) failover(img);
    },timeout);
    const check=()=>{const s=state.get(img); if(!s||s.proxy!==p||s.failed)return; const cur=img.currentSrc||img.getAttribute('src')||''; if(cur!==p||!img.complete)return; if(img.naturalWidth===0||img.naturalHeight===0){setTimeout(()=>{const x=state.get(img);if(x?.proxy===p&&!x.failed&&img.complete&&(img.naturalWidth===0||img.naturalHeight===0))failover(img)},80);return;} if(typeof img.decode==='function')Promise.resolve(img.decode()).catch(()=>failover(img));};
    if(img.complete)queueMicrotask(check); else img.addEventListener('load',check,{once:true});
  }
  window.addEventListener('error',e=>{if(e.target instanceof HTMLImageElement)failover(e.target)},true);
  function setSrc(img,v){ writing.add(img); try{srcDesc?.set?.call(img,v)}finally{queueMicrotask(()=>writing.delete(img));} }
  function setAttr(el,n,v){ writing.add(el); try{nativeSetAttribute.call(el,n,v)}finally{queueMicrotask(()=>writing.delete(el));} }

  function handleSrc(img,value){
    const original=String(value??'');
    if(!configured){ setSrc(img,original); return; }
    if(!opts.enabled||!opts.proxyBase||shouldSkip(original)||hasResponsive(img)){ setSrc(img,original); state.delete(img); return; }
    const p=proxy(original); if(p===original){setSrc(img,original);return;}
    state.set(img,{original,proxy:p,failed:false}); setSrc(img,p); arm(img,p);
  }
  if(srcDesc?.set)Object.defineProperty(imgProto,'src',{configurable:true,enumerable:srcDesc.enumerable,get:srcDesc.get,set(v){try{handleSrc(this,v)}catch{srcDesc.set.call(this,v)}}});

  function rewriteSelectedCandidate(img){
    if(!(img instanceof HTMLImageElement) || !configured || !opts.enabled || !opts.proxyBase) return;
    queueMicrotask(()=>{
      const selected=img.currentSrc; const srcset=img.getAttribute("srcset");
      if(!selected || !srcset || shouldSkip(selected) || selected.startsWith(opts.proxyBase)) return;
      const resolved=httpURL(selected)?.href; if(!resolved) return;
      const next=srcset.split(",").map(part=>{
        const token=part.trim().split(/\s+/)[0]; if(!token)return part;
        try{return new URL(token,document.baseURI).href===resolved?part.replace(token,proxy(resolved)):part}catch{return part}
      }).join(",");
      if(next!==srcset) setAttr(img,"srcset",next);
    });
  }
  if(srcsetDesc?.set)Object.defineProperty(imgProto,'srcset',{configurable:true,enumerable:srcsetDesc.enumerable,get:srcsetDesc.get,set(v){srcsetDesc.set.call(this,v);rewriteSelectedCandidate(this)}});
  if(sourceSrcsetDesc?.set)Object.defineProperty(sourceProto,'srcset',{configurable:true,enumerable:sourceSrcsetDesc.enumerable,get:sourceSrcsetDesc.get,set(v){sourceSrcsetDesc.set.call(this,v)}});

  Element.prototype.setAttribute=function(name,value){
    try{
      const a=String(name).toLowerCase();
      if(this instanceof HTMLImageElement && a==='src'){handleSrc(this,value);return;}
      if(this instanceof HTMLImageElement && a==='srcset'){nativeSetAttribute.call(this,name,value);rewriteSelectedCandidate(this);return;}
      if(LAZY_ATTRS.has(a) && (this instanceof HTMLImageElement || this.tagName==='SOURCE')){
        const v=String(value??'');
        if(configured && opts.enabled && opts.proxyBase && !shouldSkip(v)){setAttr(this,name,proxy(v));return;}
      }
    }catch{}
    return nativeSetAttribute.call(this,name,value);
  };

  // LCP SAFETY: do not intercept <link rel="preload" as="image">.
  // Native preload behavior remains entirely under Chromium.
  // Image() itself is also left native; its instances use the patched src setter.

  function applyConfig(next){
    const n={...DEFAULTS,...(next||{})}; n.proxyBase=normalizeBase(n.proxyBase); opts=n; excluded=parseDomains(n.excludeDomains); proxyHost=httpURL(n.proxyBase)?.hostname?.toLowerCase()||''; configured=true; urlCache.clear();
  }
  // Config bridge. Only accept a structured object and validate proxyBase locally.
  window.addEventListener('message',e=>{
    if(e.source!==window || !e.data || e.data.__BWG__!=='CONFIG')return;
    try{applyConfig(e.data.options)}catch{}
  },false);
  // Also accept a synchronous DOM bootstrap written by the isolated bridge if available.
  try{const node=document.documentElement?.dataset?.bwgConfig; if(node)applyConfig(JSON.parse(decodeURIComponent(node)));}catch{}
})();
