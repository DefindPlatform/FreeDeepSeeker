import { MessageSquarePlus, Play, ShieldAlert } from 'lucide-react';

export function Composer({ value, onChange, onSubmit, onResetContext, running, exchanges = 0 }) {
  return <form className="composer" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <textarea value={value} onChange={event => onChange(event.target.value)} placeholder="Опишите задачу для агента…" rows={3}/>
    <div className="composer-footer"><span><ShieldAlert size={14}/> Контекст проекта: {exchanges} диалогов</span><div className="composer-actions"><button className="reset-context" type="button" onClick={onResetContext} disabled={running || exchanges === 0} title="Очистить историю диалога проекта"><MessageSquarePlus size={15}/> Новый диалог</button><button disabled={running || !value.trim()}><Play size={16}/>{running ? 'Выполняется' : 'Запустить'}<kbd>Ctrl+Enter</kbd></button></div></div>
  </form>;
}
