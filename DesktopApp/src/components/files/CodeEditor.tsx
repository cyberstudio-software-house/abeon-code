import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { HighlightStyle, LanguageDescription, StreamLanguage, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { fileName } from '../../lib/fileText';

type Props = {
  value: string;
  path: string;
  onChange: (value: string) => void;
  onSave: () => void;
  focused: boolean;
};

const MONO_FONT = "'Geist Mono', ui-monospace, monospace";
const SELECTION = 'color-mix(in srgb, var(--color-accent) 30%, transparent)';

const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.controlKeyword, tags.operatorKeyword], color: 'var(--color-accent)' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.attributeName], color: 'var(--color-success)' },
  { tag: [tags.number, tags.integer, tags.float], color: 'var(--color-info)' },
  { tag: [tags.bool, tags.null, tags.atom, tags.self], color: 'var(--color-pink)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--color-muted)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], color: 'var(--color-info)' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], color: 'var(--color-teal)' },
  { tag: [tags.propertyName, tags.labelName], color: 'var(--color-fg)' },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket, tags.meta], color: 'var(--color-fg-secondary)' },
  { tag: [tags.heading, tags.strong], color: 'var(--color-fg-strong)', fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--color-info)', textDecoration: 'underline' },
  { tag: tags.invalid, color: 'var(--color-danger)' },
]);

const externalChange = Annotation.define<boolean>();

const isDarkTheme = () => document.documentElement.getAttribute('data-theme') === 'dark';

const buildTheme = (dark: boolean): Extension => EditorView.theme({
  '&': { height: '100%', color: 'var(--color-fg)', backgroundColor: 'var(--color-bg-elev)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: MONO_FONT, lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--color-accent)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-content ::selection, .cm-line::selection': { backgroundColor: SELECTION },
  '.cm-gutters': { backgroundColor: 'var(--color-bg-elev)', color: 'var(--color-faint)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: SELECTION, outline: 'none' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--color-warn) 35%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 45%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--color-bg-elev-2)', color: 'var(--color-fg)', borderColor: 'var(--color-border)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--color-border)' },
  '.cm-panel.cm-search': { fontFamily: 'inherit', fontSize: '12px' },
  '.cm-textfield': {
    backgroundColor: 'var(--color-field)',
    color: 'var(--color-fg)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: '6px',
  },
  '.cm-button': {
    backgroundImage: 'none',
    backgroundColor: 'var(--color-button)',
    color: 'var(--color-fg)',
    border: '1px solid var(--color-border-strong)',
    borderRadius: '6px',
  },
  '.cm-panel.cm-search label': { color: 'var(--color-fg-secondary)' },
}, { dark });

async function loadLanguage(path: string): Promise<Extension | null> {
  const name = fileName(path);
  if (name.startsWith('.env')) {
    const { properties } = await import('@codemirror/legacy-modes/mode/properties');
    return StreamLanguage.define(properties);
  }
  const description = LanguageDescription.matchFilename(languages, name);
  return description ? description.load() : null;
}

export function CodeEditor({ value, path, onChange, onSave, focused }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const languageRef = useRef(new Compartment());
  const themeRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const initialRef = useRef({ value, focused });
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const language = languageRef.current;
    const theme = themeRef.current;
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialRef.current.value,
        extensions: [
          EditorState.lineSeparator.of('\n'),
          lineNumbers(),
          history(),
          bracketMatching(),
          search({ top: true }),
          syntaxHighlighting(highlightStyle),
          language.of([]),
          theme.of(buildTheme(isDarkTheme())),
          keymap.of([
            { key: 'Mod-s', run: () => { onSaveRef.current(); return true; } },
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || update.transactions.some((tr) => tr.annotation(externalChange))) return;
            onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (initialRef.current.focused) view.focus();
    const observer = new MutationObserver(() => {
      view.dispatch({ effects: theme.reconfigure(buildTheme(isDarkTheme())) });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      observer.disconnect();
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    const { anchor, head } = view.state.selection.main;
    const scrollTop = view.scrollDOM.scrollTop;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: EditorSelection.single(Math.min(anchor, value.length), Math.min(head, value.length)),
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    });
    view.scrollDOM.scrollTop = scrollTop;
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    void loadLanguage(path).then((extension) => {
      const view = viewRef.current;
      if (cancelled || !view) return;
      view.dispatch({ effects: languageRef.current.reconfigure(extension ?? []) });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    if (focused) viewRef.current?.focus();
  }, [focused]);

  return <div ref={containerRef} className="h-full min-h-0" />;
}
