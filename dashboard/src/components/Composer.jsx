import { MessageSquarePlus, Play, ShieldAlert, Square } from 'lucide-react';

export function Composer({ value, onChange, onSubmit, onCancel, onResetContext, running, cancelling, historyEnabled, exchanges = 0 }) {
  return <form className="composer" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <textarea value={value} onChange={event => onChange(event.target.value)} placeholder="Опишите задачу для агента…" rows={3}/>
    <div className="composer-footer"><span><ShieldAlert size={14}/> Контекст проекта: {historyEnabled ? `${exchanges} диалогов` : 'отключён'}</span><div className="composer-actions"><button className="reset-context" type="button" onClick={onResetContext} disabled={running || exchanges === 0} title="Очистить историю диалога проекта"><MessageSquarePlus size={15}/> Новый диалог</button>{running ? <button className="cancel-task" type="button" onClick={onCancel} disabled={cancelling}><Square size={14}/> {cancelling ? 'Останавливается…' : 'Остановить'}</button> : <button disabled={!value.trim()}><Play size={16}/>Запустить<kbd>Ctrl+Enter</kbd></button>}</div></div>
  </form>;
}
