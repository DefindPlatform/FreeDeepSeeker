import { Play, ShieldAlert } from 'lucide-react';

export function Composer({ value, onChange, onSubmit, running }) {
  return <form className="composer" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <textarea value={value} onChange={event => onChange(event.target.value)} placeholder="Опишите задачу для агента…" rows={3}/>
    <div className="composer-footer"><span><ShieldAlert size={14}/> Запуск из Studio подтверждает изменения задачи</span><button disabled={running || !value.trim()}><Play size={16}/>{running ? 'Выполняется' : 'Запустить'}<kbd>Ctrl+Enter</kbd></button></div>
  </form>;
}
