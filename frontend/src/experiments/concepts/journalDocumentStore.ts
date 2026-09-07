import { fetchJournalDocument, saveJournalDocument, type JournalDocumentResponse } from "../../api";
import { DocumentAutosaveSession, type AutosaveSnapshot } from "./documentAutosave";

export type DocumentSnapshot = AutosaveSnapshot<JournalDocumentResponse>;
const entries = new Map<string, JournalDocumentSession>();

/** Each date keeps its own session while navigation changes the visible page. */
export class JournalDocumentSession extends DocumentAutosaveSession<JournalDocumentResponse> {
  constructor(readonly date: string) {
    super({
      load: () => fetchJournalDocument(date),
      save: (text, fingerprint) => saveJournalDocument(date, text, fingerprint),
      storageKey: document => `kinawatch:journal-draft:v1:${document.provider}:${document.path}:${date}`,
      draftIdentity: {date},
    });
  }
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
