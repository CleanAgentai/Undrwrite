require('dotenv').config();
const KEY = process.env.RENDER_API_KEY, SID = process.env.RENDER_SERVICE_ID;
const TARGET = process.argv[2] || '';
(async () => {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`https://api.render.com/v1/services/${SID}/deploys?limit=3`, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    const j = await r.json();
    const d = (j[0] || {}).deploy || j[0];
    const commit = (d.commit && d.commit.id || '').slice(0, 7);
    const status = d.status;
    const fin = d.finishedAt || '';
    console.log(`[poll ${i}] status=${status} commit=${commit} target=${TARGET.slice(0,7)} ${fin}`);
    if (commit === TARGET.slice(0, 7) && status === 'live') { console.log('DEPLOY LIVE ✓ @', fin); process.exit(0); }
    if (status === 'build_failed' || status === 'update_failed' || status === 'canceled') { console.error('DEPLOY FAILED:', status); process.exit(2); }
    await new Promise(res => setTimeout(res, 20000));
  }
  console.error('timed out waiting for deploy'); process.exit(3);
})();
