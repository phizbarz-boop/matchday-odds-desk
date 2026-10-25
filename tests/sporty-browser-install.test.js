'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {installBrowser}=require('../jobs/install-sporty-browser');
const {configureBrowserPath}=require('../lib/sportyBrowserRuntime');

test('public booking builds do not install Chromium even when dummy credentials are configured',()=>{
  const messages=[];
  const code=installBrowser({env:{SPORTYBET_PHONE:'fixture-phone',SPORTYBET_PASSWORD:'fixture-password'},
    resolvePackage:()=>assert.fail('Public booking does not need a browser package'),
    spawn:()=>assert.fail('Public booking must not download Chromium'),log:text=>messages.push(text)});
  assert.equal(code,0);assert.ok(messages.some(text=>text.includes('Anonymous booking')));
});

test('npm install runs the browser setup and keeps browser files inside the deployed package',t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'sporty-build-test-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  for(const file of ['jobs/install-sporty-browser.js','lib/sportyBrowserRuntime.js']){
    const target=path.join(folder,file);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(__dirname,'..',file),target);
  }
  fs.writeFileSync(path.join(folder,'package.json'),JSON.stringify({name:'sporty-browser-build-fixture',version:'1.0.0',private:true,
    dependencies:{playwright:'file:./fixture-playwright'},scripts:{postinstall:require('../package.json').scripts.postinstall}}));
  const stub=path.join(folder,'fixture-playwright');fs.mkdirSync(stub,{recursive:true});
  fs.writeFileSync(path.join(stub,'package.json'),JSON.stringify({name:'playwright',version:'1.0.0'}));
  fs.writeFileSync(path.join(stub,'cli.js'),
    "require('node:fs').writeFileSync('installed-browser.json',JSON.stringify({args:process.argv.slice(2),location:process.env.PLAYWRIGHT_BROWSERS_PATH}));");
  const result=spawnSync('npm',['install','--offline','--no-audit','--no-fund'],{cwd:folder,
    env:{...process.env,SPORTYBET_BOOKING_MODE:'session',PLAYWRIGHT_BROWSERS_PATH:'',PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:'0',npm_config_ignore_scripts:'false'},encoding:'utf8',timeout:30000});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.match(result.stdout,/Chromium is ready/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(folder,'installed-browser.json'),'utf8')),{args:['install','chromium'],location:'0'});
});
test('runtime and installer preserve an explicit browser path such as the Docker path',()=>{
  const env={PLAYWRIGHT_BROWSERS_PATH:'/ms-playwright'};
  configureBrowserPath(env);assert.equal(env.PLAYWRIGHT_BROWSERS_PATH,'/ms-playwright');
  let launch;
  const code=installBrowser({env,withDependencies:true,resolvePackage:()=>'/fixture/playwright/package.json',
    spawn:(command,args,options)=>{launch={command,args,options};return {status:0};},log:()=>{},error:()=>{}});
  assert.equal(code,0);assert.equal(launch.options.env.PLAYWRIGHT_BROWSERS_PATH,'/ms-playwright');
  assert.deepEqual(launch.args,['/fixture/playwright/cli.js','install','--with-deps','chromium']);
  assert.equal(launch.command,process.execPath);
});
test('browser installation failure fails the build instead of reporting a working automatic sign-in',()=>{
  for (const failure of [{status:3},{status:null,error:Error('spawn failed')},{status:null,signal:'SIGTERM'}]) {
    const output=[];
    const code=installBrowser({env:{SPORTYBET_BOOKING_MODE:'session'},resolvePackage:()=>'/fixture/playwright/package.json',spawn:()=>failure,
      log:text=>output.push(text),error:text=>output.push(text)});
    assert.notEqual(code,0);assert.ok(output.some(text=>text.includes('Installation failed')));
    assert.ok(output.every(text=>!text.includes('Chromium is ready')));
  }
});
