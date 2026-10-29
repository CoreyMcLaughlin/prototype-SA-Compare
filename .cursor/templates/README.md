# Development Process

This directory contains the step-by-step process for developing features using Cursor AI. The files are numbered in the order they should be followed:

| File | Process |
|------|---------|
| `1. create-prd.md` | Generate a PRD from user requirements |
| `2. generate-tasks.md` | Create a task list from a PRD |
| `3. process-task-list.md` | Implement tasks and manage progress |
| `4. code-review.md` | Review code for quality and best practices |
| `5. create-handoff.md` | Write a product handoff doc from the built prototype, with the PRD and task list as light backup |

## How to Use

1. **Drag and drop** the relevant process file into the AI chat
2. **Ask for help** with the task at hand
3. **Follow the workflow** sequentially

### Example Prompts

- For PRD creation: *"Help me create a PRD for the following idea: [describe your feature idea]"*
- For task generation: *"Help me generate a task list from this PRD: [reference to PRD file]"*
- For task implementation: *"Help me implement these tasks: [reference to task list file]"*
- For code review: *"Help me review this code following the code review guidelines"*
- For handoff docs: *"Create the handoff documentation"* or *"Update the handoff documentation"*

## Workflow

The **user testing** path follows this sequence:

```
User Request
    ↓
1. Create PRD (1. create-prd.md)
    ↓
2. Generate Task List (2. generate-tasks.md)
    ↓
3. Implement Tasks (3. process-task-list.md)
    ↓
4. Code Review (4. code-review.md)
    ↓
Complete Feature
```

The **concept** path skips the PRD and task list files. See `.cursor/rules/prototype-workflow.mdc`.

## File Locations

- **PRDs**: `.cursor/documents/prds/`
- **Task Lists**: `.cursor/documents/tasks/`
- **Handoffs**: `.cursor/documents/handoffs/`
- **Lessons Learned**: `.cursor/documents/lessons-learned/`

## Related Documentation

- **Rules and conventions**: `.cursor/rules/` — see `stack.mdc`, `design-system.mdc`, `prototype-scope.mdc`
