const TOOL_KINDS = new Set(['read', 'write', 'command']);

function validateValue(value, schema, location = 'arguments') {
  if (!schema) return;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${location} должен быть объектом`);
    for (const required of schema.required || []) {
      if (value[required] === undefined) throw new Error(`${location}.${required} обязателен`);
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find(key => !Object.hasOwn(schema.properties || {}, key));
      if (unknown) throw new Error(`${location}.${unknown} не поддерживается`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) validateValue(value[key], child, `${location}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${location} должен быть массивом`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${location} превышает лимит ${schema.maxItems}`);
    value.forEach((item, index) => validateValue(item, schema.items, `${location}[${index}]`));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${location} должен быть строкой`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${location} слишком короткий`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new Error(`${location} превышает ${schema.maxLength} символов`);
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(`${location} должен быть целым числом`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${location} должен быть не меньше ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${location} должен быть не больше ${schema.maximum}`);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${location} должен быть boolean`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${location} содержит неподдерживаемое значение`);
}

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

  validate(name, args) {
    const tool = this.get(name);
    if (!tool) throw new Error(`Неизвестный инструмент: ${name}`);
    validateValue(args, tool.function.parameters);
    return args;
  }

  describe() {
    return [...this.tools.values()].map(tool => ({
      name: tool.function.name,
      kind: tool.kind,
      description: tool.function.description,
    }));
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
      name: 'get_task_plan', description: 'Read the durable task plan, progress counters and tasks ready to start.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'set_task_plan', description: 'Create or replace a bounded dependency-aware task plan.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        goal: { type: 'string', maxLength: 2000 }, expected_revision: { type: 'integer', minimum: 0 },
        tasks: { type: 'array', maxItems: 100, items: { type: 'object' } },
      }, required: ['goal', 'tasks'] },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'update_task', description: 'Move one task through its validated lifecycle after dependencies are complete.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        id: { type: 'string', minLength: 1, maxLength: 40 },
        state: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked', 'failed', 'cancelled'] },
        note: { type: 'string', maxLength: 1000 }, expected_revision: { type: 'integer', minimum: 1 },
      }, required: ['id', 'state'] },
    },
  },
  {
    kind: 'read', type: 'function', function: {
      name: 'get_project_memory', description: 'Read durable project facts, decisions, constraints, preferences and pending work saved across conversations.',
      parameters: { type: 'object', additionalProperties: false, properties: { type: { type: 'string', enum: ['fact', 'decision', 'constraint', 'preference', 'todo'] } } },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'remember_project_memory', description: 'Save or update one durable, non-secret project memory item. Use only for information useful in future tasks.',
      parameters: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, value: { type: 'string' }, type: { type: 'string', enum: ['fact', 'decision', 'constraint', 'preference', 'todo'] }, expected_revision: { type: 'integer', minimum: 0 } }, required: ['key', 'value', 'type'] },
    },
  },
  {
    kind: 'write', type: 'function', function: {
      name: 'forget_project_memory', description: 'Delete one obsolete durable project memory item by key.',
      parameters: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, expected_revision: { type: 'integer', minimum: 0 } }, required: ['key'] },
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

module.exports = { ToolRegistry, CODING_TOOL_DEFINITIONS, createCodingToolRegistry, validateValue };
