import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import { Play, Square } from "lucide-react";
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
  /** 当前正在执行的 SQL 文本（用于 gutter 匹配高亮） */
  runningSQL?: string;
  /** 停止当前正在执行的 SQL */
  onStopStatement?: () => void;
};

const DEFAULT_LINE_HEIGHT = 19;

export default function SqlEditorWithGutter({
  value,
  onChange,
  onMount,
  height,
  onExecuteStatement,
  executeDisabled,
  runningSQL,
  onStopStatement,
}: Props) {
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [lineHeight, setLineHeight] = useState(DEFAULT_LINE_HEIGHT);
  /** Monaco 真实行起始 Y 坐标数组（index 0 = 第 1 行），由 getTopForLineNumber 获取 */
  const [linePositions, setLinePositions] = useState<number[]>([]);
  /** Monaco 内容总高度 */
  const [scrollHeight, setScrollHeight] = useState(DEFAULT_LINE_HEIGHT);
  const scrollDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const contentDisposablesRef = useRef<Array<{ dispose: () => void }>>([]);

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

  /** 从 Monaco 读取所有行的真实 Y 坐标 */
  const syncLayout = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const count = editor.getModel()?.getLineCount() ?? 0;
    const positions: number[] = [];
    for (let i = 1; i <= count; i++) {
      positions.push(editor.getTopForLineNumber(i));
    }
    setLinePositions(positions);
    setScrollHeight(editor.getScrollHeight());
    setScrollTop(editor.getScrollTop());
  }, []);

  const handleMount = useCallback(
    (editor: MonacoEditorNS.IStandaloneCodeEditor, monaco: typeof Monaco) => {
      editorRef.current = editor;

      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = editor.onDidScrollChange(() => {
        setScrollTop(editor.getScrollTop());
      });

      for (const d of contentDisposablesRef.current) d.dispose();
      contentDisposablesRef.current = [
        editor.onDidChangeModelContent(syncLayout),
        editor.onDidLayoutChange(syncLayout),
      ];

      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight);
      if (lh > 0) setLineHeight(lh);

      syncLayout();
      onMount(editor, monaco);
    },
    [onMount, syncLayout],
  );

  useEffect(() => {
    return () => {
      scrollDisposableRef.current?.dispose();
      scrollDisposableRef.current = null;
      for (const d of contentDisposablesRef.current) d.dispose();
      contentDisposablesRef.current = [];
    };
  }, []);

  /** 当 value 从外部改变时（如粘贴），重新同步行位置 */
  useEffect(() => {
    syncLayout();
  }, [value, syncLayout]);

  /** 回退：editor 未 mount 时用等高行估算 */
  const fallbackPositions = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => i * lineHeight),
    [lineCount, lineHeight],
  );

  const resolvedPositions = linePositions.length === lineCount ? linePositions : fallbackPositions;
  const resolvedScrollHeight = linePositions.length === lineCount ? scrollHeight : lineCount * lineHeight;

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-row">
      <div
        className="sql-gutter-viewport shrink-0 overflow-hidden border-r border-slate-200/90 bg-[#f3f4f6]"
        style={{ width: 52 }}
        aria-hidden
      >
        <div
          className="relative"
          style={{
            height: resolvedScrollHeight,
            transform: `translateY(-${scrollTop}px)`,
            willChange: "transform",
          }}
        >
          {resolvedPositions.map((top, idx) => {
            const lineNo = idx + 1;
            const stmt = stmtByStartLine.get(lineNo);
            const nextTop = resolvedPositions[idx + 1] ?? resolvedScrollHeight;
            const rowHeight = Math.max(nextTop - top, lineHeight);
            return (
              <div
                key={lineNo}
                className="group/line absolute flex w-full items-stretch border-b border-transparent text-[11px] leading-none text-slate-400 hover:bg-slate-300/25"
                style={{ top, height: rowHeight }}
              >
                <div className="flex min-w-0 flex-1 select-none items-center justify-end pr-1.5 tabular-nums text-slate-400">
                  {lineNo}
                </div>
                <div className="flex w-[22px] shrink-0 items-center justify-center border-r border-slate-200/60 bg-[#eceef1] group-hover/line:bg-[#e4e6ea]">
                  {stmt ? (() => {
                    const isAnyRunning = !!runningSQL;
                    const isThisRunning = isAnyRunning && stmt.sql.trim() === runningSQL?.trim();
                    if (isThisRunning) {
                      return (
                        <button
                          type="button"
                          title="停止执行"
                          className="flex h-5 w-5 items-center justify-center rounded bg-transparent text-red-600 hover:bg-transparent hover:text-red-700"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onStopStatement?.();
                          }}
                        >
                          <Square className="h-3 w-3" fill="currentColor" strokeWidth={0} />
                        </button>
                      );
                    }
                    return (
                      <button
                        type="button"
                        disabled={executeDisabled || isAnyRunning}
                        title="执行该语句"
                        className="flex h-5 w-5 items-center justify-center rounded bg-transparent text-emerald-600 hover:bg-transparent hover:text-emerald-600 disabled:cursor-not-allowed disabled:text-slate-400 disabled:opacity-40"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!stmt || executeDisabled || isAnyRunning) return;
                          void onExecuteStatement(stmt.sql);
                        }}
                      >
                        <Play className="h-3 w-3" fill="currentColor" strokeWidth={0} />
                      </button>
                    );
                  })() : (
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
            padding: { top: 0, bottom: 0 },
          }}
        />
      </div>
    </div>
  );
}
