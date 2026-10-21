const CACHE='stockvoz-v5.12-cache';
const CORE=['./','./index.html','./manifest.webmanifest','./icons/icon.svg'];
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CACHE);
  await cache.addAll(CORE);
  // The custom image is optional; don't fail installation if the user hasn't added it yet.
  try{const response=await fetch('./imagen-app.jpg',{cache:'no-store'});if(response.ok)await cache.put('./imagen-app.jpg',response)}catch(e){}
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('stockvoz-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',event=>{
 const req=event.request;
 if(req.method!=='GET')return;
 const url=new URL(req.url);
 if(url.origin!==location.origin)return;
 event.respondWith((async()=>{
  const cached=await caches.match(req);
  if(cached)return cached;
  try{
   const response=await fetch(req);
   if(response&&response.ok){const cache=await caches.open(CACHE);cache.put(req,response.clone()).catch(()=>{});}
   return response;
  }catch(e){
   if(req.mode==='navigate')return (await caches.match('./index.html'))||Response.error();
   return Response.error();
  }
 })());
});
