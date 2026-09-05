import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, keymap, placeholder as editorPlaceholder, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownEdit } from "./journalPresentation";
import "./MarkdownDocumentEditor.css";

export type MarkdownDocumentEditorHandle = {
  focus(): void;
  /** Offset in the original controlled Markdown string, including its line endings. */
  focusHeading(offset: number): void;
};

export type MarkdownDocumentEditorProps = {
  value: string;
  onChange(value: string, edits: MarkdownEdit[]): void;
  readOnly?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  id?: string;
  className?: string;
};

const externalChange = Annotation.define<boolean>();
const focusChanged = StateEffect.define<boolean>();
const hiddenSyntax = Decoration.replace({ inclusive: false });
const syntaxMark = Decoration.mark({ class: "md-syntax" });

class Bullet extends WidgetType {
  eq() { return true; }
  toDOM() {
    const element = document.createElement("span");
    element.className = "md-list-bullet";
    element.textContent = "•";
    element.setAttribute("aria-hidden", "true");
    return element;
  }
  ignoreEvent() { return false; }
}
const bullet = Decoration.replace({ widget: new Bullet(), inclusive: false });

class CalloutIcon extends WidgetType {
  constructor(readonly label: string) { super(); }
  eq(other: CalloutIcon) { return this.label === other.label; }
  toDOM() {
    const element = document.createElement("span");
    element.className = "md-callout-icon";
    const icon = document.createElement("span");
    icon.textContent = "▤";
    icon.setAttribute("aria-hidden", "true");
    element.append(icon);
    if (this.label) {
      const label = document.createElement("span");
      label.className = "md-callout-default-title";
      label.textContent = this.label;
      element.append(label);
    }
    return element;
  }
  ignoreEvent() { return false; }
}

class TaskCheckbox extends WidgetType {
  constructor(readonly at: number, readonly checked: boolean, readonly readOnly: boolean) { super(); }
  eq(other: TaskCheckbox) { return this.at === other.at && this.checked === other.checked && this.readOnly === other.readOnly; }
  toDOM(view: EditorView) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "md-task-checkbox";
    input.checked = this.checked;
    input.disabled = this.readOnly;
    input.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为已完成");
    input.addEventListener("mousedown", event => event.preventDefault());
    input.addEventListener("change", () => {
      if (!view.state.readOnly) view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: input.checked ? "x" : " " } });
    });
    return input;
  }
  ignoreEvent() { return true; }
}

function markdownDecorations(state: EditorState, focused: boolean) {
  const decorations: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const replaced: { from: number; to: number }[] = [];
  const lines = new Map<number, Set<string>>();
  const active = focused && !state.readOnly ? state.selection.ranges.map(range => ({
    from: state.doc.lineAt(range.from).from,
    to: state.doc.lineAt(range.to).to,
  })) : [];
  const isActive = (from: number, to: number) => active.some(range => from <= range.to && to >= range.from);
  const mark = (from: number, to: number, className: string) => {
    if (to > from) decorations.push(Decoration.mark({ class: className }).range(from, to));
  };
  const lineClass = (at: number, className: string) => {
    const from = state.doc.lineAt(at).from;
    const classes = lines.get(from) ?? new Set<string>();
    classes.add(className);
    lines.set(from, classes);
  };
  const blockLines = (from: number, to: number, className: string) => {
    const last = state.doc.lineAt(to).number;
    for (let number = state.doc.lineAt(from).number; number <= last; number++) {
      lineClass(state.doc.line(number).from, className);
    }
  };
  const token = (from: number, to: number, trimFollowingSpace = false) => {
    if (to <= from) return;
    if (isActive(from, to)) decorations.push(syntaxMark.range(from, to));
    else {
      if (trimFollowingSpace) {
        const line = state.doc.lineAt(to);
        to += /^[\t ]*/.exec(state.doc.sliceString(to, line.to))![0].length;
      }
      decorations.push(hiddenSyntax.range(from, to));
    }
  };

  const calloutLines = new Set<number>();
  syntaxTree(state).iterate({ enter(node) {
    if (node.name === "Blockquote") {
      const line = state.doc.lineAt(node.from);
      const header = /^([ \t]*(?:>[ \t]*)+)\[!([\w-]+)\][+-]?[ \t]*(.*)$/.exec(line.text);
      if (!header || calloutLines.has(line.from)) return;
      calloutLines.add(line.from);
      blockLines(node.from, node.to, "md-callout");
      lineClass(line.from, "md-callout-header");
      lineClass(node.to, "md-callout-end");
      const to = line.to - header[3].length;
      replaced.push({ from: line.from, to });
      if (isActive(line.from, line.to)) mark(line.from, to, "md-syntax");
      else {
        const names: Record<string, string> = { abstract: "摘要", summary: "摘要", note: "笔记", info: "信息", tip: "提示", warning: "提醒", todo: "待办" };
        decorations.push(Decoration.replace({ widget: new CalloutIcon(header[3] ? "" : names[header[2]] ?? header[2]), inclusive: false }).range(line.from, to));
      }
    } else if (node.name === "CommentBlock" || node.name === "Comment") {
      const internal = /<!--\s*kinawatch:/.test(state.doc.sliceString(node.from, node.to));
      if (!internal && isActive(node.from, node.to)) return;
      const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
      const wholeLine = /^[\s>]*$/.test(state.doc.sliceString(first.from, node.from)) && !state.doc.sliceString(node.to, last.to).trim();
      const from = wholeLine ? first.from : node.from;
      const to = wholeLine && last.to < state.doc.length ? last.to + 1 : node.to;
      const decoration = Decoration.replace({ block: wholeLine, inclusiveStart: wholeLine, inclusiveEnd: false }).range(from, to);
      decorations.push(decoration);
      replaced.push({ from, to });
      if (internal) atomic.push(decoration);
    }
  } });

  // Decorations change presentation only. Hidden comments remain in the source.
  syntaxTree(state).iterate({
    enter(node) {
      if (replaced.some(range => node.from >= range.from && node.to <= range.to)) return false;
      const name = node.name;
      const parent = node.node.parent?.name ?? "";
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
      if (heading) lineClass(node.from, `md-heading md-heading-${heading[1]}`);
      else if (name === "StrongEmphasis") mark(node.from, node.to, "md-strong");
      else if (name === "Emphasis") mark(node.from, node.to, "md-emphasis");
      else if (name === "Strikethrough") mark(node.from, node.to, "md-strike");
      else if (name === "InlineCode") mark(node.from, node.to, "md-inline-code");
      else if (name === "FencedCode" || name === "CodeBlock") {
        blockLines(node.from, node.to, "md-code-block");
        lineClass(node.from, "md-code-start");
        lineClass(node.to, "md-code-end");
      } else if (name === "ListItem") blockLines(node.from, node.to, "md-list-line");
      else if (name === "Blockquote") blockLines(node.from, node.to, "md-blockquote");
      else if (name === "TaskMarker" && !isActive(node.from, node.to)) {
        const checked = /[xX]/.test(state.doc.sliceString(node.from, node.to));
        decorations.push(Decoration.replace({ widget: new TaskCheckbox(node.from, checked, state.readOnly), inclusive: false }).range(node.from, node.to));
        if (checked) lineClass(node.from, "md-task-complete");
      }
      else if (name === "Table") blockLines(node.from, node.to, "md-table-row");
      else if (name === "TableHeader") lineClass(node.from, "md-table-header");
      else if (name === "TableDelimiter") mark(node.from, node.to, "md-table-delimiter");
      else if (name === "HeaderMark") {
        const line = state.doc.lineAt(node.from);
        const opening = /^\s*$/.test(state.doc.sliceString(line.from, node.from));
        token(node.from, node.to, parent.startsWith("ATXHeading") && opening);
      } else if (name === "EmphasisMark" || name === "StrikethroughMark") token(node.from, node.to);
      else if (name === "CodeMark") {
        if (parent === "FencedCode") lineClass(node.from, "md-code-fence");
        token(node.from, node.to);
      } else if (name === "CodeInfo") mark(node.from, node.to, "md-code-info");
      else if (name === "QuoteMark") token(node.from, node.to, true);
      else if (name === "ListMark") {
        const text = state.doc.sliceString(node.from, node.to);
        const task = /^[\t ]+\[[ xX]\]/.test(state.doc.sliceString(node.to, state.doc.lineAt(node.to).to));
        if (task) token(node.from, node.to, true);
        else decorations.push(!isActive(node.from, node.to) && /^[-+*]$/.test(text)
          ? bullet.range(node.from, node.to)
          : syntaxMark.range(node.from, node.to));
      } else if (name === "Link") {
        const children = node.node.getChildren("LinkMark");
        const opening = children[0];
        const closing = children.find(child => state.doc.sliceString(child.from, child.to) === "]");
        if (opening && closing && state.doc.lineAt(node.from).number === state.doc.lineAt(node.to).number) {
          mark(opening.to, closing.from, "md-link");
          if (!isActive(node.from, node.to)) {
            decorations.push(hiddenSyntax.range(opening.from, opening.to));
            decorations.push(hiddenSyntax.range(closing.from, node.to));
          } else mark(node.from, node.to, "md-link-source");
        }
      }
    },
  });
  for (const [from, classes] of lines) {
    decorations.push(Decoration.line({ class: [...classes].join(" ") }).range(from));
  }
  return { decorations: Decoration.set(decorations, true), atomic: Decoration.set(atomic, true) };
}

// Direct state decorations keep heading and code-block height stable before
// CodeMirror computes its viewport, including when a hidden page reappears.
const liveMarkdown = StateField.define<{ focused: boolean; decorations: DecorationSet; atomic: DecorationSet }>({
  create(state) { return { focused: false, ...markdownDecorations(state, false) }; },
  update(value, transaction) {
    let focused = value.focused;
    for (const effect of transaction.effects) if (effect.is(focusChanged)) focused = effect.value;
    if (!transaction.docChanged && !transaction.selection && focused === value.focused
      && transaction.startState.readOnly === transaction.state.readOnly
      && syntaxTree(transaction.startState) === syntaxTree(transaction.state)) return value;
    return { focused, ...markdownDecorations(transaction.state, focused) };
  },
  provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).atomic)],
});

export const MarkdownDocumentEditor = forwardRef<MarkdownDocumentEditorHandle, MarkdownDocumentEditorProps>(function MarkdownDocumentEditor(
  { value, onChange, readOnly = false, ariaLabel = "日记正文", placeholder = "写日记…", id, className = "" },
  forwardedRef,
) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const latest = useRef({ value, onChange, readOnly, ariaLabel, placeholder, id });
  latest.current = { value, onChange, readOnly, ariaLabel, placeholder, id };
  const options = useRef(new Compartment());
  const composition = useRef(false);
  const compositionFrame = useRef<number | null>(null);
  const syncValue = useRef<() => void>(() => {});

  function editorOptions() {
    const props = latest.current;
    return [
      EditorState.readOnly.of(props.readOnly),
      EditorView.editable.of(!props.readOnly),
      EditorView.contentAttributes.of({
        role: "textbox", "aria-label": props.ariaLabel, "aria-multiline": "true",
        "aria-readonly": String(props.readOnly), tabindex: "0", spellcheck: "false",
        ...(props.id ? { id: props.id } : {}),
      }),
      editorPlaceholder(props.placeholder),
    ];
  }

  useImperativeHandle(forwardedRef, () => ({
    focus() { editor.current?.focus(); },
    focusHeading(offset) {
      const view = editor.current;
      if (!view || !Number.isFinite(offset)) return;
      const source = view.state.sliceDoc();
      const bounded = Math.max(0, Math.min(source.length, offset));
      const position = source.slice(0, bounded).split(view.state.lineBreak).join("\n").length;
      const line = view.state.doc.lineAt(Math.min(position, view.state.doc.length));
      const selection = EditorSelection.range(line.from, line.to);
      view.focus();
      view.dispatch({ selection, effects: EditorView.scrollIntoView(selection, { y: "center" }) });
    },
  }), []);

  useLayoutEffect(() => {
    const parent = container.current;
    if (!parent) return;
    // Preserve the existing document's newline convention on controlled echoes.
    const lineBreak = /\r\n|\n|\r/.exec(latest.current.value)?.[0] ?? "\n";
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.value,
        extensions: [
          EditorState.lineSeparator.of(lineBreak),
          options.current.of(editorOptions()),
          history(),
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          drawSelection(),
          liveMarkdown,
          EditorView.focusChangeEffect.of((_state, focused) => focusChanged.of(focused)),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(externalChange))) {
              const edits: MarkdownEdit[] = [];
              update.changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
                edits.push({ from: update.startState.sliceDoc(0, from).length, to: update.startState.sliceDoc(0, to).length, insert: inserted.sliceString(0, inserted.length, update.state.lineBreak) });
              });
              latest.current.onChange(update.state.sliceDoc(), edits);
            }
          }),
          EditorState.changeFilter.of(transaction => !transaction.startState.readOnly || transaction.annotation(externalChange) === true),
          EditorView.domEventHandlers({
            compositionstart() { composition.current = true; return false; },
            compositionend() {
              composition.current = false;
              if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current);
              compositionFrame.current = requestAnimationFrame(() => {
                compositionFrame.current = null;
                syncValue.current();
              });
              return false;
            },
          }),
        ],
      }),
    });
    editor.current = view;
    syncValue.current = () => {
      if (editor.current !== view || composition.current || view.composing || view.compositionStarted) return;
      const next = latest.current.value;
      if (view.state.sliceDoc() === next) return;
      const currentText = view.state.doc;
      const nextText = view.state.toText(next);
      const before = currentText.toString(), after = nextText.toString();
      let from = 0, suffix = 0;
      while (from < before.length && from < after.length && before[from] === after[from]) from++;
      while (suffix < before.length - from && suffix < after.length - from
        && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
      view.dispatch({
        changes: { from, to: before.length - suffix, insert: nextText.slice(from, after.length - suffix) },
        annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
      });
    };
    let contentWidth: number | undefined;
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === contentWidth) return;
      contentWidth = entry.contentRect.width;
      view.requestMeasure();
    });
    resize?.observe(parent);
    return () => {
      resize?.disconnect();
      if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current);
      composition.current = false;
      compositionFrame.current = null;
      syncValue.current = () => {};
      editor.current = null;
      view.destroy();
    };
  }, []);

  useLayoutEffect(() => { syncValue.current(); }, [value]);
  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: options.current.reconfigure(editorOptions()) });
  }, [readOnly, ariaLabel, placeholder, id]);

  return <div ref={container} className={`markdown-document-editor ${className}`.trim()} data-readonly={readOnly} />;
});
