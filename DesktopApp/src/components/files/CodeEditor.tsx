import { useEffect, useRef, useState } from 'react';
import { Annotation, Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
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
  focusToken?: number;
};

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

export type TextChange = { from: number; to: number; insert: string };

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export function diffRange(oldText: string, newText: string): TextChange | null {
  if (oldText === newText) return null;
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix -= 1;
  let suffix = 0;
  const suffixLimit = limit - prefix;
  while (suffix < suffixLimit && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix += 1;
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix -= 1;
  return { from: prefix, to: oldText.length - suffix, insert: newText.slice(prefix, newText.length - suffix) };
}

const normalizeLineBreaks = (text: string) => text.replace(/\r\n/g, '\n');

const isDarkTheme = () => document.documentElement.getAttribute('data-theme') === 'dark';

const buildTheme = (dark: boolean): Extension => EditorView.theme({
  '&': { height: '100%', color: 'var(--color-fg)', backgroundColor: 'var(--color-bg-elev)', fontSize: '12.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6', overflow: 'auto' },
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

export function CodeEditor({ value, path, onChange, onSave, focused, focusToken }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [compartments] = useState(() => ({ language: new Compartment(), theme: new Compartment(), history: new Compartment() }));
  const lastEmittedRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const initialRef = useRef({ value, focused });
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { language, theme, history: undoHistory } = compartments;
    const view = new EditorView({
      parent: container,
      state: EditorState.create({
        doc: initialRef.current.value,
        extensions: [
          EditorState.lineSeparator.of('\n'),
          EditorView.clipboardInputFilter.of(normalizeLineBreaks),
          lineNumbers(),
          undoHistory.of(history()),
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
            const text = update.state.doc.toString();
            lastEmittedRef.current = text;
            onChangeRef.current(text);
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
  }, [compartments]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || value === lastEmittedRef.current) return;
    lastEmittedRef.current = value;
    const change = diffRange(view.state.doc.toString(), value);
    if (!change) return;
    view.dispatch({
      changes: change,
      effects: compartments.history.reconfigure([]),
      annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    });
    view.dispatch({ effects: compartments.history.reconfigure(history()) });
  }, [value, compartments]);

  useEffect(() => {
    let cancelled = false;
    void loadLanguage(path).then((extension) => {
      const view = viewRef.current;
      if (cancelled || !view) return;
      view.dispatch({ effects: compartments.language.reconfigure(extension ?? []) });
    }).catch(() => {
      console.warn('[files] language load failed', fileName(path));
    });
    return () => { cancelled = true; };
  }, [path, compartments]);

  useEffect(() => {
    if (focused) viewRef.current?.focus();
  }, [focused, focusToken]);

  return <div ref={containerRef} className="h-full min-h-0 font-mono" />;
}
