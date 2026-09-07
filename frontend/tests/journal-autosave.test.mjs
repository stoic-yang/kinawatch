import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const directory = await mkdtemp(join(tmpdir(), "kinawatch-autosave-"));
after(() => rm(directory, { recursive: true, force: true }));
await build({ stdin: { contents: 'export {DocumentAutosaveSession} from "./documentAutosave"; export {decodeBeliefsDraft} from "./beliefsDocumentStore"; export {JournalDocumentSession} from "./journalDocumentStore"; export {ApiError} from "../../api";', resolveDir: fileURLToPath(new URL("../src/experiments/concepts", import.meta.url)) }, outfile: join(directory, "autosave.mjs"), bundle: true, platform: "node", format: "esm" });
globalThis.window = { addEventListener() {} };
const cache = new Map();
globalThis.localStorage = { getItem: key => cache.get(key) ?? null, setItem: (key, value) => cache.set(key, value), removeItem: key => cache.delete(key) };
const { DocumentAutosaveSession, decodeBeliefsDraft, JournalDocumentSession, ApiError } = await import(pathToFileURL(join(directory, "autosave.mjs")).href);
beforeEach(() => cache.clear());
const document = (markdown = "原文", version = 1, write_enabled = true) => ({ markdown, path: "Review/beliefs.md", journal_fingerprint: { path: "/synthetic/Review/beliefs.md", mtime_ns: String(version), size: markdown.length }, write_enabled });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(initial = document(), decodeDraft) {
  let file = initial;
  const writes = [];
  const adapter = { load: async () => file, save: async (text, fingerprint) => {
    writes.push({text, fingerprint});
    if (fingerprint.mtime_ns !== file.journal_fingerprint.mtime_ns) throw new ApiError(409, "Conflict");
    file = document(text, Number(fingerprint.mtime_ns) + 1); return file;
  }, storageKey: () => "draft", decodeDraft };
  return { adapter, writes, get file() {return file;}, set file(value) {file = value;}, session: new DocumentAutosaveSession(adapter) };
}

test("reading never writes; edits debounce and use the latest text", async t => {
  t.mock.timers.enable({apis:["setTimeout"]});
  const f = fixture(); await f.session.load();
  t.mock.timers.tick(1000); assert.equal(f.writes.length, 0);
  f.session.change("第一处"); t.mock.timers.tick(600); f.session.change("第二处");
  t.mock.timers.tick(699); assert.equal(f.writes.length, 0);
  t.mock.timers.tick(1); await Promise.resolve();
  assert.equal(f.writes.length, 1); assert.equal(f.file.markdown, "第二处");
  assert.equal(f.session.needsUnloadProtection, false);
});

test("typing during a save stays editable and the next write uses its confirmed fingerprint", async () => {
  const f = fixture(), gate = deferred(), save = f.adapter.save;
  f.adapter.save = async (text, fingerprint) => { if (text === "第一处") await gate.promise; return save(text, fingerprint); };
  await f.session.load(); f.session.change("第一处"); const first = f.session.flush();
  f.session.change("第二处"); await f.session.flush(); assert.equal(f.writes.length, 0);
  gate.resolve(); await first;
  assert.equal(f.session.snapshot.text, "第二处");
  await f.session.flush();
  assert.deepEqual(f.writes.map(w=>[w.text,w.fingerprint.mtime_ns]), [["第一处","1"],["第二处","2"]]);
  assert.equal(f.session.dirty, false); assert.equal(cache.has("draft"), false);
});

test("undoing to the original text while a save is in flight still restores that text in the file", async () => {
  const f = fixture(), gate = deferred(), save = f.adapter.save;
  f.adapter.save = async (...args) => { await gate.promise; return save(...args); };
  await f.session.load(); f.session.change("修改"); const first = f.session.flush();
  f.session.change("原文"); assert.equal(f.session.dirty, true);
  gate.resolve(); await first; await f.session.flush();
  assert.equal(f.file.markdown, "原文"); assert.equal(f.writes.length, 2);
});

test("an uncertain save response is reconciled by reading before retrying", async () => {
  const f = fixture(), save = f.adapter.save;
  f.adapter.save = async (...args) => { await save(...args); throw new Error("Response lost"); };
  await f.session.load(); f.session.change("已到达文件"); await f.session.flush();
  assert.equal(f.session.snapshot.status, "error"); assert.ok(cache.has("draft"));
  f.session.change("继续输入"); await f.session.flush(); assert.equal(f.writes.length, 1);
  f.adapter.save = save; await f.session.retry();
  assert.equal(f.file.markdown, "继续输入"); assert.equal(f.writes[1].fingerprint.mtime_ns, "2");
  assert.equal(f.session.snapshot.status, "saved");
});

test("reload after an unconfirmed successful request recovers newer typing without a false conflict", async () => {
  const f = fixture(document("请求已写入",2));
  cache.set("draft",JSON.stringify({path:f.file.path,text:"请求期间的新输入",baseline:"原文",fingerprint:document().journal_fingerprint,pendingSent:"请求已写入"}));
  await f.session.load(); assert.equal(f.session.snapshot.status,"pending");
  await f.session.flush();
  assert.equal(f.file.markdown,"请求期间的新输入"); assert.equal(f.writes[0].fingerprint.mtime_ns,"2");
});

test("external edits pause autosave, survive reload, and require a version choice", async () => {
  const f = fixture(); await f.session.load();
  f.session.change("我的草稿"); f.file = document("外部版本", 2); await f.session.flush();
  assert.equal(f.session.snapshot.status, "conflict");
  const restored = new DocumentAutosaveSession(f.adapter); await restored.load();
  assert.equal(restored.snapshot.status, "conflict"); assert.equal(restored.snapshot.text, "我的草稿");
  await restored.flush(); assert.equal(f.writes.length, 1);
  restored.resolveConflict("draft"); await Promise.resolve();
  assert.equal(f.file.markdown, "我的草稿"); assert.equal(f.writes.at(-1).fingerprint.mtime_ns, "2");
});

test("adopting the file version never writes a draft", async () => {
  const f = fixture(); await f.session.load(); f.session.change("草稿");
  f.file = document("外部版本", 2); await f.session.flush(); await f.session.inspectConflict();
  f.session.resolveConflict("remote"); await f.session.flush();
  assert.equal(f.writes.length, 1); assert.equal(f.session.snapshot.text, "外部版本"); assert.equal(f.session.dirty, false);
});

test("legacy beliefs drafts retain absolute fingerprints and recover with relative response paths", async () => {
  const f = fixture(document(), decodeBeliefsDraft);
  cache.set("draft", JSON.stringify({markdown:"旧编辑器草稿",fingerprint:f.file.journal_fingerprint}));
  await f.session.load(); assert.equal(f.session.snapshot.text,"旧编辑器草稿");
  await f.session.flush(); assert.equal(f.file.markdown,"旧编辑器草稿");
});

test("legacy conflicts cannot become automatic overwrite permission on a second reload", async () => {
  const f = fixture(document("外部版本",2), decodeBeliefsDraft);
  cache.set("draft", JSON.stringify({markdown:"旧草稿",fingerprint:document().journal_fingerprint}));
  await f.session.load(); assert.equal(f.session.snapshot.status,"conflict");
  const again = new DocumentAutosaveSession(f.adapter); await again.load(); await again.flush();
  assert.equal(again.snapshot.status,"conflict"); assert.equal(f.writes.length,0);
});

test("read-only notes cannot edit or autosave recovered drafts; another provider's draft is retained", async () => {
  const f = fixture(document("原文",1,false)); await f.session.load();
  f.session.change("修改"); await f.session.flush(); assert.equal(f.writes.length,0);
  assert.equal(f.session.snapshot.text,"原文");
  const other = JSON.stringify({markdown:"另一份草稿", fingerprint:{...f.file.journal_fingerprint,path:"/other/beliefs.md"}});
  cache.set("draft",other); await new DocumentAutosaveSession(f.adapter).load();
  assert.equal(cache.get("draft"),other);
});

test("a delayed refresh cannot overwrite typing that started after the read", async () => {
  const f=fixture(), gate=deferred(); await f.session.load();
  f.adapter.load=()=>gate.promise; const read=f.session.load(); f.session.change("新输入");
  gate.resolve(document("旧响应",2)); await read;
  assert.equal(f.session.snapshot.text,"新输入"); await f.session.flush();
  assert.equal(f.file.markdown,"新输入");
});

test("the daily adapter keeps each date, endpoint and stored draft identity separate", async () => {
  const requests=[];
  globalThis.fetch=async (url, options={}) => {
    requests.push({url,options});
    const body=options.body ? JSON.parse(options.body) : null;
    const date=body?.date ?? new URL(url,"http://localhost").searchParams.get("date");
    return {ok:true,json:async()=>({...document(body?.markdown ?? date,body?2:1), date, path:`Daily/${date}.md`,provider:"local",journal_fingerprint:{path:`/synthetic/Daily/${date}.md`,mtime_ns:String(body?2:1),size:(body?.markdown ?? date).length}})};
  };
  const first=new JournalDocumentSession("2026-09-01"), second=new JournalDocumentSession("2026-09-02");
  await first.load(); await second.load(); first.change("第一天修改");
  const savedDraft=JSON.parse([...cache.values()][0]); assert.equal(savedDraft.date,"2026-09-01");
  await first.flush();
  assert.equal(JSON.parse(requests.at(-1).options.body).date,"2026-09-01");
  assert.equal(JSON.parse(requests.at(-1).options.body).expected_fingerprint.path,"/synthetic/Daily/2026-09-01.md");
  assert.equal(second.snapshot.text,"2026-09-02");
});
