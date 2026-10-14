self.addEventListener('push',event=>{
  let data;try{data=event.data.json();}catch{return;}
  event.waitUntil(self.registration.showNotification(data.title||'春日部の空き通知',{
    body:data.body,tag:data.id,renotify:false,data:{url:'/'},icon:'/icon.svg'
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil((async()=>{const all=await clients.matchAll({type:'window',includeUncontrolled:true});for(const w of all){if(new URL(w.url).origin===self.location.origin){await w.focus();return;}}await clients.openWindow('/');})());
});
