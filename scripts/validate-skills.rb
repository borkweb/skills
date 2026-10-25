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
  'hooks/pre-push.md' => ['Gate Integrity'],
  'skills/core/do/references/briefs.md' => ['SAFE TO LAND, LAND WITH CAUTION, or DO NOT LAND', "don't grade your own work", 'Build the smallest change that fully works', 'never cut validation at trust boundaries', 'Not checked'],
  'skills/core/offload/builder-template.md' => ['Do not grade your own work', 'RED chronology', 'Build the smallest change that fully works', 'never cut validation at trust boundaries', 'Not checked']
}.freeze
INVARIANTS.each do |rel, phrases|
  text = root.join(rel).read
  phrases.each { |phrase| errors << "#{rel}: frozen phrase missing: #{phrase.inspect}" unless text.include?(phrase) }
rescue StandardError => e
  errors << "#{rel}: #{e.message}"
end
if errors.empty?
  puts "PASS: #{paths.length} skills, YAML policies, manifests, #{seen.length} linked Markdown files and #{INVARIANTS.values.flatten.length} frozen phrases"
else
  warn errors.join("\n")
  exit 1
end
