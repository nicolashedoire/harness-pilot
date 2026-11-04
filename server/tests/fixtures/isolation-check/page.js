import {title,denied} from './checks.js';
export async function mount(el,ctx){
 el.innerHTML='<div class="ui-page" style="max-width:1000px;padding:24px"><div class="ui-row"><span class="ui-icon-box ui-lg"></span><div><h1 class="ui-h1"></h1><p class="ui-muted">Browser verification · isolated frame</p></div></div><div class="ui-card" style="padding:20px"><h2 class="ui-h2">Security checks</h2><ul class="ui-list" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;border:0;padding:0"></ul></div><div class="ui-callout ui-info"><p>Browser isolation only. Python handlers remain in process until stage B.</p></div><button class="ui-btn ui-outline" id="route">Test internal navigation</button><p class="ui-muted" id="context"></p></div>';
 el.querySelector('h1').textContent=title;el.querySelector('.ui-icon-box').append(ctx.icon('shield'));
 const rows=[];
 rows.push(['Direct API read blocked',await denied(()=>fetch('/api/settings',{credentials:'include'}))]);
 rows.push(['Direct API write blocked',await denied(()=>fetch('/api/workspace/projects',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-Maxxing':'1'},body:JSON.stringify({name:'isolation-bypass'})}))]);
 rows.push(['Parent DOM blocked',await denied(()=>Promise.resolve(parent.document.body))]);
 rows.push(['App storage blocked',await denied(()=>Promise.resolve(localStorage.getItem('test')))]);
 rows.push(['Bridge traversal rejected',await denied(()=>ctx.api('%252e%252e/%252e%252e/settings'))]);
 rows.push(['Own service available',(await ctx.api('status')).bridge==='ok']);
 rows.push(['Own service write succeeds',(await ctx.api('echo',{method:'POST',body:{text:'essai'}})).saved===true]);
 rows.push(['No project created by bypass attempt',!(await ctx.api('status')).unexpected_project]);
 const list=el.querySelector('ul');for(const [label,ok] of rows){const li=document.createElement('li');li.className='ui-row';li.style.cssText='border:1px solid var(--border);border-radius:8px;padding:10px;min-height:56px';const b=document.createElement('span');b.className='ui-badge '+(ok?'ui-success':'ui-error');b.textContent=ok?'Passed':'FAILED';const span=document.createElement('span');span.style.flex='1';span.textContent=label;li.append(b,span);list.append(li);}
 el.querySelector('#context').textContent='Language: '+ctx.lang+' · '+ctx.t('common.retry');
 el.querySelector('#route').onclick=()=>ctx.setRoute('/verified');
}
