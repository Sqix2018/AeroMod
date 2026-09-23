// Rebuild takes from Documents/aerox-tas/tape.log.
//
// Every RECORD tick writes "REC i s= t= b= y= e=" and every PLAY / CONTINUE
// tick writes "PLAY i row=s,t,b,y,e" (MISS for a mismatch). Runs append until
// the file passes 4MB, so a deleted or overwritten macro is usually still
// there. Each BEGIN starts a segment; within one, a later line for the same
// index wins (rewind re-records) and sets the take's length to index + 1.
//
// Lines with raw=s.t.y[.preYaw] (f32 hex) rebuild the row bit for bit. Older
// tapes only have 4 decimals and no pre-tick yaw, and drift fast.

const log = require('../core/log');

const MIN_FRAMES = 60;
const KEEP = 8;

function num(v) {
    const n = parseFloat(v);
    return isFinite(n) ? n : 0;
}

const RAW = / raw=([0-9a-f]+)\.([0-9a-f]+)\.([0-9a-f]+)(?:\.([0-9a-f]+))?/;

// Swap in the exact f32 values when the line has them.
function exact(row, line, seg) {
    const m = RAW.exec(line);
    if (!m) return row;
    const f = require('./macro').bitsf32;
    row[0] = f(parseInt(m[1], 16));
    row[1] = f(parseInt(m[2], 16));
    row[3] = f(parseInt(m[3], 16));
    if (m[4] !== undefined) row.push(f(parseInt(m[4], 16)));
    seg.exact += 1;
    return row;
}

function parseTape(text) {
    const segs = [];
    let cur = null;
    const lines = text.split('\n');
    const begin = /BEGIN (REC|PLAY|CONTINUE)\b(?:\s+(\d+)f)?.*?level (-?\d+)/;
    const rec = /\bREC (\d+) s=(\S+) t=(\S+) b=(\d+) y=(\S+) e=(\d+)/;
    const play = /\b(?:PLAY|MISS) (\d+) row=([^,\s]+),([^,\s]+),(\d+),([^,\s]+),(\d+)/;
    for (let k = 0; k < lines.length; k++) {
        const line = lines[k];
        let m = begin.exec(line);
        if (m) {
            cur = { kind: m[1], level: parseInt(m[3], 10), rows: [], len: 0, recs: 0, plays: 0, exact: 0,
                at: line.slice(0, 12).trim() };
            segs.push(cur);
            continue;
        }
        if (cur === null) continue;
        m = rec.exec(line);
        if (m) {
            const i = parseInt(m[1], 10);
            cur.rows[i] = exact([num(m[2]), num(m[3]), parseInt(m[4], 10) | 0, num(m[5]), parseInt(m[6], 10) | 0], line, cur);
            cur.len = i + 1;
            cur.recs += 1;
            continue;
        }
        m = play.exec(line);
        if (m) {
            const i = parseInt(m[1], 10);
            cur.rows[i] = exact([num(m[2]), num(m[3]), parseInt(m[4], 10) | 0, num(m[5]), parseInt(m[6], 10) | 0], line, cur);
            cur.len = i + 1;
            cur.plays += 1;
        }
    }
    return segs;
}

function finish(seg) {
    const out = [];
    let gaps = 0;
    let last = [0, 0, 0, 0, 0];
    for (let i = 0; i < seg.len; i++) {
        const r = seg.rows[i];
        if (r === undefined) {
            gaps += 1;
            out.push([0, 0, 0, last[3], 0]);
        } else {
            out.push(r);
            last = r;
        }
    }
    return { frames: out, gaps };
}

function signature(frames) {
    let h = frames.length;
    for (let i = 0; i < frames.length; i++) {
        const r = frames[i];
        h = (h * 31 + Math.round(r[0] * 1e4) * 7 + Math.round(r[1] * 1e4) * 13
            + r[2] * 17 + Math.round(r[3] * 1e4) * 19 + r[4] * 23) | 0;
    }
    return h;
}

// Writes up to KEEP newest distinct takes as "tape NN KIND LENf" under each
// take's level. Returns a short status line.
function fromTape() {
    const macro = require('./macro');
    const dir = macro.macroDirectory();
    if (dir === null) return 'no Documents folder';
    const path = `${dir}/tape.log`;
    const text = ObjC.classes.NSString.stringWithContentsOfFile_encoding_error_(path, 4, NULL);
    if (text === null) return 'no tape.log';
    const segs = parseTape(text.toString());
    const seen = {};
    const picked = [];
    for (let s = segs.length - 1; s >= 0 && picked.length < KEEP; s--) {
        const seg = segs[s];
        if (seg.len < MIN_FRAMES || seg.rows[0] === undefined) continue;
        const f = finish(seg);
        if (f.gaps > seg.len / 10) continue;
        const sig = `${seg.level}/${signature(f.frames)}`;
        if (seen[sig]) continue;
        seen[sig] = true;
        picked.push({ n: s + 1, seg, f });
    }
    log.info(`recover: ${segs.length} run(s) in tape.log, saving ${picked.length} distinct take(s)`, 'macro');
    picked.forEach(p => {
        const kind = p.seg.kind === 'CONTINUE' ? 'CONT' : p.seg.kind;
        const name = `tape ${String(p.n).padStart(2, '0')} ${kind} ${p.seg.len}f`;
        const ok = macro.saveFrames(name, p.seg.level, p.f.frames);
        log.info(`  L${p.seg.level} "${name}"  ${p.seg.at}  rec lines ${p.seg.recs}`
            + `  play lines ${p.seg.plays}${p.f.gaps ? `  gaps ${p.f.gaps}` : ''}`
            + (p.seg.exact >= p.seg.recs + p.seg.plays ? '  EXACT' : '  approx (old tape)')
            + (ok ? '' : '  SAVE FAILED'), 'macro');
    });
    return picked.length
        ? `recovered ${picked.length} take(s) as "tape NN ..." - see console`
        : 'nothing recoverable in tape.log';
}

module.exports = { fromTape, parseTape };
