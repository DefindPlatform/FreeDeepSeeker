import { Database, File, FlaskConical, ShieldCheck } from 'lucide-react';
import { GitPanel } from './GitPanel.jsx';

const COLORS = ['#e7cc4b', '#5f9eea', '#9fbd62', '#87909a', '#a77bd4', '#ef7f32'];

export function Insights({ project, latestRun, api, git, onCommit, onPush, disabled }) {
  const max = Math.max(...project.languages.map(item => item.count), 1);
  return <aside className="insights-panel">
    <h2>Состояние проекта</h2>
    <div className="metrics">
      <Metric icon={<File/>} value={project.fileCount} label="файлов"/>
      <Metric icon={<FlaskConical/>} value={project.testFileCount} label="тестовых"/>
      <Metric icon={<Database/>} value={`${(project.totalBytes / 1024).toFixed(1)} КБ`} label="размер"/>
    </div>
    <section className="language-section"><h3>Языки <span>по файлам</span></h3>{project.languages.slice(0, 8).map((item, index) => <div className="language-row" key={item.name}><span>{item.name}</span><i><b style={{width: `${item.count / max * 100}%`, background: COLORS[index % COLORS.length]}}/></i><strong>{item.count}</strong></div>)}</section>
    <section className="status-section"><h3>API</h3><div className={`health ${api.online ? 'healthy' : 'offline'}`}><span/><strong>{api.online ? 'Подключено' : 'Недоступно'}</strong><small>{api.baseUrl || 'не настроен'}</small></div></section>
    <GitPanel git={git} onCommit={onCommit} onPush={onPush} disabled={disabled}/>
    <section className="audit-section"><h3>Аудит</h3><div className="audit-box"><ShieldCheck size={20}/><div><strong>{latestRun ? statusLabel(latestRun.status) : 'Нет запусков'}</strong><small>{latestRun?.id || 'История появится после задачи'}</small></div></div></section>
  </aside>;
}

function Metric({ icon, value, label }) { return <div>{icon}<strong>{value}</strong><span>{label}</span></div>; }
function statusLabel(status) { return ({ completed: 'Транзакция завершена', running: 'Транзакция активна', failed: 'Запуск завершён с ошибкой', cancelled: 'Запуск отменён', undone: 'Запуск откатан' })[status] || status; }
