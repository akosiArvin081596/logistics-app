const KEY = process.env.N8N_API_KEY;
if (!KEY) { console.error('N8N_API_KEY required'); process.exit(1); }

(async () => {
  const r = await fetch('https://sandhub.app.n8n.cloud/api/v1/workflows/ydFgTSFpKTyyZbXW', {
    headers: { 'X-N8N-API-KEY': KEY }
  });
  const wf = JSON.parse(await r.text());
  const c = wf.connections;

  const checks = ['Validate Load ID','JOB DETAILS ENTRY','Addresses Ready?','AI Agent','Update Job Details (Distance)','Update Job Tracking (Distance)'];
  console.log('=== Key path ===');
  for (const n of checks) {
    const out = c[n];
    if (!out) { console.log(n, '-> (no outgoing)'); continue; }
    const branches = out.main || [];
    branches.forEach(function(b, i) {
      b.forEach(function(e) { console.log(n, '[branch' + i + '] ->', e.node); });
    });
  }

  const replayLeft = wf.nodes.filter(function(n) { return n.name === 'Replay Webhook' || n.name === 'Replay Get Email'; });
  console.log('');
  console.log('Replay nodes remaining:', replayLeft.length === 0 ? 'none (clean)' : replayLeft.map(function(n){return n.name;}).join(', '));
  console.log('Total nodes:', wf.nodes.length);

  const lp = wf.nodes.find(function(n) { return n.name === 'LlamaParse Upload'; });
  const parseMode = lp.parameters.bodyParameters.parameters.find(function(p) { return p.name === 'parse_mode'; });
  console.log('LlamaParse parse_mode:', parseMode ? parseMode.value : '(default/none)');

  const guard = wf.nodes.find(function(n) { return n.name === 'Addresses Ready?'; });
  console.log('Guard node present:', guard ? 'yes' : 'NO - MISSING');
  if (guard) console.log('Guard position:', guard.position);
})().catch(function(e) { console.error(e.message); process.exit(1); });
