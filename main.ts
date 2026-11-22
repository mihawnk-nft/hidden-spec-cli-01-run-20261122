// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit made (old -> new), for the `R` output line (section 2). */
  readonly moves: Array<{ old: string; nw: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 5 to 8: line matching, unified diffs, SEARCH/REPLACE, V4A.
// ---------------------------------------------------------------------------

/** A file's lines, its line break, and whether it ends with one (section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One body line of a hunk or chunk: context, old, new, or a `\` line. */
type BodyLine = { k: 'ctx' | 'del' | 'add' | 'bs'; t: string };

/** One line of N: a context line (its index into O) or an added line. */
type NItem = { ctx: number } | { add: string };

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') === b.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in `lines` at `tier`, at or after `from` (overlaps allowed). */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions (section 5). */
function firstTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The lines that replace O's match at `pos` (section 5): context lines are the file's own. */
function replacement(fileLines: string[], pos: number, o: string[], n: NItem[], tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = o.length > 0 ? leadingWs(fileLines[pos]!) : '';
  for (const item of n) {
    if ('ctx' in item) {
      out.push(fileLines[pos + item.ctx]!);
      continue;
    }
    const text = item.add;
    if (tier === 2 && text !== '' && text.trim() !== '' && text.startsWith(p)) out.push(f + text.slice(p.length));
    else out.push(text);
  }
  return out;
}

/** Split O and N out of a hunk or chunk body; also whether a `\` line follows its last context/`+` line. */
function splitBody(body: BodyLine[]): { o: string[]; n: NItem[]; bsAfterLast: boolean } {
  const o: string[] = [];
  const n: NItem[] = [];
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b.k === 'ctx') { o.push(b.t); n.push({ ctx: o.length - 1 }); last = k; }
    else if (b.k === 'del') o.push(b.t);
    else if (b.k === 'add') { n.push({ add: b.t }); last = k; }
  }
  return { o, n, bsAfterLast: last >= 0 && body[last + 1] !== undefined && body[last + 1]!.k === 'bs' };
}

// --- Section 6: unified diffs ------------------------------------------------

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(.*) b\/(.*)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** A `---`/`+++` path: text after the four characters, up to the first tab, trimmed; /dev/null is no file. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = stripPrefix(s.trim());
  return s === '/dev/null' ? null : s;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let pairSeen = false;
  let i = 0;
  const n = lines.length;
  const newSection = (diffOld: string | undefined, diffNew: string | undefined): USection => {
    const s: USection = { diffOld, diffNew, pairOld: undefined, pairNew: undefined, renameOld: undefined, renameNew: undefined, create: false, del: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l === 'diff --git' || l.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(l);
      if (m === null || m[1] === '' || m[2] === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      pairSeen = false;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !pairSeen) {
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        pairSeen = true;
      } else {
        cur = newSection(undefined, undefined);
        cur.pairOld = headerPath(l);
        cur.pairNew = headerPath(lines[i + 1]!);
        pairSeen = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) { cur.renameOld = stripPrefix(l.slice(12).trim()); i++; continue; }
      if (l.startsWith('rename to ')) { cur.renameNew = stripPrefix(l.slice(10).trim()); i++; continue; }
      if (l === 'new file mode' || l.startsWith('new file mode ')) { cur.create = true; i++; continue; }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) { cur.del = true; i++; continue; }
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') { hunk.body.push({ k: 'ctx', t: '' }); i++; continue; }
        if (b.startsWith(' ')) { hunk.body.push({ k: 'ctx', t: b.slice(1) }); i++; continue; }
        if (b.startsWith('-')) { hunk.body.push({ k: 'del', t: b.slice(1) }); i++; continue; }
        if (b.startsWith('+')) { hunk.body.push({ k: 'add', t: b.slice(1) }); i++; continue; }
        if (b.startsWith('\\')) { hunk.body.push({ k: 'bs', t: b }); i++; continue; }
        break;
      }
      while (hunk.body.length > 0) {
        const lastB = hunk.body[hunk.body.length - 1]!;
        if (lastB.k === 'ctx' && lastB.t === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : (s.diffOld ?? null);
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : (s.diffNew ?? null);
  const isDelete = (newPath === null || s.del) && oldPath !== null;
  const isCreate = !isDelete && (oldPath === null || s.create);
  const isMove = !isDelete && !isCreate && oldPath !== newPath;
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreate) {
      if (newPath === null) throw new Fail('unsafe', '/dev/null');
      const np = newPath;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.k === 'add') plus.push(b.t);
      let bs = false;
      let foundAdd = false;
      for (let hi = s.hunks.length - 1; hi >= 0 && !foundAdd; hi--) {
        const h = s.hunks[hi]!;
        for (let k = h.body.length - 1; k >= 0; k--) {
          if (h.body[k]!.k === 'add') {
            bs = h.body[k + 1] !== undefined && h.body[k + 1]!.k === 'bs';
            foundAdd = true;
            break;
          }
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (bs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    if (isMove) {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
    }
    const f = parseFile(cur);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n, bsAfterLast } = splitBody(h.body);
      if (o.length > 0) {
        const found = firstTier(f.lines, o, 0, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) { best = p; bestDist = dist; }
        }
        const rep = replacement(f.lines, best, o, n, found.tier);
        const toEnd = best + o.length === f.lines.length;
        f.lines.splice(best, o.length, ...rep);
        if (toEnd) f.final = !bsAfterLast;
        d += n.length - o.length;
      } else {
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = at === f.lines.length;
        const adds: string[] = [];
        for (const item of n) if ('add' in item) adds.push(item.add);
        f.lines.splice(at, 0, ...adds);
        if (atEnd) f.final = !bsAfterLast;
        d += adds.length;
      }
    }
    if (isMove) {
      const np = newPath!;
      tree.now.set(np, renderFile(f));
      tree.now.set(op, null);
      tree.moves.push({ old: op, nw: np });
    } else {
      tree.now.set(op, renderFile(f));
    }
  };
}

// --- Section 7: SEARCH/REPLACE blocks ----------------------------------------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  const n = lines.length;
  const marker = (l: string, m: string): boolean => l.trimEnd() === m;
  while (i < n) {
    if (!marker(lines[i]!, '<<<<<<< SEARCH')) { i++; continue; }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchNo}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      if (marker(lines[j]!, '=======')) { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (marker(lines[j]!, '>>>>>>> REPLACE')) { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = firstTier(f.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const items: NItem[] = newLines.map((t) => ({ add: t }));
    const rep = replacement(f.lines, pos, oldLines, items, found.tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, renderFile(f));
  };
}

// --- Section 8: V4A patches ---------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k]!.trim() !== '') { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < end) {
    const l = lines[i]!;
    if (l.trim() === '') { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      i++;
      const fileLines: string[] = [];
      while (i < end) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s === '') { fileLines.push(''); i++; continue; }
        if (s.startsWith('+')) { fileLines.push(s.slice(1)); i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i++;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const updateNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      const closeChunk = (eof: boolean): void => {
        if (chunk !== null) {
          chunk.eof = eof;
          chunks.push(chunk);
          chunk = null;
        }
      };
      while (i < end) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s.trim() === '') {
          if (chunk !== null) chunk.body.push({ k: 'ctx', t: '' });
          i++;
          continue;
        }
        if (s === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
          closeChunk(true);
          i++;
          continue;
        }
        if (s.startsWith('@@')) {
          closeChunk(false);
          const anchorText = s.slice(2).trim();
          chunk = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          i++;
          continue;
        }
        if (s.startsWith(' ') || s.startsWith('-') || s.startsWith('+')) {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
            chunk = { anchor: null, body: [], eof: false };
          }
          chunk.body.push(s.startsWith(' ') ? { k: 'ctx', t: s.slice(1) } : s.startsWith('-') ? { k: 'del', t: s.slice(1) } : { k: 'add', t: s.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      closeChunk(false);
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        if (!lc.eof) {
          while (lc.body.length > 0) {
            const lb = lc.body[lc.body.length - 1]!;
            if (lb.k === 'ctx' && lb.t === '') lc.body.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const foundAnchor = firstTier(f.lines, [ch.anchor], cursor, strict);
        if (foundAnchor === null) throw new Fail('no-match', path);
        cursor = foundAnchor.pos[0]! + 1;
      }
      const { o, n } = splitBody(ch.body);
      if (o.length > 0) {
        let found: { tier: number; pos: number[] } | null = null;
        if (ch.eof) {
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            const pos = occurrences(f.lines, o, t, cursor).filter((p) => p + o.length === f.lines.length);
            if (pos.length > 0) { found = { tier: t, pos }; break; }
          }
        } else {
          found = firstTier(f.lines, o, cursor, strict);
        }
        if (found === null) throw new Fail('no-match', path);
        const pos = found.pos[0]!;
        const rep = replacement(f.lines, pos, o, n, found.tier);
        f.lines.splice(pos, o.length, ...rep);
        cursor = pos + rep.length;
      } else {
        const at = ch.eof ? f.lines.length : cursor;
        const adds: string[] = [];
        for (const item of n) if ('add' in item) adds.push(item.add);
        f.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
      }
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, renderFile(f));
      tree.now.set(path, null);
      tree.moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, renderFile(f));
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rByNew = new Map<string, string>();
  for (const m of tree.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null && !rByNew.has(m.nw)) {
      rByNew.set(m.nw, m.old);
    }
  }
  const covered = new Set<string>();
  for (const [nw, old] of rByNew) { covered.add(nw); covered.add(old); }
  const rows: Array<{ key: string; text: string }> = [];
  for (const [nw, old] of rByNew) rows.push({ key: nw, text: `R ${old} -> ${nw}` });
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.get(p)!;
    if (was === now) continue;
    if (covered.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
