import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { diagnoseCode, type Diag } from '../sandbox/diagnose';

// ---- 定制主题：贴合「军用工控终端」风格 ----
const tfTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px', backgroundColor: '#0a0f1e' },
  '.cm-scroller': { fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: '#070b17', color: '#3b4a6b', borderRight: '1px solid rgba(0,229,255,.12)' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,229,255,.055)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(0,229,255,.08)', color: '#00e5ff' },
  '.cm-cursor': { borderLeftColor: '#00e5ff', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(0,229,255,.18) !important' },
});

export interface CodeEditorProps {
  value: string;
  onChange?: (v: string) => void;
  readOnly?: boolean;
  placeholder?: string;
  /** 输入后 debounce 回调语法诊断（仅非 readOnly） */
  onDiag?: (d: Diag) => void;
  className?: string;
}

function baseExts(readOnly: boolean, hint: string): Extension[] {
  return [
    basicSetup,
    oneDark,
    tfTheme,
    javascript(),
    readOnly ? EditorState.readOnly.of(true) : keymap.of([indentWithTab]),
    cmPlaceholder(hint || '// 在此编写 decide(ctx) 策略逻辑…'),
    EditorView.lineWrapping,
  ];
}

export function CodeEditor({ value, onChange, readOnly = false, placeholder, onDiag, className }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onDiagRef = useRef(onDiag);
  const readOnlyRef = useRef(readOnly);
  const timerRef = useRef<number>(0);
  onChangeRef.current = onChange;
  onDiagRef.current = onDiag;
  readOnlyRef.current = readOnly;

  // 初始化：创建编辑器 + 注入输入监听（listener 内经 ref 取最新回调）
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...baseExts(readOnly, placeholder ?? ''),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return;
            const doc = u.state.doc.toString();
            onChangeRef.current?.(doc);
            if (readOnlyRef.current) return;
            window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => {
              onDiagRef.current?.(diagnoseCode(doc));
            }, 500);
          }),
        ],
      }),
    });
    viewRef.current = view;
    const id = window.setTimeout(() => {
      if (!readOnlyRef.current) onDiagRef.current?.(diagnoseCode(value));
    }, 200);
    return () => {
      window.clearTimeout(id);
      window.clearTimeout(timerRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部 value 变化 → 同步进编辑器
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
  }, [value]);

  return <div ref={hostRef} className={`code-editor-host ${readOnly ? 'readonly' : ''} ${className ?? ''}`} />;
}
