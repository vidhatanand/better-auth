// Bench diagnostics (0.4.7 dependency store A/B): fetch a spread sample of the lockfile's registry tarballs through the
// Vibernt dependency store with the job's store token (read from the runner's ~/.npmrc, never printed) and tally where
// the store answered from (x-vibernt-store: edge = the colo's cache, r2, upstream/pass) and the colo (cf-ray suffix).
// Usage: node store-colo-probe.mjs <label>. Prints one summary line; exits 0 whatever happens.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const label = process.argv[2] || 'probe';
try {
    const npmrc = readFileSync(join(homedir(), '.npmrc'), 'utf8').split('\n');
    const registry = npmrc.map(l => /^registry=(https?:\/\/\S+\/npm\/)\s*$/.exec(l)?.[1]).find(Boolean);
    if (!registry) { console.log(`store probe ${label}: no dependency store in ~/.npmrc`); process.exit(0); }
    const nerf = registry.replace(/^https?:/, '');
    const token = npmrc.find(l => l.startsWith(`${nerf}:_authToken=`))?.slice(nerf.length + 12).trim();
    const lock = readFileSync('pnpm-lock.yaml', 'utf8');
    const entries = [];
    let key = null, section = null;
    for (const line of lock.split('\n')) {
        if (line && !line.startsWith(' ')) { section = line.replace(/:\s*$/, '').trim(); continue; }
        if (section !== 'packages') continue;
        const m = /^ {2}['"]?\/?((?:@[^/@\s'"]+\/)?[^/@\s'"(]+)[@/]([0-9][^(:'"\s]*)(?:\([^:]*\))?['"]?:\s*$/.exec(line);
        if (m) { key = [m[1], m[2]]; continue; }
        if (key && /^ {4}resolution:\s*\{.*integrity:\s*sha512-/.test(line) && !/tarball:|directory:/.test(line)) entries.push(key);
        if (/^ {4}resolution:/.test(line)) key = null;
    }
    const n = 40, step = entries.length / n;
    const sample = Array.from({ length: Math.min(n, entries.length) }, (_, i) => entries[Math.floor((i + 0.5) * step)]);
    const tally = {}, colos = {}, times = [];
    let bytes = 0;
    const queue = [...sample];
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 8 }, async () => {
        while (queue.length) {
            const [name, version] = queue.shift();
            const url = `${registry}${name}/-/${encodeURIComponent(name.split('/').pop())}-${encodeURIComponent(version)}.tgz`;
            const t = performance.now();
            try {
                const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'user-agent': 'vibernt-bench-colo-probe/1' } });
                const b = Buffer.from(await r.arrayBuffer());
                bytes += b.length;
                const src = r.ok ? (r.headers.get('x-vibernt-store') || 'none') : `status-${r.status}`;
                tally[src] = (tally[src] || 0) + 1;
                const colo = (r.headers.get('cf-ray') || '').split('-').pop() || '?';
                colos[colo] = (colos[colo] || 0) + 1;
            } catch { tally.error = (tally.error || 0) + 1; }
            times.push(performance.now() - t);
        }
    }));
    times.sort((a, b) => a - b);
    const p = q => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))]);
    console.log(`store probe ${label}: ${sample.length} tarballs ${(bytes / 1048576).toFixed(1)} MiB in ${((performance.now() - t0) / 1000).toFixed(2)} s; sources ${JSON.stringify(tally)}; colo ${JSON.stringify(colos)}; per request p50 ${p(0.5)} ms p90 ${p(0.9)} ms`);
} catch (e) { console.log(`store probe ${label}: failed (${String(e).slice(0, 120)})`); }
