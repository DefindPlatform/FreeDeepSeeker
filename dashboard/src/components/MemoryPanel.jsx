import { BrainCircuit, Trash2, X } from 'lucide-react';

const LABELS = { fact: 'Факт', decision: 'Решение', constraint: 'Ограничение', preference: 'Предпочтение', todo: 'TODO' };

export function MemoryPanel({ entries = [], disabled, onForget, onClear }) {
  return <section className="memory-section">
    <div className="memory-heading"><h3>Память <span>{entries.length}/100</span></h3>{entries.length ? <button type="button" disabled={disabled} onClick={onClear} title="Очистить память"><Trash2/>Очистить</button> : null}</div>
    {entries.length ? <div className="memory-list">{entries.map(entry => <article key={entry.key}>
      <div><span data-type={entry.type}>{LABELS[entry.type] || entry.type}</span><strong>{entry.key}</strong></div>
      <p>{entry.value}</p>
      <button type="button" disabled={disabled} onClick={() => onForget(entry.key)} aria-label={`Удалить ${entry.key}`}><X/></button>
    </article>)}</div> : <div className="memory-empty"><BrainCircuit/><span><strong>Память пока пуста</strong><small>Агент сохранит важные решения и незавершённые задачи между диалогами.</small></span></div>}
  </section>;
}
