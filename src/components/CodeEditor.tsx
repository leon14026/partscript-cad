import { indentWithTab, defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { autocompletion, completeFromList, completionKeymap } from '@codemirror/autocomplete';
import { HighlightStyle, StreamLanguage, bracketMatching, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, setDiagnostics } from '@codemirror/lint';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { Annotation, EditorState, Transaction } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Diagnostic } from '../engine/protocol.ts';

const keywords = ['module', 'function', 'for', 'if', 'else', 'let', 'each', 'assert', 'echo', 'intersection_for', 'include', 'use'];
const builtins = ['cube', 'cylinder', 'sphere', 'translate', 'rotate', 'mirror', 'union', 'difference', 'intersection', 'children', 'part', 'joint'];
const language = StreamLanguage.define({
  name: 'openscad',
  startState: () => ({ comment: false }),
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
  token(stream, state) {
    if (state.comment || stream.match('/*')) {
      state.comment = true;
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.comment = false;
          break;
        }
        stream.next();
      }
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/"(?:\\.|[^"\\])*"?/)) return 'string';
    if (stream.match(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i)) return 'number';
    const name = stream.match(/\$?[A-Za-z_][A-Za-z_\d]*/);
    if (Array.isArray(name)) {
      if (keywords.includes(name[0])) return 'keyword';
      if (builtins.includes(name[0])) return 'builtin';
      if (['true', 'false', 'undef'].includes(name[0])) return 'atom';
      if (stream.match(/\s*\(/, false)) return 'variableName.function';
      return 'variableName';
    }
    if (stream.match(/[+*/%=!&|<>?:^-]+/)) return 'operator';
    stream.next();
    return 'punctuation';
  },
});

const colors = HighlightStyle.define([
  { tag: tags.comment, color: '#606b60', fontStyle: 'italic' },
  { tag: tags.keyword, color: '#90406f', fontWeight: '500' },
  { tag: [tags.standard(tags.variableName), tags.function(tags.variableName)], color: '#17598b', fontWeight: '500' },
  { tag: [tags.number, tags.bool, tags.atom], color: '#a14328' },
  { tag: tags.string, color: '#3e6852' },
  { tag: tags.variableName, color: '#273f45' },
  { tag: tags.operator, color: '#696454' },
  { tag: tags.punctuation, color: '#777368' },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: '#263038' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: 'var(--code-size)', lineHeight: '1.72' },
  '.cm-content': { padding: '13px 0 24px', caretColor: '#263038' },
  '.cm-line': { padding: '0 15px 0 13px' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: '#7c7b72', paddingLeft: '9px', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 3px', minWidth: '30px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#efede6' },
  '.cm-activeLineGutter': { color: '#453a2e' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#dce8eb' },
  '.cm-selectionMatch': { backgroundColor: '#d8e8e5' },
  '.cm-matchingBracket': { color: '#304237', backgroundColor: '#d9eadb' },
  '.cm-tooltip': { fontFamily: 'var(--sans)', backgroundColor: '#fffdfa', border: '1px solid #d6d2c9', borderRadius: '6px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete ul': { fontFamily: 'var(--mono)', fontSize: '12px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: '#244850' },
});

const externalDocument = Annotation.define<boolean>();

function caret(view: EditorView) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1, count: view.state.doc.lines };
}

export interface EditorControl {
  goToLine(line: number): void;
}

export interface EditorProps {
  source: string;
  diagnostic?: Diagnostic;
  onChange(source: string): void;
  onCaret(position: ReturnType<typeof caret>): void;
}

export const CodeEditor = forwardRef<EditorControl, EditorProps>(function CodeEditor(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;

  useImperativeHandle(ref, () => ({
    goToLine(number) {
      const editor = view.current;
      if (!editor) return;
      const line = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, number)));
      editor.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
      editor.focus();
    },
  }), []);

  useEffect(() => {
    const parent = container.current;
    if (!parent) return;
    const editor = new EditorView({
      parent,
      doc: current.current.source,
      extensions: [
        lineNumbers(), lintGutter(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(),
        history(), bracketMatching(), highlightSelectionMatches(), editorTheme, EditorView.lineWrapping,
        EditorState.tabSize.of(4), indentUnit.of('    '), language, syntaxHighlighting(colors),
        language.data.of({ autocomplete: completeFromList([...builtins, ...keywords].map((label) => ({ label, type: builtins.includes(label) ? 'function' : 'keyword' }))) }),
        autocompletion(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...completionKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ 'aria-label': 'OpenSCAD source code', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((item) => item.annotation(externalDocument))) {
            current.current.onChange(update.state.doc.toString());
          }
          if (update.selectionSet || update.docChanged) current.current.onCaret(caret(update.view));
        }),
      ],
    });
    view.current = editor;
    current.current.onCaret(caret(editor));
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === props.source) return;
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.source },
      annotations: [externalDocument.of(true), Transaction.addToHistory.of(false)],
    });
  }, [props.source]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const diagnostic = props.diagnostic;
    if (!diagnostic?.line || diagnostic.line < 1 || diagnostic.line > editor.state.doc.lines) {
      editor.dispatch(setDiagnostics(editor.state, []));
      return;
    }
    const line = editor.state.doc.line(diagnostic.line);
    editor.dispatch(setDiagnostics(editor.state, [{
      from: line.from, to: line.to, severity: 'error', message: diagnostic.message,
    }]));
  }, [props.diagnostic]);

  return <div className="code-editor" ref={container} />;
});
