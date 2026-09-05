import { ApiError, fetchJournalDocument, saveJournalDocument, type FileFingerprint, type JournalDocumentResponse } from "../../api";

type Status = "loading" | "ready" | "pending" | "saving" | "saved" | "error" | "conflict";
export type DocumentSnapshot = {
  document: JournalDocumentResponse | null;
  text: string;
  status: Status;
  error: string | null;
  remote: JournalDocumentResponse | null;
  savedRevision: number;
};
type StoredDraft = {date: string; path: string; text: string; baseline: string; fingerprint: FileFingerprint; pendingSent?: string};
const entries = new Map<string, JournalDocumentSession>();
const sameFingerprint = (a: FileFingerprint, b: FileFingerprint) => a.path === b.path && a.mtime_ns === b.mtime_ns && a.size === b.size;
const storageKey = (document: JournalDocumentResponse) => `kinawatch:journal-draft:v1:${document.provider}:${document.path}:${document.date}`;

/** A session survives date navigation, so a pending response can only affect its own note. */
export class JournalDocumentSession {
  snapshot: DocumentSnapshot = {document: null, text: "", status: "loading", error: null, remote: null, savedRevision: 0};
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving = false;
  private loading = false;
  private version = 0;
  private failedText: string | null = null;
  private inFlightText: string | null = null;
  private persistenceFailed = false;
  constructor(readonly date: string) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;
  get dirty() {
    const uncertain = this.inFlightText ?? this.failedText;
    return Boolean(this.snapshot.document && (this.snapshot.status === "conflict" || this.snapshot.text !== this.snapshot.document.markdown || uncertain !== null && this.snapshot.text !== uncertain));
  }
  private publish(patch: Partial<DocumentSnapshot>) {
    this.snapshot = {...this.snapshot, ...patch};
    this.listeners.forEach(listener => listener());
  }
  private persist() {
    const doc = this.snapshot.document;
    if (!doc) return;
    try {
      if (this.dirty) {
        const draft: StoredDraft = {date: this.date, path: doc.path, text: this.snapshot.text, baseline: doc.markdown, fingerprint: doc.journal_fingerprint, pendingSent: this.inFlightText ?? this.failedText ?? undefined};
        localStorage.setItem(storageKey(doc), JSON.stringify(draft));
      } else localStorage.removeItem(storageKey(doc));
      this.persistenceFailed = false;
    } catch { this.persistenceFailed = true; }
  }
  async load() {
    if (this.loading || this.saving || this.dirty) return;
    this.loading = true;
    const version = this.version;
    try {
      const doc = await fetchJournalDocument(this.date);
      // Do not replace text if typing started during a background refresh.
      if (version !== this.version || this.dirty || this.saving) return;
      let draft: StoredDraft | null = null;
      try {
        const parsed = JSON.parse(localStorage.getItem(storageKey(doc)) || "null");
        if (parsed?.date === this.date && parsed.path === doc.path && typeof parsed.text === "string" && typeof parsed.baseline === "string" && parsed.fingerprint?.path === doc.journal_fingerprint.path) draft = parsed;
      } catch { /* A blocked storage area must not prevent opening the note. */ }
      this.publish({document: doc, text: doc.markdown, status: "ready", error: null, remote: null});
      if (draft && draft.text !== doc.markdown) {
        const compatible = sameFingerprint(draft.fingerprint, doc.journal_fingerprint) || draft.baseline === doc.markdown || typeof draft.pendingSent === "string" && draft.pendingSent === doc.markdown;
        // A conflicting draft must retain the version it was actually edited
        // against, including across another reload. Adopting the fresh file's
        // fingerprint here would silently authorize overwriting that file.
        this.publish({document: compatible ? doc : {...doc, markdown: draft.baseline, journal_fingerprint: draft.fingerprint}, text: draft.text, status: compatible ? "pending" : "conflict", error: compatible ? null : "文件已有其他修改，已保留这份未同步的草稿。", remote: compatible ? null : doc});
        this.persist();
        if (compatible && doc.write_enabled) this.schedule();
      } else this.persist();
    } catch (reason) {
      if (version === this.version) this.publish({status: "error", error: reason instanceof Error ? reason.message : "日记读取失败"});
    } finally { this.loading = false; }
  }
  change = (text: string) => {
    if (!this.snapshot.document?.write_enabled || text === this.snapshot.text) return;
    this.version += 1;
    const blocked = this.snapshot.status === "conflict" || this.snapshot.status === "error";
    this.publish({text, status: blocked ? this.snapshot.status : this.saving ? "saving" : text === this.snapshot.document.markdown ? "saved" : "pending"});
    this.persist();
    if (!blocked) this.schedule();
  };
  private schedule(delay = 700) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, delay);
  }
  async flush() {
    clearTimeout(this.timer);
    const doc = this.snapshot.document;
    if (this.saving || !this.dirty || !doc?.write_enabled || this.snapshot.status === "conflict" || this.snapshot.status === "error") return;
    const sent = this.snapshot.text;
    this.inFlightText = sent;
    this.saving = true;
    this.publish({status: "saving", error: null});
    try {
      const result = await saveJournalDocument(this.date, sent, doc.journal_fingerprint);
      this.failedText = null;
      this.publish({document: result, text: this.snapshot.text === sent ? result.markdown : this.snapshot.text, status: this.snapshot.text === sent ? "saved" : "pending", savedRevision: this.snapshot.savedRevision + 1});
      this.persist();
    } catch (reason) {
      this.failedText = sent;
      this.publish({status: reason instanceof ApiError && reason.status === 409 ? "conflict" : "error", error: reason instanceof ApiError && reason.status === 409 ? "文件已在其他地方修改，自动保存已暂停，草稿仍在这里。" : `暂未同步到文件，草稿已保留。${reason instanceof Error ? reason.message : "连接失败"}`});
      this.persist();
    } finally {
      this.saving = false;
      this.inFlightText = null;
      if (this.dirty && this.snapshot.status === "pending") this.schedule(0);
    }
  }
  /** Recover an uncertain response by reading first; never blindly replay a stale PUT. */
  async retry() {
    if (!this.snapshot.document) { await this.load(); return; }
    if (this.saving) return;
    try {
      const latest = await fetchJournalDocument(this.date);
      if (latest.path !== this.snapshot.document.path) throw new Error("日记存储位置已改变，请保留草稿后重新打开。");
      if (latest.markdown === this.snapshot.text) {
        this.failedText = null;
        this.publish({document: latest, status: "saved", error: null, remote: null});
        this.persist();
      } else if (sameFingerprint(latest.journal_fingerprint, this.snapshot.document.journal_fingerprint) || latest.markdown === this.snapshot.document.markdown || latest.markdown === this.failedText) {
        this.failedText = null;
        this.publish({document: latest, status: "pending", error: null, remote: null});
        this.persist();
        await this.flush();
      } else this.publish({status: "conflict", error: "文件已有其他修改，请先核对两个版本。", remote: latest});
    } catch (reason) { this.publish({error: reason instanceof Error ? reason.message : "读取失败"}); }
  }
  async inspectConflict() {
    try { this.publish({remote: await fetchJournalDocument(this.date)}); }
    catch (reason) { this.publish({error: reason instanceof Error ? reason.message : "文件版本读取失败"}); }
  }
  resolveConflict(choice: "remote" | "draft") {
    const remote = this.snapshot.remote;
    if (!remote || remote.path !== this.snapshot.document?.path) return;
    this.version += 1;
    this.failedText = null;
    this.publish({document: remote, text: choice === "remote" ? remote.markdown : this.snapshot.text, status: choice === "remote" ? "ready" : "pending", remote: null, error: null});
    this.persist();
    if (choice === "draft") void this.flush();
  }
  get needsUnloadProtection() { return this.saving || this.dirty || this.persistenceFailed; }
}

export function journalDocumentSession(date: string) {
  let entry = entries.get(date);
  if (!entry) { entry = new JournalDocumentSession(date); entries.set(date, entry); }
  return entry;
}

window.addEventListener("beforeunload", event => {
  if (![...entries.values()].some(entry => entry.needsUnloadProtection)) return;
  entries.forEach(entry => { void entry.flush(); });
  event.preventDefault();
  event.returnValue = "";
});
window.addEventListener("online", () => entries.forEach(entry => {
  if (entry.snapshot.status === "error" && entry.dirty) void entry.retry();
}));
