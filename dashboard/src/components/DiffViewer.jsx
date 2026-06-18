import { FileCode2, RotateCcw } from 'lucide-react';

export function DiffViewer({ file, content, diff, onUndo, canUndo }) {
  const lines = (content || '// Выберите файл слева, чтобы увидеть его содержимое').split('\n');
  return <section className="diff-panel">
    <header><div><FileCode2 size={15}/><strong>{file || 'Файл не выбран'}</strong></div><button onClick={onUndo} disabled={!canUndo}><RotateCcw size={14}/>Откатить запуск</button></header>
    {diff ? <div className="split-diff" aria-label="Изменения последнего запуска"><DiffSide kind="removed" lines={diff.removed} start={diff.startLine}/><DiffSide kind="added" lines={diff.added} start={diff.startLine}/></div>
      : <div className="code-view" aria-label="Просмотр выбранного файла">{lines.map((line, index) => <div className="code-line" key={index}><span>{index + 1}</span><code>{line || ' '}</code></div>)}</div>}
  </section>;
}

function DiffSide({ kind, lines, start }) { return <div className={`diff-side ${kind}`}>{(lines.length ? lines : ['']).map((line, index) => <div className="code-line" key={index}><span>{start + index}</span><b>{kind === 'removed' ? '−' : '+'}</b><code>{line || ' '}</code></div>)}</div>; }
