#!/usr/bin/env ruby
# Structural validation only; model behavior is evaluated separately in evals/.
require 'yaml'
require 'json'
require 'pathname'

root = Pathname.new(__dir__).parent
errors = []
manifests = %w[.claude-plugin/plugin.json .codex-plugin/plugin.json].map do |path|
  JSON.parse(root.join(path).read)
end
errors << 'manifest skill lists differ' unless manifests[0]['skills'] == manifests[1]['skills']
errors << 'manifest versions differ' unless manifests[0]['version'] == manifests[1]['version']
paths = manifests[0].fetch('skills')
errors << 'duplicate manifest skill paths' unless paths.uniq == paths
names = []
paths.each do |path|
  entry = root.join(path, 'SKILL.md')
  begin
    text = entry.read
    header = text.match(/\A---\r?\n(.*?)\r?\n---(?:\r?\n|\z)/m)
    raise 'missing YAML frontmatter' unless header
    meta = YAML.safe_load(header[1])
    raise 'frontmatter must be a mapping' unless meta.is_a?(Hash)
    name, description = meta.values_at('name', 'description')
    raise 'invalid name' unless name.is_a?(String) && name.match?(/\A[a-z0-9-]{1,64}\z/)
    raise 'missing/oversized description' unless description.is_a?(String) && description.strip.length.between?(1, 1024)
    names << name
    %w[disable-model-invocation user-invocable].each do |key|
      raise "#{key} must be boolean" if meta.key?(key) && ![true, false].include?(meta[key])
    end
    policy_path = entry.dirname.join('agents/openai.yaml')
    if policy_path.exist?
      policy = YAML.safe_load(policy_path.read)
      implicit = policy.fetch('policy', {}).fetch('allow_implicit_invocation', true)
      raise 'allow_implicit_invocation must be boolean' unless [true, false].include?(implicit)
      if meta['disable-model-invocation'] == true && implicit != false
        raise 'manual-only Claude skill needs matching Codex policy'
      end
    elsif meta['disable-model-invocation'] == true
      raise 'missing Codex manual invocation policy'
    end
  rescue StandardError => e
    errors << "#{entry.relative_path_from(root)}: #{e.message}"
  end
end
errors << 'duplicate skill names' unless names.uniq == names

# Size ratchet: a manifest skill's SKILL.md stays within SIZE_BUDGET bytes. A file on the allowlist may stay
# over budget only while it never grows. Once it is within budget its entry must go; when it shrinks, lower it.
SIZE_BUDGET = 20_000
SIZE_ALLOWLIST = {
  'skills/core/offload/SKILL.md' => 21_967,
  'skills/core/pr-review/SKILL.md' => 23_954
}.freeze
notes = []
skill_files = paths.map { |path| root.join(path, 'SKILL.md').relative_path_from(root).to_s }
SIZE_ALLOWLIST.each_key { |rel| errors << "#{rel}: allowlist entry is not a manifest skill" unless skill_files.include?(rel) }
skill_files.each do |rel|
  next unless root.join(rel).file?
  size = root.join(rel).size
  recorded = SIZE_ALLOWLIST[rel]
  if recorded.nil?
    errors << "#{rel}: #{size} bytes exceeds the #{SIZE_BUDGET}-byte budget" if size > SIZE_BUDGET
  elsif size <= SIZE_BUDGET
    errors << "#{rel}: #{size} bytes is within the #{SIZE_BUDGET}-byte budget; remove from allowlist"
  elsif size > recorded
    errors << "#{rel}: grew to #{size} bytes; allowlisted at #{recorded}"
  elsif size < recorded
    notes << "note: #{rel} shrank to #{size} bytes; lower its allowlist entry from #{recorded}"
  end
end

# Check links in entrypoints and transitively linked local references, not examples.
pending = paths.map { |path| root.join(path, 'SKILL.md').cleanpath }
seen = {}
until pending.empty?
  path = pending.shift
  next if seen[path.to_s] || !path.file?
  seen[path.to_s] = true
  text = path.read.gsub(/^```[^\n]*\n.*?^```\s*$/m, '')
  text.scan(/\[[^\]]*\]\(([^)]+)\)/).flatten.each do |link|
    next if link.match?(/\A(?:https?:|mailto:|#)/)
    target = link.split('#', 2)[0]
    next if target.empty? || target.include?('<')
    resolved = path.dirname.join(target).cleanpath
    if !resolved.exist?
      errors << "#{path.relative_path_from(root)}: broken link #{link}"
    elsif resolved.extname == '.md' && resolved.to_s.start_with?(root.to_s + '/')
      pending << resolved
    end
  end
end
# Frozen phrases: tokens that hooks, other skills and humans match on verbatim.
# A reword in one copy must fail here until every copy and its consumers follow.
INVARIANTS = {
  'skills/gstack/review/SKILL.md' => ['Pre-Landing Review: N issues', '**SAFE TO LAND:**', '**LAND WITH CAUTION:**', '**DO NOT LAND:**', 'never infer commit, push, merge or PR permission', 'Gate Integrity'],
  'skills/gstack/review/checklist.md' => ['#### Gate Integrity', '## Sideways sweep', '## Suppressions', 'record which load you assumed'],
  'commands/pre-push.md' => ['Gate Integrity'],
  'skills/core/do/references/briefs.md' => ['SAFE TO LAND, LAND WITH CAUTION, or DO NOT LAND', '](../../offload/builder-template.md)', 'acceptance criteria, spec-review output'],
  'skills/core/offload/builder-template.md' => ['Acceptance:', 'Gates:', 'Result file:', 'Do not grade your own work', 'RED chronology', 'Build the smallest change that fully works', 'never cut validation at trust boundaries', 'Not checked', 'Frozen criteria outrank spec prose', 'Complete the authorized delivery steps before you report', 'Settle a genuinely ambiguous design question with `council`', 'Implement only within the owned files', 'must fail when the behavior it names breaks', 'Add no production export, flag, wrapper or hook that only tests use', 'name the assumption both relied on', 'by its ID exactly as frozen (C5, C5a)', 'it refuses unless Gate results has one line for every frozen criterion ID', 'On an `incomplete:` refusal, add the missing lines and run `ready` again. Do not run `blocked`, use `--steal` or run `status`.', 'Without `$OFFLOAD_HANDOFF` (a Local-tier subagent), write the same Returns to the result file']
}.freeze
INVARIANTS.each do |rel, phrases|
  text = root.join(rel).read
  phrases.each { |phrase| errors << "#{rel}: frozen phrase missing: #{phrase.inspect}" unless text.include?(phrase) }
rescue StandardError => e
  errors << "#{rel}: #{e.message}"
end
# The dispatcher and the replay renderer read the brief by label from the one ```text fence, so the three
# labels must start a line inside it. A substring pin above would stay green if the template mentioned a
# label elsewhere.
begin
  template = 'skills/core/offload/builder-template.md'
  fences = root.join(template).read.scan(/^```text[ \t]*\r?\n(.*?)^```/m).flatten
  if fences.length != 1
    errors << "#{template}: expected exactly one ```text fence, found #{fences.length}"
  else
    ['Acceptance:', 'Gates:', 'Result file:'].each do |label|
      errors << "#{template}: ```text fence has no line starting with #{label.inspect}" unless fences[0].match?(/^#{Regexp.escape(label)}/)
    end
  end
rescue StandardError => e
  errors << "#{template}: #{e.message}"
end

# The README is the inventory people read, so it must name what the repo ships and nothing else.
begin
  readme = root.join('README.md').read
  names.each { |name| errors << "README.md: skill #{name} has no `| **#{name}**` row" unless readme.match?(/^\| \*\*#{Regexp.escape(name)}\*\*/) }
  table = lambda do |text, heading|
    body = text[/^##+ #{Regexp.escape(heading)}\n(.*?)(?=^##+ |\z)/m, 1].to_s
    body.scan(/^\| *(?:\[)?(?:\*\*|`)?\/?([a-z0-9][a-z0-9-]*)(?:\*\*|`)?/).flatten
  end
  { 'commands' => 'Commands', 'agents' => 'Agents' }.each do |dir, heading|
    on_disk = Dir.glob(root.join(dir, '*.md').to_s).map { |f| File.basename(f, '.md') }.sort
    listed = table.call(readme, heading)
    (on_disk - listed).each { |n| errors << "README.md: #{dir}/#{n}.md is not in the #{heading} table" }
    (listed - on_disk).each { |n| errors << "README.md: the #{heading} table lists #{n}, and #{dir}/#{n}.md does not exist" }
    documented = table.call(root.join('docs/skills.md').read, heading)
    (documented - on_disk).each { |n| errors << "docs/skills.md: the #{heading} table lists #{n}, and #{dir}/#{n}.md does not exist" }
  end
  events = JSON.parse(root.join('hooks/hooks.json').read).fetch('hooks').keys
  hooks_text = readme[/^## Hooks\n(.*?)(?=^## |\z)/m, 1].to_s
  events.each { |e| errors << "README.md: the Hooks section does not name the #{e} event" unless hooks_text.include?("`#{e}`") }
rescue StandardError => e
  errors << "inventory check: #{e.message}"
end

# A public repo must not carry one person's home path. Placeholder users are fine.
PLACEHOLDER_USERS = %w[me you someone user name example t].freeze
TEXT_EXT = %w[.md .mjs .js .ts .tsx .py .rb .sh .json .yaml .yml .toml].freeze
SKIP_DIRS = %w[.git .claude .lavish .opencode node_modules __pycache__ graphify-out .codegraph].freeze
Dir.glob('**/*', File::FNM_DOTMATCH, base: root.to_s).each do |rel|
  next if rel.split('/').any? { |part| SKIP_DIRS.include?(part) } || rel.start_with?('docs/superpowers/')
  path = root.join(rel)
  next unless path.file? && !path.symlink? && (TEXT_EXT.include?(path.extname) || %w[AGENTS.md README.md].include?(rel))
  path.read.scrub.each_line.with_index(1) do |line, n|
    line.scan(%r{(?:/Users|/home)/([A-Za-z0-9._-]+)(?=/)}).flatten.each do |user|
      errors << "#{rel}:#{n}: personal path /…/#{user}/ (use ~ or a placeholder such as /Users/me)" unless PLACEHOLDER_USERS.include?(user)
    end
  end
end

if errors.empty?
  puts notes
  puts "PASS: #{paths.length} skills, YAML policies, manifests, #{seen.length} linked Markdown files and #{INVARIANTS.values.flatten.length} frozen phrases"
else
  warn errors.join("\n")
  exit 1
end
