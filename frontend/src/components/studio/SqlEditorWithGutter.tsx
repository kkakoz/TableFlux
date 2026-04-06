import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Play } from "lucide-react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import type * as Monaco from "monaco-editor";
import { parseSqlStatements, type ParsedSqlStatement } from "../../utils/sqlStatements";

type Props = {
  value: string;
  onChange: (v: string | undefined) => void;
  onMount: (editor: MonacoEditorNS.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  height: string;
  /** 执行某一条完整语句（gutter 或 Ctrl+R） */
  onExecuteStatement: (sql: string) => void | Promise<void>;
  /** 是否禁用 gutter 按钮（如无连接） */
  executeDisabled?: boolean;
};

const DEFAULT_LINE_HEIGHT = 19;

export default function SqlEditorWithGutter({
  value,
  onChange,
  onMount,
  height,
  onExecuteStatement,
  executeDisabled,
}: Props) {
  const [scrollTop, setScrollTop] = useState(0);
  const [lineHeight, setLineHeight] = useState(DEFAULT_LINE_HEIGHT);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);

  const statements = useMemo(() => parseSqlStatements(value ?? ""), [value]);
  const lineCount = useMemo(() => {
    if (!value) return 1;
    return value.split(/\r?\n/).length;
  }, [value]);

  const stmtByStartLine = useMemo(() => {
    const m = new Map<number, ParsedSqlStatement>();
    for (const s of statements) {
      m.set(s.startLine, s);
    }
    return m;
  }, [statements]);

  const innerHeight = Math.max(lineCount, 1) * lineHeight;

  const handleMount = useCallback(
    (editor: MonacoEditorNS.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = editor.onDidScrollChange(() => {
        setScrollTop(editor.getScrollTop());
      });
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      if (lh > 0) setLineHeight(lh);
      setScrollTop(editor.getScrollTop());
      onMount(editor, monaco);
    },
    [onMount],
  );

  useEffect(() => {
    return () => {
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-row">
      <div
        className="sql-gutter-viewport shrink-0 overflow-hidden border-r border-slate-200/90 bg-[#f3f4f6]"
        style={{ width: 52 }}
        aria-hidden
      >
        <div
          className="relative box-border"
          style={{
            height: innerHeight,
            transform: `translateY(-${scrollTop}px)`,
            willChange: "transform",
          }}
        >
          {Array.from({ length: lineCount }, (_, idx) => {
            const lineNo = idx + 1;
            const stmt = stmtByStartLine.get(lineNo);
            return (
              <div
                key={lineNo}
                className="group/line flex items-stretch border-b border-transparent text-[11px] leading-none text-slate-400 hover:bg-slate-300/25"
                style={{ height: lineHeight, minHeight: lineHeight }}
              >

                <div className="flex min-w-0 flex-1 select-none items-center justify-end pr-1.5 tabular-nums text-slate-400">
                  {lineNo}
                </div>
                <div className="flex w-[22px] shrink-0 items-center justify-center border-r border-slate-200/60 bg-[#eceef1] group-hover/line:bg-[#e4e6ea]">
                    {stmt ? (
                        <button
                            type="button"
                            disabled={executeDisabled}
                            title="执行该语句"
                            className="flex h-5 w-5 items-center justify-center rounded bg-transparent text-emerald-600 hover:bg-transparent hover:text-emerald-600 disabled:cursor-not-allowed disabled:text-slate-400 disabled:opacity-40"
                            onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                if (!stmt || executeDisabled) return;
                                void onExecuteStatement(stmt.sql);
                            }}
                        >
                            <Play className="h-3 w-3" fill="currentColor" strokeWidth={0} />
                        </button>
                    ) : (
                        <span className="h-3 w-3" />
                    )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="min-h-0 min-w-0 flex-1">
        <Editor
          height={height}
          language="sql"
          value={value}
          onChange={onChange}
          onMount={handleMount}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            wordWrap: "on",
            automaticLayout: true,
            suggestOnTriggerCharacters: true,
            lineNumbers: "off",
            glyphMargin: false,
            folding: true,
            lineDecorationsWidth: 4,
            lineNumbersMinChars: 0,
          }}
        />
      </div>
    </div>
  );
}
