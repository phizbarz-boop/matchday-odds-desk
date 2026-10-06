'use strict';
function fakeRedis() {
  const data=new Map(),hashes=new Map();
  return {data,hashes,isOpen:false,on(){return this;},async connect(){this.isOpen=true;},async disconnect(){this.isOpen=false;},
    async get(key){return data.get(key)??null;},async exists(key){return Number(data.has(key)||hashes.has(key));},
    async set(key,value,options={}){if(options.NX&&data.has(key))return null;data.set(key,value);return 'OK';},
    async incr(key){const value=Number(data.get(key)||0)+1;data.set(key,String(value));return value;},
    async hSet(key,field,value){if(!hashes.has(key))hashes.set(key,new Map());hashes.get(key).set(field,value);return 1;},
    async hVals(key){return [...(hashes.get(key)?.values()||[])];},async expire(){return 1;},
    async eval(_script,{keys,arguments:args}){if(data.get(keys[0])!==args[0])return 0;data.delete(keys[0]);return 1;}};
}
module.exports={fakeRedis};
