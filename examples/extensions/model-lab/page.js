const words = {
  en: {title:'Model Lab', intro:'Design and improve local models through external adapters. The model and its framework stay outside the platform.', run:'Run a bounded experiment', spec:'Absolute path to an experiment spec', start:'Start experiment', companion:'Prepare an experiment with a companion', note:'The spec executes a trusted local adapter. It declares the model, method, acceptance criteria and time/storage budgets.', empty:'No experiments yet.', metrics:'Measured comparison', metric:'Metric', delta:'Change', threshold:'Predeclared criteria', before:'Before', after:'After', split:'Evaluation data', approve:'Approve candidate', reject:'Reject candidate', select:'Select in the lab', stop:'Stop experiment', active:'Selected in the lab', selection:'Selection records a local pointer. The external serving adapter must load it explicitly; the source model is preserved.', decision:'Decision', eligibleDone:'Reported results meet the criteria', eligible:'Reported results meet the criteria · awaiting your decision', failed:'Acceptance checks failed', limits:'Limitations', fingerprint:'Proposal fingerprint', error:'Operation failed', approved:'approved', rejected:'rejected', prompt:'Use the pilot-model-evolution skill to design a bounded local-model experiment. Ask for the model and task when missing. Use an external adapter, keep source weights intact, define evaluation and regression criteria before execution, and submit the candidate to Model Lab for user review. Experiment spec: ', status:'Status', states:{queued:'Queued',preparing:'Preparing inputs',running:'Experiment in progress',awaiting_review:'Ready for review',failed_checks:'Criteria not met',error:'Execution error',stopped:'Stopped',interrupted:'Interrupted'}},
  fr: {title:'Laboratoire de modèles', intro:'Concevez et améliorez vos modèles locaux avec des connecteurs externes. Le modèle et son framework restent indépendants de la plateforme.', run:'Lancer une expérience bornée', spec:'Chemin absolu du fichier d’expérience', start:'Lancer l’expérience', companion:'Préparer une expérience avec un compagnon', note:'Le fichier exécute un connecteur local de confiance. Il précise le modèle, la méthode, les critères de validation et les budgets de temps et de stockage.', empty:'Aucune expérience pour le moment.', metrics:'Comparaison mesurée', metric:'Mesure', delta:'Variation', threshold:'Critères fixés avant l’essai', before:'Avant', after:'Après', split:'Données d’évaluation', approve:'Valider le candidat', reject:'Refuser le candidat', select:'Sélectionner dans le laboratoire', stop:'Arrêter l’expérience', active:'Sélectionné dans le laboratoire', selection:'La sélection enregistre une référence locale. Le connecteur qui sert le modèle doit la charger explicitement ; le modèle source est conservé.', decision:'Décision', eligibleDone:'Critères atteints selon le rapport', eligible:'Critères atteints selon le rapport · en attente de votre décision', failed:'Critères de validation non atteints', limits:'Limites', fingerprint:'Empreinte de la proposition', error:'Échec de l’opération', approved:'validé', rejected:'refusé', prompt:'Utilise la compétence pilot-model-evolution pour concevoir une expérience bornée sur un modèle local. Demande le modèle et la tâche s’ils manquent. Utilise un connecteur externe, conserve les poids source, fixe les critères d’évaluation et de régression avant l’essai, puis soumets le candidat dans Model Lab pour validation utilisateur. Fichier d’expérience : ', status:'État', states:{queued:'En attente',preparing:'Préparation des entrées',running:'Expérience en cours',awaiting_review:'À examiner',failed_checks:'Critères non atteints',error:'Erreur d’exécution',stopped:'Arrêtée',interrupted:'Interrompue'}}
};
export function mount(el, ctx) {
  const t = words[ctx.lang] || words.en;
  el.innerHTML = `<div class="ui-page" style="max-width:1040px;margin:auto"><header><p class="ui-muted" data-intro></p></header><section class="ui-card ui-stack" style="padding:20px"><h2 class="ui-h2" data-run></h2><form class="ui-stack"><label class="ui-label" for="model-lab-spec"></label><input id="model-lab-spec" class="ui-input" placeholder="/absolute/path/experiment.json" required><p class="ui-muted ui-small" data-note></p><div class="ui-row" style="flex-wrap:wrap"><button class="ui-btn" type="submit" data-start></button><button class="ui-btn ui-outline" type="button" data-companion></button></div></form></section><p role="alert" hidden data-error class="ui-callout ui-error"></p><div class="ui-stack" data-runs></div></div>`;
  for (const key of ['intro','run','note','start','companion']) el.querySelector(`[data-${key}]`).textContent = t[key];
  el.querySelector('label').textContent = t.spec;
  const input = el.querySelector('input'), list = el.querySelector('[data-runs]'), alert = el.querySelector('[data-error]');
  let alive = true, busy = false, rendered = '', context = null;
  const focused = new URLSearchParams(window.location.search).get('run');
  const fmt = (x) => x === null || x === undefined ? '—' : new Intl.NumberFormat(ctx.lang, {maximumSignificantDigits:5}).format(x);
  const message = (error) => { alert.hidden = !error; alert.textContent = error ? `${t.error}: ${error.message || error}` : ''; };
  const node = (tag, text, cls='') => { const n=document.createElement(tag); n.textContent=text; n.className=cls; return n; };
  const action = (label, fn, disabled=false) => {const b=node('button',label,'ui-btn ui-outline ui-sm'); b.type='button'; b.disabled=disabled; b.onclick=()=>perform(fn); return b;};
  async function perform(fn) { if(busy)return; busy=true; message(null); try{await fn();await refresh();}catch(e){message(e);}finally{busy=false;} }
  function render(data) {
    context = data;
    const signature=JSON.stringify(data); if(signature===rendered)return; rendered=signature;
    list.replaceChildren();
    if(!data.runs.length){list.append(node('p',t.empty,'ui-empty'));return;}
    const runs=[...data.runs].sort((a,b)=>Number(b.id===focused)-Number(a.id===focused));
    for(const run of runs){
      const card=node('section','','ui-card ui-stack');card.style.padding='20px';if(run.id===focused)card.style.borderColor='var(--primary)';
      card.append(node('h2',run.name,'ui-h2'),node('p',`${run.model_id} · ${run.operation} · ${run.method}`,'ui-muted ui-small'),node('p',`${t.status}: ${data.selection[run.model_id]?.run===run.id?t.active:run.decision?(t[run.decision.value]||run.decision.value):(t.states[run.status]||run.status)}`,'ui-badge'));
      if(run.error)card.append(node('p',run.error,'ui-callout ui-error'));
      const p=run.proposal;
      if(p){
        card.append(node('h3',t.metrics,'ui-h3'),node('p',p.result.summary||'','ui-text'));
        const wrap=node('div','','ui-table-wrap'),table=node('table','','ui-table'),head=document.createElement('thead'),hr=document.createElement('tr');
        for(const key of ['metric','before','after','delta','split'])hr.append(node('th',t[key]));head.append(hr);table.append(head);
        const body=document.createElement('tbody');
        for(const m of p.result.metrics){const row=document.createElement('tr');for(const value of [m.name,fmt(m.before),fmt(m.after),m.before?`${fmt(100*(m.after-m.before)/Math.abs(m.before))} %`:'—',m.split])row.append(node('td',value));body.append(row);}table.append(body);wrap.append(table);card.append(wrap);
        card.append(node('h3',t.threshold,'ui-h3'));
        for(const rule of p.criteria||[]){const detail=[];if(rule.min_gain!==undefined)detail.push(`gain ≥ ${fmt(rule.min_gain*100)} %`);if(rule.max_after!==undefined)detail.push(`≤ ${fmt(rule.max_after)}`);if(rule.min_after!==undefined)detail.push(`≥ ${fmt(rule.min_after)}`);card.append(node('p',`${rule.metric}: ${detail.join(' · ')}`,'ui-small ui-muted'));}
        card.append(node('p',run.eligible?(run.decision?t.eligibleDone:t.eligible):t.failed,run.eligible?'ui-callout ui-success':'ui-callout ui-warning'));
        for(const reason of run.reasons||[])card.append(node('p',reason,'ui-small ui-muted'));
        if(p.result.limitations?.length){card.append(node('h3',t.limits,'ui-h3'));for(const line of p.result.limitations)card.append(node('p',String(line),'ui-small ui-muted'));}
        card.append(node('p',`${t.fingerprint}: ${run.fingerprint}`,'ui-code'));
        if(run.decision)card.append(node('p',`${t.decision}: ${t[run.decision.value]||run.decision.value}`,'ui-badge'));
        const buttons=node('div','','ui-row');buttons.style.flexWrap='wrap';
        buttons.append(action(t.approve,()=>ctx.api(`runs/${run.id}/decision`,{method:'POST',body:{decision:'approved',fingerprint:run.fingerprint}}),!run.eligible),action(t.reject,()=>ctx.api(`runs/${run.id}/decision`,{method:'POST',body:{decision:'rejected',fingerprint:run.fingerprint}})));
        if(run.decision?.value==='approved'){buttons.append(action(t.select,()=>ctx.api(`runs/${run.id}/select`,{method:'POST',body:{fingerprint:run.fingerprint}})));card.append(node('p',t.selection,'ui-muted ui-small'));}
        if(data.selection[run.model_id]?.run===run.id)card.append(node('p',t.active,'ui-badge ui-success'));
        card.append(buttons);
      }else if(['queued','preparing','running'].includes(run.status)){card.append(action(t.stop,()=>ctx.api(`runs/${run.id}/stop`,{method:'POST'})));}
      list.append(card);
    }
  }
  async function refresh(){const data=await ctx.api('overview');if(alive)render(data);}
  el.querySelector('form').onsubmit=(e)=>{e.preventDefault();perform(()=>ctx.api('runs',{method:'POST',body:{spec_path:input.value.trim()}}));};
  el.querySelector('[data-companion]').onclick=()=>ctx.navigate(`/sessions?path=&new=1&prompt=${encodeURIComponent(t.prompt+input.value.trim()+(context?`\nSkill instructions: ${context.skill_path}\nModel Lab state: ${context.state_dir}`:''))}`);
  refresh().catch(message);
  const timer=setInterval(()=>{if(!busy)refresh().catch(message);},2000);
  return ()=>{alive=false;clearInterval(timer);};
}
