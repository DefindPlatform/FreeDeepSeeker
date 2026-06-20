const TOOL_KINDS = new Set(['read', 'write', 'command']);

class ToolRegistry {
  constructor(definitions = []) {
    this.tools = new Map();
    definitions.forEach(definition => this.register(definition));
  }

  register(definition) {
    const name = definition?.function?.name;
    if (!name || typeof name !== 'string') throw new Error('Инструменту требуется имя');
    if (this.tools.has(name)) throw new Error(`Инструмент ${name} уже зарегистрирован`);
    if (!TOOL_KINDS.has(definition.kind)) throw new Error(`Инструмент ${name}: неизвестный kind ${definition.kind}`);
    if (definition.type !== 'function' || definition.function?.parameters?.type !== 'object') {
      throw new Error(`Инструмент ${name}: требуется function schema с object parameters`);
    }
    this.tools.set(name, Object.freeze({ ...definition }));
    return this;
  }

  get(name) {
    return this.tools.get(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  kind(name) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Неизвестный инструмент: ${name}`);
    return tool.kind;
  }

  schemas() {
    return [...this.tools.values()].map(({ kind: _kind, ...schema }) => schema);
  }

  names() {
    return [...this.tools.keys()];
  }
}

const CODING_TOOL_DEFINITIONS = [
  {
    kind: 'read', type: 'function', function: {
      name: 'get_project_memory', description: 'Read durable project facts, decisions, constraints, preferences and pending work saved across conversations.',
      parameters: { type: 'object', properties: { type: { type: 'string', enum: ['fact', 'decision', 'constraint', 'preference', 'todo'] } } },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'remember_project_memory', description: 'Save or update one durable, non-secret project memory item. Use only for information useful in future tasks.',
      parameters: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' }, type: { type: 'string', enum: ['fact', 'decision', 'constraint', 'preference', 'todo'] } }, required: ['key', 'value', 'type'] },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'forget_project_memory', description: 'Delete one obsolete durable project memory item by key.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    },
  },
  {
    kind: 'read', type: 'function', function: {
      name: 'get_project_map', description: 'Get the complete indexed project file map with metadata and pagination. Use this before broad architectural work.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Optional path substring filter' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } } },
    },
  },
  {
    kind: 'read', type: 'function', function: {
      name: 'list_files', description: 'List files and directories inside the workspace. Generated/dependency directories are omitted.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory, default .' }, depth: { type: 'integer', minimum: 0, maximum: 6 } } },
    },
  },
  {
    kind: 'read', type: 'function', function: {
      name: 'read_file', description: 'Read a UTF-8 text file with line numbers. Use before editing an existing file.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] },
    },
  },
  {
    kind: 'read', type: 'function', function: {
      name: 'search_files', description: 'Search for a literal text string in workspace text files.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' }, case_sensitive: { type: 'boolean' } }, required: ['query'] },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'write_file', description: 'Create or fully overwrite a UTF-8 text file. Read existing files first.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'replace_in_file', description: 'Safely replace exact text in an existing file. Prefer this over rewriting a whole file.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['path', 'old_text', 'new_text'] },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'delete_path', description: 'Delete a file or directory inside the workspace. Use only when required by the user task.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] },
    },
  },
  {
    kind: 'command', type: 'function', function: {
      name: 'run_command', description: 'Run an approved executable directly (without a shell) in the workspace to inspect, build, lint, or test.',
      parameters: { type: 'object', properties: { program: { type: 'string', description: 'Executable, for example npm, node, python, pytest, git' }, args: { type: 'array', items: { type: 'string' } }, timeout_ms: { type: 'integer', minimum: 1000, maximum: 120000 } }, required: ['program', 'args'] },
    },
  },
];

function createCodingToolRegistry() {
  return new ToolRegistry(CODING_TOOL_DEFINITIONS);
}

module.exports = { ToolRegistry, CODING_TOOL_DEFINITIONS, createCodingToolRegistry };
