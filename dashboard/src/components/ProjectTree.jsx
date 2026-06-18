import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, Search } from 'lucide-react';

const iconFor = path => path.endsWith('.md') ? <FileText size={15} /> : <FileCode2 size={15} />;

export function ProjectTree({ files, selected, query, onQuery, onSelect }) {
  const filtered = files.filter(file => file.path.toLowerCase().includes(query.toLowerCase()));
  const grouped = new Map();
  filtered.forEach(file => {
    const [head, ...tail] = file.path.split('/');
    const key = tail.length ? head : '(root)';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(file);
  });
  return <aside className="project-panel">
    <div className="panel-heading"><h2>Проект</h2><span className="count">{files.length}</span></div>
    <label className="search"><Search size={15}/><input value={query} onChange={event => onQuery(event.target.value)} placeholder="Найти файл"/><kbd>Ctrl+P</kbd></label>
    <div className="tree" role="tree">
      {[...grouped.entries()].map(([group, entries]) => group === '(root)'
        ? entries.map(file => <FileRow key={file.path} file={file} selected={selected} onSelect={onSelect}/>)
        : <div key={group} className="tree-group"><div className="folder-row"><ChevronDown size={14}/><Folder size={15}/><span>{group}</span></div>{entries.map(file => <FileRow key={file.path} file={file} selected={selected} onSelect={onSelect} nested/>)}</div>)}
      {filtered.length === 0 ? <p className="empty">Файлы не найдены</p> : null}
    </div>
  </aside>;
}

function FileRow({ file, selected, onSelect, nested }) {
  return <button className={`file-row ${selected === file.path ? 'selected' : ''} ${nested ? 'nested' : ''}`} onClick={() => onSelect(file.path)}>
    {selected === file.path ? <ChevronRight size={13}/> : <span className="icon-space"/>}{iconFor(file.path)}<span>{nested ? file.path.split('/').slice(1).join('/') : file.path}</span>
  </button>;
}
