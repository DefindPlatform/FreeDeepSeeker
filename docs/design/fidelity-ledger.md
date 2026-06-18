# Agent Studio fidelity ledger

Concept: `agent-studio-concept.png`. Verified implementation: `agent-studio-render.png`.

| Area | Concept target | Implemented result |
| --- | --- | --- |
| Structure | IDE-like top bar, tree, task/diff center, insights rail | Same three-column desktop hierarchy with a compact responsive stack |
| Typography | Sans UI with monospace code and tool names | System sans UI plus Cascadia/Consolas monospace surfaces |
| Palette | True charcoal, thin dividers, restrained status colors | Charcoal panels, 1px borders, green/amber/red reserved for status and diff |
| Project navigation | Dense searchable file tree | Real repository index, live filtering, selection and file preview |
| Agent feedback | Task timeline and split change review | Live tool events, recent output, transaction audit and before/after diff |
| Project data | Language bars and health summary | Real file/language/test/size metrics and proxy health |
| Permissions | Compact top-bar status | Expanded accessible menus with descriptions and explicit task approval |
| Responsive behavior | Desktop-first concept | 1080px two-column mode and 720px stacked mobile layout |

Intentional deviations: concept placeholder data was replaced with live repository state; native selectors were replaced with searchable dark menus; permission descriptions and Undo were expanded for safety and clarity.
