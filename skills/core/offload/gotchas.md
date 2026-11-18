# Offload gotchas

Failures that past runs hit outside the work itself. Each one names what you see and what to do.

This file is the public seed. After reading it, also read the user's private `~/.borkweb-skills/gotchas/offload.md` when it exists: it adds entries, it does not replace these. Only an approved dreaming **gotcha** row ([dreaming.md](../do/references/dreaming.md)) writes the private file. An entry moves here only by a commit the user asks for, in generic wording and without citations.

## A builder cannot push

**What you see:** the slice is green and the builder reports ready, but its `git push` failed with a publickey or signing error.

**Why:** builder panes launched through herdr may have no SSH agent identity, or a signing agent that refuses requests from that pane. The architect's own session can usually push.

**Do:** when a slice's delivery includes a push, test it once from a builder pane before dispatch (`ssh -T git@<host>`, or `git push --dry-run` to the slice branch). If that fails, keep the push with the architect: freeze the delivery as "committed on the slice branch" and push after acceptance. A push failure is a harness gap, never a reason to send the slice back.

## A builder's helper tools hardcode its worktree path

**What you see:** scripts or reviewer recipes that the builder wrote work in its worktree but fail for the reviewer, in a detached mutation worktree, or after the slice worktree is removed. They may also pass on a dirty tree.

**Do:** when a slice adds tools that other agents will run, add a criterion that they take the checkout path as an argument or resolve it from `git rev-parse --show-toplevel`, and that they refuse to run on a dirty tree when the result depends on committed state. Check it by running the tool from a second worktree.

## A gate needs a secret the builder does not have

**What you see:** a gate that passes for the architect fails in the builder with an authentication error, or a tool reports a missing token.

**Why:** dispatch removes tokens, secrets and API keys from every builder's environment, except the model-provider keys a harness signs in with and the SSH agent, because builders run with their permission gates off.

**Do:** name the variable in the slice spec and pass it with `OFFLOAD_BUILDER_PASS_ENV` on the dispatch ([launch-options.md](launch-options.md), *Builder credentials*). Pass only what a frozen gate needs. A tool that reads its own keychain or config file (`gh`, cloud CLIs) is not affected.
