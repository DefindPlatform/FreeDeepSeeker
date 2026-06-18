import { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Box, BrainCircuit, Check, ChevronDown, Cpu, Eye, Globe2, Hand, HardDrive, Search, Shield, ShieldAlert, Sparkles } from 'lucide-react';
import { getFile, getState, startTask, undoRun } from './api.js';
import { ProjectTree } from './components/ProjectTree.jsx';
import { Timeline } from './components/Timeline.jsx';
import { DiffViewer } from './components/DiffViewer.jsx';
import { Insights } from './components/Insights.jsx';
import { Composer } from './components/Composer.jsx';

export function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('agent.js');
  const [content, setContent] = useState('');
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [mode, setMode] = useState('ask');
  const [pendingApproval, setPendingApproval] = useState(false);
  const modeInitialized = useRef(false);

  const refresh = useCallback(async () => {
    try { setState(await getState()); setError(''); } catch (cause) { setError(cause.message); }
  }, []);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 1500); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    if (!state || modeInitialized.current) return;
    setMode(state.config?.permissionMode || 'ask');
    modeInitialized.current = true;
  }, [state]);
  useEffect(() => {
    if (!state?.project?.files?.length) return;
    if (!selected || !state.project.files.some(file => file.path === selected)) setSelected(state.project.files[0].path);
  }, [state, selected]);
  useEffect(() => {
    if (!selected) { setContent(''); return undefined; }
    let active = true;
    getFile(selected).then(file => { if (active) setContent(file.content); }).catch(cause => { if (active) setContent(`// ${cause.message}`); });
    return () => { active = false; };
  }, [selected]);
  useEffect(() => {
    const handler = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); document.querySelector('.composer button')?.click(); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);

  const latestRun = state?.runs?.[0] || null;
  const undoableRun = state?.runs?.find(run => ['completed', 'failed'].includes(run.status) && run.entries?.length) || null;
  const diffRun = state?.runs?.find(run => run.diffs?.length) || null;
  const models = state?.api?.models || [];
  const running = state?.task?.status === 'running';
  const executeTask = async approved => {
    try { await startTask({ prompt, model, mode, approved }); setPrompt(''); setPendingApproval(false); await refresh(); }
    catch (cause) { setError(cause.message); }
  };
  const submit = () => { if (mode === 'ask') setPendingApproval(true); else executeTask(mode === 'full'); };
  const undo = async () => { try { await undoRun(); await refresh(); } catch (cause) { setError(cause.message); } };

  if (!state) return <div className="loading"><Bot/> <span>{error || 'Загрузка Agent Studio…'}</span></div>;
  const activeDiff = diffRun?.diffs?.[0] || null;
  return <div className="app-shell">
    <header className="topbar"><div className="brand"><Bot size={18}/><strong>DeepSeek Agent Studio</strong></div><TopItem icon={<HardDrive/>} label="Рабочая папка" value={state.workspace}/><ModelMenu models={models.length ? models : [{id:'deepseek-chat'}]} value={model} onChange={setModel}/><PermissionMenu value={mode} onChange={setMode}/><TopItem icon={<Box className={state.api.online ? 'online-icon' : 'offline-icon'}/>} label="Подключение" value={state.api.online ? state.api.baseUrl : 'Нет соединения'}/></header>
    {error ? <div className="error-banner">{error}<button onClick={() => setError('')}>×</button></div> : null}
    <div className="workspace"><ProjectTree files={state.project.files} selected={selected} query={query} onQuery={setQuery} onSelect={setSelected}/><main><Timeline task={state.task} latestRun={latestRun}/><DiffViewer file={activeDiff?.path || selected} content={content} diff={activeDiff} onUndo={undo} canUndo={Boolean(undoableRun)}/><Composer value={prompt} onChange={setPrompt} onSubmit={submit} running={running}/></main><Insights project={state.project} latestRun={latestRun} api={state.api}/></div>
    {pendingApproval ? <div className="modal-backdrop" role="presentation"><section className="approval-modal" role="dialog" aria-modal="true" aria-labelledby="approval-title"><ShieldAlert size={24}/><h2 id="approval-title">Разрешить изменения задачи?</h2><p>Agent получит режим full только для этого запуска. Все файловые изменения попадут в транзакцию и смогут быть откатаны.</p><pre>{prompt}</pre><div><button onClick={() => setPendingApproval(false)}>Отмена</button><button className="approve" onClick={() => executeTask(true)}>Подтвердить и запустить</button></div></section></div> : null}
  </div>;
}

function TopItem({ icon, label, value }) { return <div className="top-item">{icon}<span><small>{label}</small><strong title={value}>{value}</strong></span></div>; }

function modelMeta(id) {
  if (id.includes('search')) return { group: 'С поиском', description: 'Ответы с поиском актуальной информации', icon: Globe2 };
  if (id.includes('reasoner') || id.includes('r1')) return { group: 'Рассуждения', description: 'Многошаговый анализ и сложная логика', icon: BrainCircuit };
  if (id.includes('expert') || id.includes('v4')) return { group: 'Специализированные', description: 'Сложные задачи, архитектура и код', icon: Sparkles };
  return { group: 'Универсальные', description: 'Быстрые повседневные задачи и код', icon: Cpu };
}

function ModelMenu({ models, value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef(null);
  useEffect(() => {
    const close = event => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !root.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, []);
  const visible = models.filter(item => item.id.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = ['Универсальные', 'Рассуждения', 'С поиском', 'Специализированные'];
  return <div className="top-item model-picker" ref={root}>
    <Cpu/>
    <button className="model-trigger" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(shown => !shown); setQuery(''); }}>
      <span><small>Модель</small><strong>{value}</strong></span><ChevronDown className={open ? 'rotated' : ''}/>
    </button>
    {open ? <div className="model-menu" role="menu" aria-label="Выбор модели">
      <label className="model-search"><Search/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Найти модель" aria-label="Найти модель"/></label>
      <div className="model-options">{groups.map(group => {
        const items = visible.filter(item => modelMeta(item.id).group === group);
        return items.length ? <section key={group}><h3>{group}</h3>{items.map(item => {
          const meta = modelMeta(item.id); const Icon = meta.icon;
          return <button type="button" role="menuitemradio" aria-checked={item.id === value} key={item.id} onClick={() => { onChange(item.id); setOpen(false); }}><Icon/><span><strong>{item.id}</strong><small>{meta.description}</small></span>{item.id === value ? <Check className="model-check"/> : null}</button>;
        })}</section> : null;
      })}{visible.length ? null : <p className="model-empty">Модели не найдены</p>}</div>
    </div> : null}
  </div>;
}

const PERMISSIONS = [
  { id: 'read-only', label: 'Только чтение', description: 'Изучать проект без изменения файлов и выполнения команд с записью', icon: Eye },
  { id: 'ask', label: 'Запрашивать разрешение', description: 'Всегда просить подтверждение перед запуском задачи с изменениями', icon: Hand },
  { id: 'full', label: 'Полный доступ', description: 'Разрешить изменения и команды внутри выбранной рабочей папки', icon: Shield },
];

function PermissionMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const current = PERMISSIONS.find(item => item.id === value) || PERMISSIONS[1];
  useEffect(() => {
    const close = event => {
      if (event.key === 'Escape' || (event.type === 'pointerdown' && !root.current?.contains(event.target))) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', close); document.removeEventListener('pointerdown', close); };
  }, []);
  return <div className="top-item permission-picker" ref={root}>
    <current.icon/>
    <button className="permission-trigger" type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(shown => !shown)}>
      <span><small>Режим</small><strong>{current.label}</strong></span><ChevronDown className={open ? 'rotated' : ''}/>
    </button>
    {open ? <div className="permission-menu" role="menu" aria-label="Режим разрешений">
      {PERMISSIONS.map(item => <button type="button" role="menuitemradio" aria-checked={item.id === value} key={item.id} onClick={() => { onChange(item.id); setOpen(false); }}>
        <item.icon/><span><strong>{item.label}</strong><small>{item.description}</small></span>{item.id === value ? <Check className="permission-check"/> : null}
      </button>)}
    </div> : null}
  </div>;
}
