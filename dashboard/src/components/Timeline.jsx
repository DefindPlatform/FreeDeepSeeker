import { useEffect, useRef, useState } from 'react';
import { Check, Circle, LoaderCircle, Maximize2, Minimize2, TerminalSquare } from 'lucide-react';

function statusIcon(status) {
  if (status === 'success') return <Check size={15}/>;
  if (status === 'running') return <LoaderCircle size={16} className="spin"/>;
  return <Circle size={14}/>;
}

export function Timeline({ task, latestRun }) {
  const [expanded, setExpanded] = useState(false);
  const [compact, setCompact] = useState(false);
  const outputRef = useRef(null);
  const followOutputRef = useRef(true);
  const events = latestRun?.events || [];
  const toolEvents = events.filter(event => event.type === 'tool_result');
  const fallback = [
    { tool: 'get_project_map', target: 'Полная карта проекта', ok: true },
    { tool: 'read_file', target: 'Ожидание задачи', ok: null },
  ];
  const rows = toolEvents.length ? toolEvents : fallback;
  const output = task?.lines?.map(line => line.text).join('\n') || '';
  const lineCount = task?.lines?.length || 0;
  const running = ['running', 'cancelling'].includes(task?.status);
  useEffect(() => { followOutputRef.current = true; }, [task?.id]);
  useEffect(() => {
    if (!outputRef.current) return;
    if (followOutputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [output]);
  return <section className={`timeline-section${compact ? ' compact' : ''}`}>
    <div className="section-title"><div><h1>Текущая задача</h1><p>{task?.prompt || latestRun?.task || 'Опишите задачу для агента'}</p></div><div className="section-controls"><button type="button" className="collapse-toggle" aria-label={compact ? 'Развернуть задачу' : 'Свернуть задачу'} onClick={() => setCompact(value => !value)}>{compact ? 'Развернуть' : 'Свернуть'}</button><TerminalSquare size={18}/></div></div>
    {compact ? <div className="compact-summary"><span><strong>{rows.length}</strong> шагов</span><span><strong>{output ? lineCount : 0}</strong> строк</span>{running ? <span className="status-running">{task?.status === 'cancelling' ? 'останавливается' : 'выполняется'}</span> : null}</div> : null}
    <div className="timeline">
      {rows.map((event, index) => {
        const running = ['running', 'cancelling'].includes(task?.status) && index === rows.length - 1;
        const status = running ? 'running' : event.ok === true ? 'success' : 'pending';
        return <div className={`timeline-row ${status}`} key={`${event.tool}-${index}`}>
          <span className="timeline-icon">{statusIcon(status)}</span>
          <div><strong>{event.tool}</strong><small>{event.target || 'Инструмент агента'}</small></div>
          <span className="row-status">{status === 'success' ? 'Успешно' : status === 'running' ? 'Выполняется' : 'Ожидание'}</span>
        </div>;
      })}
    </div>
    {output ? <div className={`task-output-panel${expanded ? ' expanded' : ''}`}>
      <header><span><TerminalSquare size={13}/> Ответ DeepSeek <small>{task.lines.length} строк</small></span><button type="button" aria-label={expanded ? 'Свернуть ответ' : 'Развернуть ответ'} title={expanded ? 'Свернуть' : 'На весь экран'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2/> : <Maximize2/>}</button></header>
      <pre className="task-output" ref={outputRef} onScroll={event => { const node = event.currentTarget; followOutputRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 16; }}>{output}</pre>
      {!expanded ? <span className="resize-hint">Потяните нижний край, чтобы изменить высоту</span> : null}
    </div> : null}
  </section>;
}
