"""Fill a builder-template brief for one trial. Only five labeled lines change; every other line stays."""
import re

FENCE_OPEN = '```text'
FENCE_CLOSE = '```'
EXECUTE = 'Execute <slice goal>'
LABELS = (EXECUTE, 'Owned files: ', 'Acceptance:', 'Gates:', 'Result file:')


class TemplateError(ValueError):
    pass


def fence_lines(template):
    """The lines inside the single ```text fence; raise TemplateError unless there is exactly one."""
    lines = template.split('\n')
    opens = [i for i, line in enumerate(lines) if line == FENCE_OPEN]
    if len(opens) != 1:
        raise TemplateError(f'template needs exactly one {FENCE_OPEN} fence, found {len(opens)}')
    for end in range(opens[0] + 1, len(lines)):
        if lines[end] == FENCE_CLOSE:
            return lines[opens[0] + 1:end]
    raise TemplateError('the text fence never closes')


def label_index(lines):
    """Map each label to its line index; every label must start exactly one line."""
    found = {}
    for label in LABELS:
        hits = [i for i, line in enumerate(lines) if line.startswith(label)]
        if len(hits) != 1:
            raise TemplateError(f'label {label.strip()!r} starts {len(hits)} lines, expected 1')
        found[label] = hits[0]
    return found


def validate(template):
    lines = fence_lines(template)
    index = label_index(lines)
    for label, needle in ((EXECUTE, '<absolute worktree>'), (EXECUTE, '<branch>'), ('Owned files: ', '<paths>'),
                          ('Result file:', '<path>')):
        if needle not in lines[index[label]]:
            raise TemplateError(f'the {label.strip()!r} line lacks {needle}')


def render(template, goal, worktree, branch, owned_files, criteria, gates_text, result_path):
    validate(template)
    lines = fence_lines(template)
    index = label_index(lines)
    out = list(lines)
    out[index[EXECUTE]] = (lines[index[EXECUTE]].replace('<slice goal>', goal, 1)
                           .replace('<absolute worktree>', worktree, 1).replace('<branch>', branch, 1))
    out[index['Owned files: ']] = lines[index['Owned files: ']].replace('<paths>', owned_files, 1)
    out[index['Result file:']] = lines[index['Result file:']].replace('<path>', result_path, 1)
    # Multi-line values replace the whole label line: the label, then the text verbatim.
    out[index['Acceptance:']] = 'Acceptance:\n' + criteria
    out[index['Gates:']] = 'Gates:\n' + gates_text
    return '\n'.join(out) + '\n'
