# Incident runbook

For the maintainer. relembra has no servers and holds no user data: what an attacker can reach is
the repository, the npm package, the GitHub releases and the Pages site. Each step below is done
from a device you trust, not the one you suspect.

## A leaked or suspect credential

1. Revoke it first, then look.
   - GitHub: revoke the token at <https://github.com/settings/tokens> (personal access tokens) or
     <https://github.com/settings/applications> (the GitHub CLI's OAuth grant), sign out other
     sessions at <https://github.com/settings/sessions>, and remove unknown SSH keys at
     <https://github.com/settings/keys>.
   - npm: `npm token list`, then `npm token revoke <id>` for every token; publishing needs
     two-factor authentication, so also check the account's 2FA is still on (`npm profile get`).
2. Review what happened: the security log at <https://github.com/settings/security-log>, recent
   pushes and tags (`git ls-remote origin`), releases (`gh release list`), and the package
   (`npm view relembra time dist-tags`).
3. Put back what changed.
   - A tag, release or branch that is not yours: compare it with the release evidence in
     `docs/eval/release-<version>.md` (commit, tree and asset hashes). Releases are immutable once
     published, so a bad one is deleted and replaced by a new version, never edited.
   - A bad npm version: move the dist-tag back (`npm dist-tag add relembra@<good> beta`), mark it
     (`npm deprecate relembra@<bad> "<reason>"`), and unpublish it if npm's policy still allows
     (`npm unpublish relembra@<bad>`).
   - The site: publish the last good tree again with `scripts/site/publish.sh` from a checkout of
     the last good commit.
4. If users installed something bad, publish a GitHub security advisory saying which versions,
   what they did, and what to do.

## A lost or stolen laptop

Do every step of the section above for each credential the laptop held (GitHub sessions, SSH
keys, the GitHub CLI's token, npm tokens), then change the account passwords and check the 2FA
recovery settings. A device that can publish keeps its disk encrypted and its screen lock on.
