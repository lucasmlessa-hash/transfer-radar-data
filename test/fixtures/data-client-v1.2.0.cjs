'use strict';

// Shared boundary for the panel and classic service worker. Never persist a
// network response until BOTH documents can be used together by the UI.
(function (root) {
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const nonempty = value => typeof value === 'string' && value.trim().length > 0;
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const probabilities = (value, length) => Array.isArray(value) && value.length === length && value.every(n => number(n) && n <= 1);
  function check(condition, message) { if (!condition) throw new Error(message); }
  function validateDefinition(value, label) {
    const start=value.target==='campaign_start';
    check(start ? value.horizonMode==='rolling_days'
      : (value.target==null||value.target==='bonus_available')&&(value.horizonMode==null||value.horizonMode==='calendar_months'), 'invalid '+label+' target');
    if(value.modelVersion==='recurrence-hazard-v3')check(start,'invalid '+label+' target');
    return start;
  }
  function validateContext(value, label) {
    check(object(value),'invalid '+label+' context');
    check(['campaignsThisYear','campaignsLast365Days','completeYears','nextCampaignOrdinal'].every(k=>Number.isInteger(value[k])&&value[k]>=0)
      &&value.nextCampaignOrdinal===value.campaignsThisYear+1,'invalid '+label+' context counts');
    check(['annualMedian','daysSinceLastStart','daysSinceLastEnd','medianIntervalDays'].every(k=>value[k]===null||number(value[k]))
      &&Array.isArray(value.recentIntervalsDays)&&value.recentIntervalsDays.every(number),'invalid '+label+' context intervals');
  }
  function rollingWindow(issuedAt, months) {
    const days={1:30,3:90,6:180}[months],at=Date.parse(issuedAt.slice(0,10));
    return {days,startDate:new Date(at+86400000).toISOString().slice(0,10),endDate:new Date(at+days*86400000).toISOString().slice(0,10)};
  }
  function validateRollingWindow(value, issuedAt, label) {
    const expected=rollingWindow(issuedAt,value.months);
    check(value.days===expected.days&&value.startDate===expected.startDate&&value.endDate===expected.endDate,'invalid '+label+' rolling window');
  }
  function validateEvidence(route) {
    if (route.forecast != null) {
      const f=route.forecast, e=f.evidence;
      check(object(f) && nonempty(f.modelVersion) && Number.isFinite(Date.parse(f.issuedAt)) && object(e), 'invalid forecast metadata');
      check(Number.isInteger(e.windowCount) && e.windowCount>=0 && Number.isInteger(e.spanMonths) && e.spanMonths>=0
        && ['limited','established_history'].includes(e.level), 'invalid forecast evidence');
      check(e.windowCount===0 ? e.firstDate===null && e.lastDate===null : date(e.firstDate) && date(e.lastDate) && e.firstDate<=e.lastDate, 'invalid forecast evidence dates');
      check(e.level!=='established_history' || (e.windowCount>=6 && e.spanMonths>=24), 'invalid forecast evidence level');
      check(Array.isArray(f.horizons) && [0,3].includes(f.horizons.length), 'invalid forecast horizons');
      const rolling=validateDefinition(f,'forecast');
      if(rolling) {validateContext(f.context,'forecast');check(f.horizons.length===3,'invalid forecast horizons');}
      const issued=new Date(f.issuedAt);
      for (const [i,h] of f.horizons.entries()) {
        const start=new Date(Date.UTC(issued.getUTCFullYear(),issued.getUTCMonth()+1,1)).toISOString().slice(0,10);
        const end=new Date(Date.UTC(issued.getUTCFullYear(),issued.getUTCMonth()+[1,3,6][i]+1,0)).toISOString().slice(0,10);
        check(object(h) && h.months===[1,3,6][i] && date(h.startDate) && date(h.endDate)
          && number(h.probability) && h.probability<=1, 'invalid forecast horizon');
        if(rolling) {
          validateRollingWindow(h,f.issuedAt,'forecast');
          check(i===0||h.probability>=f.horizons[i-1].probability,'invalid forecast cumulative probability');
        } else check(h.days==null&&h.startDate===start&&h.endDate===end,'invalid forecast horizon');
      }
    }
    if (route.offerEvidence != null) {
      const e=route.offerEvidence;
      check(object(e) && ['observed','conflict','carried'].includes(e.status) && Number.isFinite(Date.parse(e.checkedAt))
        && Array.isArray(e.observations) && e.observations.length>0, 'invalid offer evidence');
      for (const o of e.observations) {
        let url; try { url=new URL(o.url); } catch { /* Rejected below. */ }
        check(object(o) && nonempty(o.sourceId) && number(o.pct) && ['fixed','up_to','unknown'].includes(o.bonusKind)
          && url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password, 'invalid offer observation');
        for (const key of ['startDate','endDate']) if (o[key]!=null) check(date(o[key]), 'invalid offer date');
        if (o.conditionsText!=null) check(typeof o.conditionsText==='string' && o.conditionsText.length<=600, 'invalid offer conditions');
      }
    }
  }
  function validatePair(feed, partners) {
    check(object(feed) && Array.isArray(feed.routes) && nonempty(feed.generatedAt) && Number.isFinite(Date.parse(feed.generatedAt)), 'invalid feed');
    check(Date.parse(feed.generatedAt) <= Date.now() + 5 * 60000, 'feed generatedAt is in the future');
    check(object(partners) && object(partners.banks) && Object.keys(partners.banks).length > 0 && object(partners.directory), 'invalid partners');
    for (const key of ['airlineDomains', 'bankDomains', 'airlineValues']) check(object(partners[key]), 'missing partners ' + key);
    for (const [key, bank] of Object.entries(partners.banks)) {
      check(object(bank) && ['name', 'short', 'bg', 'fg'].every(k => nonempty(bank[k])), 'invalid bank ' + key);
      const directory = partners.directory[key];
      check(object(directory), 'missing directory ' + key);
      for (const group of ['air', 'hotel']) {
        check(Array.isArray(directory[group]) && directory[group].every(row => Array.isArray(row) && nonempty(row[0]) && typeof row[1] === 'string'
          && (row[1] === '—' || (/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(row[1]) && row[1].split(':').every(n => Number(n) > 0)))), 'invalid directory ' + key);
      }
    }
    check(Object.keys(partners.directory).every(key => partners.banks[key]), 'unknown directory bank');
    const ids = new Set(), routes=[];
    let hasAdditiveForecast=false;
    for (const route of feed.routes) {
      check(object(route) && ['id', 'bank', 'airline', 'code'].every(k => nonempty(route[k])) && partners.banks[route.bank], 'invalid route identity');
      check(!ids.has(route.id), 'duplicate route ' + route.id); ids.add(route.id);
      validateEvidence(route);
      check(probabilities(route.mp, 12), 'invalid monthly probabilities');
      check(Array.isArray(route.hist) && route.hist.every(row => object(row) && nonempty(row.w) && number(row.pct)), 'invalid history');
      if (route.p2 !== undefined) check(probabilities(route.p2, 12), 'invalid two-month probabilities');
      if (route.wait !== undefined) check(probabilities(route.wait, 3), 'invalid wait probabilities');
      if(route.nextCampaignForecast!=null) {
        validateEvidence({forecast:route.nextCampaignForecast});
        check(route.nextCampaignForecast.target==='campaign_start'&&route.nextCampaignForecast.horizonMode==='rolling_days','invalid next campaign forecast');
        // Validate the wire document before promoting the additive curve. On
        // the wire, wait belongs to the legacy forecast, not to the new one.
        if(route.wait!==undefined&&route.forecast?.horizons?.length===3)check(
          route.wait.every((value,index)=>value===route.forecast.horizons[index].probability),'invalid forecast wait mismatch');
        const forecast=JSON.parse(JSON.stringify(route.nextCampaignForecast));
        routes.push({...route,nextCampaignForecast:forecast,forecast,wait:forecast.horizons.map(window=>window.probability)});
        hasAdditiveForecast=true;
      } else routes.push(route);
      for (const key of ['active', 'upcoming']) if (route[key] != null) {
        const window = route[key];
        check(object(window) && number(window.pct) && date(window.endDate), 'invalid ' + key + ' window');
        if (key === 'upcoming' || window.startDate != null) check(date(window.startDate) && window.startDate <= window.endDate, 'invalid start date');
      }
      if (route.ended != null) check(object(route.ended) && number(route.ended.pct) && date(route.ended.endedAt), 'invalid ended window');
      if (route.next != null) check(object(route.next) && nonempty(route.next.label) && number(route.next.prob) && route.next.prob <= 100, 'invalid forecast');
    }
    if (feed.health != null) {
      check(object(feed.health) && ['ok', 'degraded'].includes(feed.health.status) && object(feed.health.sources)
        && number(feed.health.carriedForwardRoutes), 'invalid feed health');
      for (const source of Object.values(feed.health.sources)) check(object(source) && ['ok', 'failed', 'degraded'].includes(source.status), 'invalid source health');
    }
    return { feedDoc: hasAdditiveForecast?{...feed,routes}:feed, partnersDoc: partners };
  }
  async function fetchPair(baseUrl, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const [feedDoc, partnersDoc] = await Promise.all(['feed.json', 'partners.json'].map(async file => {
        const response = await fetch(baseUrl + '/' + file, { cache: 'no-cache', signal: controller.signal });
        if (!response.ok) throw new Error(file + ': HTTP ' + response.status);
        return response.json();
      }));
      return validatePair(feedDoc, partnersDoc);
    } finally { clearTimeout(timer); controller.abort(); }
  }
  function validateHistory(doc) {
    const time=value=>nonempty(value)&&Number.isFinite(Date.parse(value));
    const rate=value=>number(value)&&value<=1;
    check(object(doc)&&doc.version===1&&['ok','unavailable'].includes(doc.status)
      &&(doc.asOf===null||time(doc.asOf))&&Array.isArray(doc.records)&&Array.isArray(doc.metrics),'invalid projection history');
    check(doc.asOf===null||Date.parse(doc.asOf)<=Date.now()+300000,'projection history is in the future');
    if(doc.status==='unavailable') { check(!doc.records.length&&!doc.metrics.length,'unavailable history has records');return doc; }
    check(doc.startedAt===null||time(doc.startedAt),'invalid projection history start');
    const keys=new Set(),exclusions=[null,'unpublished','duplicate_window','unavailable','limited','late_record','offer_present','missing_probability','window_open','incomplete_coverage','pending','unknown'];
    for(const r of doc.records) {
      check(object(r)&&['key','routeId','bank','modelVersion'].every(k=>nonempty(r[k]))&&!keys.has(r.key),'invalid projection identity');keys.add(r.key);
      check(time(r.issuedAt)&&time(r.recordedAt)&&[1,3,6].includes(r.months)&&date(r.startDate)&&date(r.endDate)&&r.startDate<=r.endDate
        &&(r.probability===null||rate(r.probability)),'invalid projection window');
      const rolling=validateDefinition(r,'projection');
      if(rolling) {validateRollingWindow(r,r.issuedAt,'projection');validateContext(r.context,'projection');}
      else check(r.days==null,'invalid projection calendar days');
      check(['displayed','unavailable','limited','late_record','offer_present'].includes(r.availability)
        &&['pending','observed','not_observed','unknown'].includes(r.status)
        &&[null,true,false].includes(r.coverageComplete)&&typeof r.evaluationEligible==='boolean'
        &&exclusions.includes(r.evaluationExclusion),'invalid projection outcome');
      if(r.observation!=null)check(object(r.observation)&&time(r.observation.observedAt)&&number(r.observation.pct),'invalid projection observation');
      if(r.publicationStatus!=null)check(['confirmed','unconfirmed'].includes(r.publicationStatus)
        &&(r.publishedAt===null||time(r.publishedAt)),'invalid projection publication');
      if(r.publicationStatus==='confirmed')check(time(r.publishedAt)&&Date.parse(r.recordedAt)<=Date.parse(r.publishedAt)
        &&Date.parse(r.issuedAt)<=Date.parse(r.publishedAt)&&r.publishedAt.slice(0,10)<r.startDate,'invalid confirmed publication');
      check(r.evaluationEligible===(r.evaluationExclusion===null),'inconsistent projection eligibility');
      if(r.evaluationEligible) check(r.availability==='displayed'&&r.publicationStatus==='confirmed'&&rate(r.probability)&&r.coverageComplete===true
        &&['observed','not_observed'].includes(r.status)&&doc.asOf&&r.endDate<doc.asOf.slice(0,10)
        &&r.issuedAt.slice(0,10)<r.startDate&&r.recordedAt.slice(0,10)<r.startDate,'unevaluable projection included');
    }
    for(const m of doc.metrics) {
      check(object(m)&&[1,3,6].includes(m.months)&&nonempty(m.modelVersion)
        &&['n','pending','unknown'].every(k=>Number.isInteger(m[k])&&m[k]>=0)
        &&['predictedRate','observedRate','trendAccuracy','brier','baselineBrier'].every(k=>m.n?rate(m[k]):m[k]===null),'invalid projection metrics');
      const rolling=validateDefinition(m,'projection metrics');
      check(rolling?m.days==={1:30,3:90,6:180}[m.months]:m.days==null,'invalid projection metrics days');
    }
    return doc;
  }
  async function fetchHistory(baseUrl,timeoutMs=15000) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetch(baseUrl.replace(/\/$/,'')+'/forecast-history.json',{cache:'no-cache',signal:controller.signal});
      if(!response.ok)throw new Error('forecast-history.json: HTTP '+response.status);
      return validateHistory(await response.json());
    } finally {clearTimeout(timer);controller.abort();}
  }
  const olderThan = (feed, other) => !!other && Date.parse(feed.generatedAt) < Date.parse(other.generatedAt);
  function storageGet(keys) {
    return new Promise((resolve, reject) => chrome.storage.local.get(keys, value => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(value || {});
    }));
  }
  function storageSet(values) {
    return new Promise((resolve, reject) => chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve();
    }));
  }
  const api = { validatePair, fetchPair, validateHistory, fetchHistory, olderThan, storageGet, storageSet };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TransferRadarData = api;
})(globalThis);
