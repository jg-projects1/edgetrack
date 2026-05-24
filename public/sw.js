const CACHE='edgetrack-v3';
const ASSETS=['/','index.html','/casino','/manifest.json','/icon-192.png','/icon-512.png'];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch',e=>{
  // Never cache API calls — always go to network
  if(e.request.url.includes('/api/')){
    e.respondWith(fetch(e.request));
    return;
  }
  // For everything else: network first, fall back to cache
  e.respondWith(
    fetch(e.request).then(res=>{
      if(res.ok&&res.status<400){
        caches.open(CACHE).then(c=>c.put(e.request,res.clone()));
      }
      return res;
    }).catch(()=>caches.match(e.request))
  );
});
