'use strict';
// Conservative retained-size estimate, without allocating a second JSON copy.
function retainedBytes(value,limit=Infinity){
 const seen=new WeakSet(),stack=[value];let bytes=0;
 while(stack.length&&bytes<=limit){const v=stack.pop();if(typeof v==='string'){bytes+=64+v.length*2;continue;}if(!v||typeof v!=='object'){bytes+=16;continue;}if(seen.has(v))continue;seen.add(v);bytes+=128;if(ArrayBuffer.isView(v)){bytes+=v.byteLength;continue;}for(const k of Object.keys(v)){bytes+=32+k.length*2;stack.push(v[k]);}}
 return bytes;
}
class BoundedMemoryCache {
 constructor({maxBytes=16*1024*1024,maxEntries=64,now=Date.now}={}){this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.now=now;this.entries=new Map();this.bytes=0;}
 get size(){return this.entries.size;}
 has(key){return this.get(key)!==undefined;}
 get(key){const item=this.entries.get(key);if(!item)return undefined;if(item.value?.expiresAt&&item.value.expiresAt<=this.now()){this.delete(key);return undefined;}this.entries.delete(key);this.entries.set(key,item);return item.value;}
 set(key,value,weight=retainedBytes(value,this.maxBytes)){this.delete(key);for(const [k,item] of this.entries)if(item.value?.expiresAt&&item.value.expiresAt<=this.now())this.delete(k);if(weight>this.maxBytes)return this;while(this.entries.size&&(this.bytes+weight>this.maxBytes||this.entries.size>=this.maxEntries))this.delete(this.entries.keys().next().value);this.entries.set(key,{value,weight});this.bytes+=weight;return this;}
 delete(key){const item=this.entries.get(key);if(!item)return false;this.bytes-=item.weight;return this.entries.delete(key);}
 clear(){this.entries.clear();this.bytes=0;}
 keys(){return this.entries.keys();}
}
module.exports={BoundedMemoryCache,retainedBytes};
