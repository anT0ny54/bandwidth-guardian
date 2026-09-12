// Bandwidth Guardian 0.1.0 — isolated/main-world bridge
(() => {
  "use strict";
  const DEFAULTS={enabled:true,proxyBase:"",quality:40,grayscale:true,maxWidth:1280,mobileMaxWidth:1280,excludeDomains:"google.com gstatic.com",isWebpSupported:false,failoverOriginal:true};
  function publish(options){
    const safe={...DEFAULTS,...(options||{})};
    try{
      // Fast bootstrap for MAIN-world prehook. This is intentionally non-secret: it only
      // contains user-selected proxy settings and is validated again by prehook-main.js.
      const encoded=encodeURIComponent(JSON.stringify(safe));
      if(document.documentElement) document.documentElement.dataset.bwgConfig=encoded;
    }catch{}
    window.postMessage({__BWG__:'CONFIG',options:safe},'*');
  }
  function load(){
    chrome.storage.local.get({bhOpts:null},data=>{
      if(data?.bhOpts){publish(data.bhOpts);return;}
      chrome.storage.sync.get(DEFAULTS,synced=>{publish(synced);chrome.storage.local.set({bhOpts:synced});});
    });
  }
  load();
  chrome.storage.onChanged.addListener((changes,area)=>{
    if(area==='local'&&changes.bhOpts) publish(changes.bhOpts.newValue);
    else if(area==='sync') chrome.storage.sync.get(DEFAULTS,synced=>{publish(synced);chrome.storage.local.set({bhOpts:synced});});
  });
})();
