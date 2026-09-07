import { fetchBeliefs, saveBeliefs } from "../../api";
import { DocumentAutosaveSession, type EditableDocument } from "./documentAutosave";

export const BELIEFS_DRAFT_KEY = "kinawatch.beliefs.draft.v1";

// Read drafts left by the explicit-save editor without accepting a newer file
// fingerprint as permission to overwrite an externally changed document.
export function decodeBeliefsDraft(value: unknown, document: EditableDocument): unknown {
  if (!value || typeof value !== "object" || !("markdown" in value) || !("fingerprint" in value)) return value;
  const draft = value as { markdown: unknown; fingerprint: { path?: unknown } | null };
  if (typeof draft.markdown !== "string" || draft.fingerprint?.path !== document.journal_fingerprint.path) return null;
  return { path: document.path, text: draft.markdown, baseline: draft.markdown, fingerprint: draft.fingerprint };
}

export const beliefsDocument = new DocumentAutosaveSession({
  load: fetchBeliefs,
  save: saveBeliefs,
  storageKey: () => BELIEFS_DRAFT_KEY,
  decodeDraft: decodeBeliefsDraft,
});

window.addEventListener("beforeunload", event => {
  if (!beliefsDocument.needsUnloadProtection) return;
  void beliefsDocument.flush();
  event.preventDefault(); event.returnValue = "";
});
window.addEventListener("online", () => {
  if (beliefsDocument.snapshot.status === "error" && beliefsDocument.dirty) void beliefsDocument.retry();
});
